/**
 * Locating and streaming Codex CLI rollout files.
 *
 * Codex appends one JSON object per line to
 *
 *     <codex-home>/sessions/<YYYY>/<MM>/<DD>/rollout-<utc-stamp>-<uuid>.jsonl
 *
 * The date nesting is the whole reason this module exists: a flat `readdir` of
 * `sessions/` returns three directory entries and zero rollouts. Every finder
 * here is therefore a bounded recursive walk.
 *
 * COMPRESSION. Codex compacts rollouts older than roughly a week to
 * `*.jsonl.zst`. That compaction had not run on the machine this was measured
 * on - all 23 rollouts there were plain `.jsonl` - so neither state may be
 * assumed. We will not add a zstd dependency for it, so a compressed rollout is
 * counted in `RolloutSelection.skippedCompressed` and left unopened. The count
 * exists so the adapter can say "older windows may be incomplete" out loud.
 * Dropping those files silently would be the same class of mistake as inventing
 * a denominator: a number that looks whole when it is not.
 *
 * PRIVACY - the reason this module is as narrow as it is. A rollout holds the
 * user's full prompts, the model's full responses, and absolute paths from
 * their machine. Nothing here inspects a line: `streamLines` hands raw text
 * straight to the caller, logs nothing, buffers no file, and puts no file
 * content in any error it reports. The caller is expected to keep only lines
 * whose `payload.type` is `token_count` and to discard the rest unread.
 *
 * `~/.codex/auth.json` sits two directories above the rollouts and holds an
 * OAuth token. `FORBIDDEN` below refuses it by name, mirroring the guard in
 * `../claude-code/detect-plan.ts`. Reading another tool's stored credential is
 * off limits for this project even though it is local and easy. There is also
 * no reason to want it: the plan tier is already in the rollout files.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import type { ReadStream } from 'node:fs';

/** Environment variable Codex honours to relocate its home directory. */
export const CODEX_HOME_ENV = 'CODEX_HOME';

/** Directory, relative to the Codex home, holding live session rollouts. */
const SESSIONS_DIRNAME = 'sessions';

/**
 * Sibling of `sessions/`, holding rollouts Codex has retired. It is not walked
 * by default: the newest `rate_limits` snapshot is the one that wins, and an
 * archived rollout is by definition not the newest. `includeArchived` is there
 * for the caller who is reconstructing history rather than reading a gauge.
 */
const ARCHIVED_SESSIONS_DIRNAME = 'archived_sessions';

/** The only file extension this module will ever open. */
const ROLLOUT_EXTENSION = '.jsonl';

/** Extension of a rollout we can see but deliberately cannot read. */
const COMPRESSED_EXTENSION = '.jsonl.zst';

/**
 * Never open a path whose basename is this, whatever else changes.
 *
 * `~/.codex/auth.json` is the Codex OAuth token store. It is not a `.jsonl`
 * file and does not live under `sessions/`, so the allowlist below already
 * excludes it twice over - which is exactly why the refusal is written out
 * explicitly rather than left to be inferred from two other rules. Same line,
 * same reasoning as the `.credentials.json` guard in the Claude Code adapter.
 * Do not move it.
 */
const FORBIDDEN = /(^|[\\/])auth\.json$/i;

/**
 * How many rollouts `listRollouts` returns when the caller does not say.
 *
 * Reading a quota needs the newest snapshot, not the archive: the most recent
 * `rate_limits` object supersedes every older one, and a rollout that predates
 * the current 5-hour window contributes nothing. 25 is a generous margin over
 * the handful a single day produces, and it bounds the work when a `sessions/`
 * tree has accumulated years.
 */
export const DEFAULT_ROLLOUT_LIMIT = 25;

/**
 * How far below `sessions/` the walk will descend.
 *
 * The layout is `<YYYY>/<MM>/<DD>/<file>`, which is three levels, so four
 * leaves one spare for a layout change without letting a pathological or
 * symlink-fed tree turn one refresh into an unbounded walk.
 */
const MAX_SESSION_DEPTH = 4;

/**
 * Errors that mean "this path is not readable right now". They are swallowed
 * rather than thrown: a rollout that vanished between the listing and the read,
 * or that we are not allowed to open, is skipped. Anything else (a genuine I/O
 * fault, a decoding bug) is still surfaced to the caller.
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

/**
 * One rollout the walk found: where it is, and the mtime it was ordered by.
 *
 * `mtimeMs` is exported rather than kept private because it is an UPPER BOUND
 * on every timestamp inside the file - an append-only log cannot contain a line
 * stamped after its own last write. A reader walking this list newest-first can
 * therefore stop as soon as the next candidate's mtime is older than the best
 * snapshot it already holds, instead of assuming the first file that answers
 * holds the newest answer. It does not: a session that wrote a prompt after its
 * last `token_count` has a newer mtime than a session that was still doing work.
 */
export interface RolloutEntry {
  readonly file: string;
  /** Last modification time, milliseconds since the epoch. */
  readonly mtimeMs: number;
}

/**
 * What one scan of the rollout tree turned up.
 *
 * `files` are newest first and already capped by `limit`. `entries` is the same
 * list in the same order, each path paired with the mtime it was sorted on -
 * see {@link RolloutEntry} for why a reader needs that and not just the path.
 *
 * `skippedCompressed` counts `*.jsonl.zst` rollouts that were found and left
 * unopened. Non-zero means the view of older windows has holes in it, and the
 * adapter is expected to say so in its note rather than quietly present a
 * partial history as a complete one.
 *
 * `scanned` counts every rollout file the walk saw, compressed ones included.
 * So `scanned - skippedCompressed - files.length` is exactly how many readable
 * rollouts `limit` trimmed, which lets a caller tell "there is nothing here"
 * apart from "there is plenty here and you asked for the newest few".
 */
export interface RolloutSelection {
  files: string[];
  entries: RolloutEntry[];
  skippedCompressed: number;
  scanned: number;
}

export interface ListRolloutsOptions {
  /**
   * Most rollouts to return, newest first. Defaults to
   * `DEFAULT_ROLLOUT_LIMIT`. A negative, fractional, or non-finite value is
   * normalised rather than rejected; 0 is honoured and returns no files, with
   * the counts still filled in.
   */
  limit?: number;
  /**
   * Also walk `archived_sessions/`. Off by default - see the constant above.
   */
  includeArchived?: boolean;
}

/** One rollout the walk found, carrying the mtime it will be ordered by. */
type Candidate = RolloutEntry;

/** Mutable accumulator threaded through the recursive walk. */
interface Scan {
  readable: Candidate[];
  compressed: number;
}

/**
 * Resolve the Codex home directory.
 *
 * `override` wins (pass a value from the user's config file); a blank or
 * whitespace-only override is ignored. When no override is supplied the
 * process environment is consulted for `CODEX_HOME`, and failing that the
 * answer is `<homeDir>/.codex`.
 *
 * An override is resolved to an absolute path, and a leading `~` is expanded
 * against `homeDir`, so a later `process.chdir` cannot change its meaning. The
 * default is returned as a plain join of the caller's `homeDir`, untouched.
 */
export function codexHomeDir(homeDir: string, override?: string): string {
  const raw = override ?? process.env[CODEX_HOME_ENV];
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (candidate.length > 0) {
    return resolve(expandHome(candidate, homeDir));
  }
  return join(homeDir, '.codex');
}

/**
 * List the rollout files beneath `<codexDir>/sessions/`, newest first.
 *
 * Never throws. A missing Codex home, a missing `sessions/` directory, a
 * `sessions` that turns out to be a file, an unreadable day directory, and a
 * rollout that cannot be statted are all skipped, and the worst case is the
 * empty selection. That matters because `detect()` and `read()` on the adapter
 * contract are both forbidden from throwing for a recoverable problem.
 *
 * Ordering is by mtime descending. Rollout filenames embed a UTC timestamp, so
 * two files stamped the same millisecond are broken apart by comparing their
 * paths descending - which puts the later timestamp first and, more
 * importantly, makes repeated calls return the same list.
 */
export async function listRollouts(
  codexDir: string,
  opts?: ListRolloutsOptions,
): Promise<RolloutSelection> {
  const limit = normalizeLimit(opts?.limit);

  const roots = [join(codexDir, SESSIONS_DIRNAME)];
  if (opts?.includeArchived === true) {
    roots.push(join(codexDir, ARCHIVED_SESSIONS_DIRNAME));
  }

  const scan: Scan = { readable: [], compressed: 0 };
  for (const root of roots) {
    await collectRollouts(root, MAX_SESSION_DEPTH, scan);
  }

  scan.readable.sort(byNewestFirst);

  const chosen = scan.readable.slice(0, limit);
  return {
    files: chosen.map((candidate) => candidate.file),
    entries: chosen.map((candidate) => ({ file: candidate.file, mtimeMs: candidate.mtimeMs })),
    skippedCompressed: scan.compressed,
    scanned: scan.readable.length + scan.compressed,
  };
}

/**
 * Depth-first walk of one rollout root, accumulating into `scan`.
 *
 * `depth` is the number of further levels the walk may enter; at 0 the
 * directory's own files are still collected and its subdirectories are not.
 * Files are collected before descending so the pre-sort order is stable.
 *
 * Hidden directories are not entered, and `isDirectory()` is false for a
 * symbolic link, so a link can never walk this out of the sessions tree.
 */
async function collectRollouts(dir: string, depth: number, scan: Scan): Promise<void> {
  const subdirs: string[] = [];

  for (const entry of await safeReadDir(dir)) {
    if (entry.isDirectory()) {
      if (depth > 0 && !entry.name.startsWith('.')) subdirs.push(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;

    const file = join(dir, entry.name);

    // Belt and braces: neither branch below would accept this name anyway.
    if (FORBIDDEN.test(file)) continue;

    if (isCompressedName(entry.name)) {
      scan.compressed += 1;
      continue;
    }
    if (!isRolloutName(entry.name)) continue;

    // The mtime is the sort key, so a file we cannot stat is a file we cannot
    // place. Dropping it is honest; guessing an instant for it is not.
    const info = await safeStat(file);
    if (info === null) continue;
    scan.readable.push({ file, mtimeMs: info.mtimeMs });
  }

  for (const sub of subdirs) {
    await collectRollouts(sub, depth - 1, scan);
  }
}

/** Newest mtime first, ties broken by path descending so the order is stable. */
function byNewestFirst(a: Candidate, b: Candidate): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.file === b.file) return 0;
  return a.file < b.file ? 1 : -1;
}

/**
 * Yield the non-blank lines of a rollout, one at a time.
 *
 * `node:readline` over a read stream, so the file is never resident in memory
 * - which is not an optimisation here but a requirement: a rollout carries
 * every prompt and every response of a session, and reading one into a string
 * would put all of it somewhere it can be logged or inspected by accident. A
 * leading UTF-8 BOM is stripped and blank lines are dropped, so every yielded
 * line is a candidate for `JSON.parse`. Both LF and CRLF terminate a line, and
 * a final line with no terminator is still yielded.
 *
 * Lines are yielded verbatim and are never logged, counted by content, or
 * quoted in an error. The caller must keep only `payload.type === "token_count"`
 * records and let the rest fall on the floor unexamined.
 *
 * If the file is missing, locked, or disappears mid-read the generator simply
 * ends: a partial read of one rollout costs at worst a slightly staler
 * snapshot, because the caller falls through to the next candidate and the
 * newest `rate_limits` object still wins. An error that is not a filesystem
 * error is a bug, not a missing file, and is rethrown.
 *
 * Unlike the Claude Code reader this has no line-length cap, because
 * `node:readline` offers none. A rollout line is one JSON record bounded by the
 * model context window rather than by the file, so the exposure is a large
 * string, not a file-sized one.
 */
export async function* streamLines(file: string): AsyncGenerator<string> {
  // The credential guard again, at the only place that actually opens a
  // handle. A caller that builds a path itself never gets past this line.
  if (FORBIDDEN.test(file)) return;

  let stream: ReadStream;
  try {
    stream = createReadStream(file, { encoding: 'utf8' });
  } catch {
    // Synchronous rejection (e.g. a NUL byte in the path). Nothing to read,
    // and nothing worth saying about a path we never opened.
    return;
  }

  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let atStart = true;

  try {
    for await (const raw of reader) {
      const line = atStart ? stripBom(raw) : raw;
      atStart = false;
      if (isBlank(line)) continue;
      yield line;
    }
  } catch (err) {
    if (!isSkippableFsError(err)) throw err;
  } finally {
    // Both, and in this order: closing the interface stops the line machinery,
    // destroying the stream releases the file handle even when the consumer
    // broke out of the loop after three lines of a 90,000-line rollout.
    reader.close();
    stream.destroy();
  }
}

/** Clamp `limit` to a usable non-negative integer, or fall back to the default. */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ROLLOUT_LIMIT;
  if (limit <= 0) return 0;
  return Math.floor(limit);
}

/**
 * The allowlist that keeps this module away from everything but rollouts: a
 * non-hidden `*.jsonl` file with a non-empty stem.
 *
 * The `rollout-` prefix that Codex actually uses is deliberately NOT required.
 * The date-nested `sessions/` tree is Codex's own and holds nothing else, so
 * the prefix would add no safety, and a rename upstream would silently blank
 * the adapter - the failure mode this project cares most about avoiding.
 */
function isRolloutName(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (name.length <= ROLLOUT_EXTENSION.length) return false;
  return name.toLowerCase().endsWith(ROLLOUT_EXTENSION);
}

/** A rollout Codex has zstd-compacted. Seen, counted, never opened. */
function isCompressedName(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (name.length <= COMPRESSED_EXTENSION.length) return false;
  return name.toLowerCase().endsWith(COMPRESSED_EXTENSION);
}

function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith(`~${sep}`)) return join(homeDir, p.slice(2));
  return p;
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

/** A UTF-8 BOM survives decoding and would break `JSON.parse` on line 1. */
function stripBom(line: string): string {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
}

/** Allocation-free blank check - this runs once per line of a large rollout. */
function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    // space, tab, LF, VT, FF, CR
    if (code !== 32 && (code < 9 || code > 13)) return false;
  }
  return true;
}
