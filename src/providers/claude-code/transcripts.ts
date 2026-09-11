/**
 * Locating and streaming Claude Code session transcripts.
 *
 * Claude Code appends one JSON object per line to
 *
 *     <claude-dir>/projects/<mangled-cwd>/<session-uuid>.jsonl
 *
 * where `<mangled-cwd>` is the absolute working directory with every
 * non-alphanumeric character replaced by `-`. That directory is routinely
 * hundreds of megabytes, so nothing here ever reads a whole file: callers get
 * a line-at-a-time async generator with a hard cap on how long one line may be.
 *
 * SAFETY CONTRACT - this module is read-only and deliberately narrow.
 * It opens exactly one shape of path: a `*.jsonl` file somewhere beneath
 * `projects/<dir>/`. It never touches `.credentials.json`, any `*.key`, or
 * anything else living under the Claude home directory. `isTranscriptName` is
 * the allowlist that enforces that; do not widen it.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { ReadStream } from 'node:fs';

/** Environment variable Claude Code honours to relocate its home directory. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Directory, relative to the Claude home, holding per-project transcripts. */
const PROJECTS_DIRNAME = 'projects';

/** The only file extension this module will ever open. */
const TRANSCRIPT_EXTENSION = '.jsonl';

/**
 * Errors that mean "this path is not readable right now". They are swallowed
 * rather than thrown: a transcript that vanished, or that we are not allowed
 * to read, is skipped. Anything else (a genuine I/O fault, a decoding bug) is
 * still surfaced to the caller.
 */
const SKIPPABLE_FS_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EACCES',
  'EPERM',
  'EBUSY',
  'ELOOP',
]);

/** Minimal structural view of an `fs.Dirent`, so we do not pin its type shape. */
interface DirEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ListTranscriptsOptions {
  /**
   * Skip transcripts last modified strictly before this instant. This is the
   * main performance lever: the projects directory can be hundreds of
   * megabytes, and a daily or weekly window only needs its recent tail.
   * A file whose mtime equals `since` is kept.
   */
  since?: Date;
}

/**
 * Resolve the Claude Code home directory.
 *
 * `override` wins (pass `process.env.CLAUDE_CONFIG_DIR` through, or a value
 * from the user's config file); a blank or whitespace-only override is
 * ignored. When no override is supplied the process environment is consulted,
 * and failing that the answer is `<homeDir>/.claude`.
 *
 * An override is resolved to an absolute path, and a leading `~` is expanded
 * against `homeDir`, so a later `process.chdir` cannot change its meaning.
 * The default is returned as a plain join of the caller's `homeDir`, untouched.
 */
export function claudeHomeDir(homeDir: string, override?: string): string {
  const raw = override ?? process.env[CLAUDE_CONFIG_DIR_ENV];
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (candidate.length > 0) {
    return resolve(expandHome(candidate, homeDir));
  }
  return join(homeDir, '.claude');
}

/**
 * How far below a project directory the scan will walk.
 *
 * Subagent transcripts are nested, not flat. A real path on disk is
 *
 *     projects/<project>/<session-uuid>/subagents/workflows/<wf-id>/agent-<id>.jsonl
 *
 * which is four levels below the project directory, so a scan that only reads
 * the project directory itself misses them. It is not a rounding error: on the
 * machine this was measured on, a flat scan found 83 of 1,868 transcripts, and
 * the 1,785 it skipped held 70,199 assistant usage records - roughly 45% of
 * all input+output tokens ever recorded there. Their request ids are fully
 * disjoint from the top-level ones (0 overlap between 14,217 and 29,315), so
 * this is pure undercount, not de-duplication by accident.
 *
 * The cap exists so a pathological tree cannot turn one refresh into an
 * unbounded walk. Eight is twice the depth anything real has needed.
 */
const MAX_PROJECT_DEPTH = 8;

/**
 * List every session transcript beneath `<claudeDir>/projects/<project>/`.
 *
 * Returns absolute paths, sorted, so repeated calls are deterministic, and an
 * empty array when the Claude home or its `projects` directory is absent.
 * Never throws: an unreadable project directory or an unstattable file is
 * skipped, not fatal.
 *
 * The walk descends up to `MAX_PROJECT_DEPTH` levels inside each project
 * directory, because that is where subagent and workflow transcripts live, and
 * returns only `*.jsonl` files. It starts INSIDE a project directory, so a
 * loose `projects/stray.jsonl` is still not a transcript. Hidden directories
 * are not entered and symbolic links are skipped entirely, so a link can never
 * walk the scan out of `projects/`.
 */
export async function listTranscripts(
  claudeDir: string,
  opts?: ListTranscriptsOptions,
): Promise<string[]> {
  const projectsDir = join(claudeDir, PROJECTS_DIRNAME);
  const cutoff = cutoffMs(opts?.since);

  const files: string[] = [];
  for (const project of await safeReadDir(projectsDir)) {
    // isDirectory() is false for a symlink, which is what we want: we never
    // follow a link out of projects/.
    if (!project.isDirectory()) continue;
    await collectTranscripts(join(projectsDir, project.name), cutoff, MAX_PROJECT_DEPTH, files);
  }

  files.sort();
  return files;
}

/**
 * Depth-first walk of one project subtree, appending transcripts to `out`.
 *
 * Files are collected before descending so the result is grouped sensibly even
 * before the caller sorts. `depth` is the number of further levels the walk may
 * enter; at 0 the directory's own files are still collected and its
 * subdirectories are not entered.
 */
async function collectTranscripts(
  dir: string,
  cutoff: number | null,
  depth: number,
  out: string[],
): Promise<void> {
  const subdirs: string[] = [];

  for (const entry of await safeReadDir(dir)) {
    if (entry.isDirectory()) {
      // A dotted directory is never a Claude Code transcript container, and
      // not entering one keeps this walk away from anything that hides itself.
      if (depth > 0 && !entry.name.startsWith('.')) subdirs.push(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isTranscriptName(entry.name)) continue;

    const file = join(dir, entry.name);
    if (cutoff !== null) {
      const info = await safeStat(file);
      if (info === null) continue;
      if (info.mtimeMs < cutoff) continue;
    }
    out.push(file);
  }

  for (const sub of subdirs) {
    await collectTranscripts(sub, cutoff, depth - 1, out);
  }
}

/**
 * Longest single line this reader will assemble: 16 MiB of characters.
 *
 * The memory contract below is "only the current chunk", and a line-oriented
 * reader can only honour it if a line has a bound. `node:readline` has no
 * `maxLineLength`, so a transcript whose newlines were lost - a torn append,
 * or one record carrying a huge inline attachment - becomes one string as long
 * as the file. Past roughly 512 MB V8 throws `RangeError: Cannot create a
 * string longer than...`, which is not an fs error code, so it would propagate
 * out of here and cost the caller the whole transcript rather than one line.
 *
 * 16 MiB is more than an order of magnitude above the largest real line
 * measured across 201,518 lines on disk (1,359,550 bytes; three lines exceed
 * 1 MB), so nothing that exists today is affected. A line past the cap is
 * dropped and counted in `StreamStatus.oversizedLines` - never silently.
 */
export const MAX_LINE_LENGTH = 16 * 1024 * 1024;

/**
 * How a `streamLines` read ended.
 *
 * This exists because "the generator finished" and "the file was read" are not
 * the same thing, and a quota tool that cannot tell them apart reports a
 * partial count as a complete one. A read that stops at line 40,000 of 90,000
 * because Claude Code has the file locked (`EBUSY`, routine on Windows against
 * a transcript being appended to) yields a valid prefix and then simply ends;
 * without this the caller sums that prefix and prints "N calls across M
 * transcripts" as though it had seen the whole file.
 *
 * `complete` is true only after the reader reached end of file. `reason`
 * carries the error that stopped it, for a debug line. `oversizedLines` counts
 * lines dropped for exceeding `MAX_LINE_LENGTH`; a read can be `complete` and
 * still have dropped some, and that is still an undercount the caller must
 * disclose.
 */
export interface StreamStatus {
  complete: boolean;
  reason: string | null;
  oversizedLines: number;
}

/** A fresh, "nothing read yet" status to hand to `streamLines`. */
export function newStreamStatus(): StreamStatus {
  return { complete: false, reason: null, oversizedLines: 0 };
}

/**
 * Yield the non-blank lines of a transcript, one at a time.
 *
 * Chunks are split by hand rather than by `node:readline` so the line length
 * cap above can actually be enforced; the whole file is never resident in
 * memory, and neither is any single line beyond `MAX_LINE_LENGTH`. Blank lines
 * are dropped and a leading UTF-8 BOM is stripped, so every yielded line is a
 * candidate for `JSON.parse`. Both LF and CRLF terminate a line, and a final
 * line with no terminator is still yielded.
 *
 * If the file is missing, unreadable, or disappears mid-read the generator
 * ends rather than throwing - but it records why in `status`, which the caller
 * should pass in and check afterwards. Breaking out of the loop early closes
 * the underlying handle and leaves `status.complete` false, which is honest:
 * the file was not read to the end.
 */
export async function* streamLines(file: string, status?: StreamStatus): AsyncGenerator<string> {
  const state = status ?? newStreamStatus();
  state.complete = false;
  state.reason = null;
  state.oversizedLines = 0;

  let stream: ReadStream;
  try {
    stream = createReadStream(file, { encoding: 'utf8' });
  } catch (err) {
    // Synchronous rejection (e.g. a NUL byte in the path). Nothing to read.
    state.reason = describeError(err);
    return;
  }

  /** Characters of the line currently being assembled. */
  let pending = '';
  /** True once the current line passed the cap: discard it up to its newline. */
  let discarding = false;
  let atStart = true;

  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      let from = 0;
      for (;;) {
        const newline = chunk.indexOf('\n', from);
        if (newline === -1) {
          if (!discarding) {
            pending += chunk.slice(from);
            if (pending.length > MAX_LINE_LENGTH) {
              discarding = true;
              pending = '';
            }
          }
          break;
        }

        if (discarding) {
          discarding = false;
          state.oversizedLines += 1;
        } else {
          const raw = pending + chunk.slice(from, newline);
          const isFirstLine = atStart;
          atStart = false;
          // A line can also cross the cap inside a single chunk, without ever
          // reaching the check below. Same rule, same accounting.
          if (raw.length > MAX_LINE_LENGTH) {
            state.oversizedLines += 1;
          } else {
            const line = finishLine(raw, isFirstLine);
            if (!isBlank(line)) yield line;
          }
        }
        pending = '';
        from = newline + 1;
      }
    }

    // Whatever sits after the last newline. A file that ends without one still
    // has a final record there, and dropping it would lose a real API call.
    if (discarding) {
      state.oversizedLines += 1;
    } else if (pending.length > MAX_LINE_LENGTH) {
      state.oversizedLines += 1;
    } else if (pending.length > 0) {
      const line = finishLine(pending, atStart);
      if (!isBlank(line)) yield line;
    }

    state.complete = true;
  } catch (err) {
    state.reason = describeError(err);
    if (!isSkippableFsError(err)) throw err;
  } finally {
    stream.destroy();
  }
}

/** Strip the CR of a CRLF pair, and a UTF-8 BOM on the very first line. */
function finishLine(line: string, atStart: boolean): string {
  let out = line;
  if (out.charCodeAt(out.length - 1) === 13) out = out.slice(0, -1);
  if (atStart && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Best-effort inverse of the project-directory mangling.
 *
 * LOSSY, unavoidably so. Claude Code replaces *every* non-alphanumeric
 * character of the absolute cwd with `-`, so the encoding is not injective: a
 * path separator, a space, a dot, an underscore and a literal hyphen all
 * arrive here as the same `-`. This restores the dominant case - path
 * separators - and therefore returns something usable as a label that must
 * never be treated as a real path or handed to `fs`.
 *
 *   "l--Open-Source-quota-monitor" -> "l:\\Open\\Source\\quota\\monitor"
 *                                     (truth: "l:\\Open Source\\quota-monitor")
 *   "-home-ada-src-widget"         -> "/home/ada/src/widget"
 *
 * A leading `<letter>--` is read as a Windows drive, a leading `-` as a POSIX
 * absolute path. Runs of dashes collapse to one separator, because an empty
 * path segment is never meaningful.
 */
export function decodeProjectDir(name: string): string {
  if (name.length === 0) return '';

  const drive = /^([A-Za-z])--(.*)$/.exec(name);
  if (drive) {
    const letter = drive[1] ?? '';
    const rest = drive[2] ?? '';
    return `${letter}:\\${segments(rest).join('\\')}`;
  }

  if (name.startsWith('-')) {
    return `/${segments(name).join('/')}`;
  }

  return segments(name).join('/');
}

/** Split on runs of `-`, dropping the empty segments those runs produce. */
function segments(value: string): string[] {
  return value.split('-').filter((part) => part.length > 0);
}

function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith(`~${sep}`)) return join(homeDir, p.slice(2));
  return p;
}

/**
 * The allowlist that keeps this module away from other tools' secrets: a
 * transcript is a non-hidden `*.jsonl` file with a non-empty stem. Nothing
 * else is ever opened.
 */
function isTranscriptName(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (name.length <= TRANSCRIPT_EXTENSION.length) return false;
  return name.toLowerCase().endsWith(TRANSCRIPT_EXTENSION);
}

/**
 * `null` means "no filter". An invalid Date is treated as no filter rather
 * than as a cutoff that would silently hide every transcript.
 */
function cutoffMs(since: Date | undefined): number | null {
  if (since === undefined) return null;
  const ms = since.getTime();
  return Number.isFinite(ms) ? ms : null;
}

async function safeReadDir(dir: string): Promise<DirEntry[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(file: string): Promise<{ mtimeMs: number } | null> {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

function isSkippableFsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code: unknown = (err as { code?: unknown }).code;
  return typeof code === 'string' && SKIPPABLE_FS_ERROR_CODES.has(code);
}

/** Allocation-free blank check - this runs once per line of a 100 MB file. */
function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    // space, tab, LF, VT, FF, CR
    if (code !== 32 && (code < 9 || code > 13)) return false;
  }
  return true;
}
