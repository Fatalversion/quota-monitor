/**
 * The Codex quota adapter.
 *
 * WHY THIS ONE IS DIFFERENT: IT IS OUR FIRST `reported` SOURCE
 * ------------------------------------------------------------
 * The Claude Code adapter has to invent a denominator, so every reading it
 * emits is `derived` and wears a '~'. Codex does not need that: OpenAI writes
 * its own verdict into every rollout, as `rate_limits.primary.used_percent`
 * and `rate_limits.secondary.used_percent`. So the readings here are
 *
 *     unit 'percent', used = used_percent, limit = 100, confidence 'reported'
 *
 * and nothing in this file computes a percentage. There is deliberately no
 * code path that reads `payload.info` - the local token counts - because
 * OpenAI publishes no cap for them, and any denominator we invented would
 * repeat exactly the mistake that recently forced us to null out every Claude
 * Code cap. A reported number or none at all; never a plausible guess.
 *
 * WHAT `read` ACTUALLY DOES
 * -------------------------
 * Rollouts are listed newest first by FILE MTIME and opened one at a time. The
 * newest snapshot supersedes every older one, so the scan keeps the best
 * snapshot by TIMESTAMP and stops as soon as the next file's mtime proves it
 * cannot hold anything newer - see `findSnapshot`. The two orderings are not
 * the same, and taking the first file that answers is how you end up printing a
 * percentage that is not the newest one on disk.
 *
 * STALENESS IS PART OF THE READING, NOT A FOOTNOTE
 * ------------------------------------------------
 * Codex writes a `token_count` event only while it is running. Between
 * sessions the newest snapshot ages, and a percentage from an hour ago that
 * renders like a live gauge is its own kind of lie. Every note therefore
 * states the age of the snapshot and says that it will not move until Codex
 * runs again - and, when the window it describes has since rolled over, says
 * that too, because a stale 85% otherwise reads as 85% of the window the user
 * is in right now.
 *
 * PRIVACY
 * -------
 * A rollout is a full transcript: the user's prompts, the model's replies and
 * absolute paths from their machine. This adapter never buffers a file, never
 * logs a line, and puts no line content into a note, an error or a debug
 * string - a bad record is reported by line NUMBER and nothing else.
 * `~/.codex/auth.json` holds OAuth tokens and is never opened; the plan tier
 * is already in the rollouts (see `planLabel`). See the headers of
 * `./rollouts.ts` and `./parse.ts`, which enforce the same rule one layer down.
 *
 * COMPRESSION
 * -----------
 * Codex compacts rollouts older than about a week to `*.jsonl.zst`. We add no
 * zstd dependency, so those files are counted and left unopened, and the count
 * goes into the note. A gap the user can see is a gap; a gap they cannot is a
 * wrong number.
 */

import { parseRateLimitLine, planLabel } from './parse.js';
import { DEFAULT_ROLLOUT_LIMIT, codexHomeDir, listRollouts, streamLines } from './rollouts.js';

import type { AdapterContext, QuotaAdapter, QuotaReading, QuotaWindow } from '../../core/types.js';
import type { RateSnapshot, RateWindow } from './parse.js';
import type { RolloutEntry, RolloutSelection } from './rollouts.js';

/** Adapter id. Matches the directory name and the config key. */
export const PROVIDER_ID = 'codex';

export const DISPLAY_NAME = 'Codex';

/**
 * The denominator of every reading this adapter emits.
 *
 * It is not a cap we looked up or guessed at - it is the 100 of "percent".
 * `used` is already OpenAI's percentage, so pairing it with 100 keeps
 * `percentUsed()` honest without inventing a token ceiling.
 */
export const PERCENT_LIMIT = 100;

/**
 * Rollouts opened in one read, before `maxFiles` says otherwise.
 *
 * The scan stops as soon as no unopened file can hold a newer snapshot, so on a
 * normal machine exactly one file is opened and this bound never bites. It
 * exists for the degenerate case - a run of rollouts that never recorded a rate
 * limit - where it keeps one refresh from walking years of history.
 */
export const MAX_ROLLOUT_FILES = DEFAULT_ROLLOUT_LIMIT;

/** Upper bound a user may raise `maxFiles` to. Keeps one refresh bounded. */
const MAX_ROLLOUT_FILES_CEILING = 5_000;

/** Minutes in the units the note prints them in. */
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * A credit balance we are willing to repeat in a note.
 *
 * `credits.balance` is a string upstream ("0"). Anything that is not plainly a
 * number is summarised rather than echoed: a note is user-facing text and this
 * field comes out of a file we treat as untrusted throughout.
 */
const PLAIN_BALANCE = /^\d[\d,.]{0,15}$/;

/**
 * Config keys this adapter understands, under `providers.codex` in
 * `~/.config/quota-monitor/config.yaml`. Every one is optional, and anything
 * unusable falls back to the documented default with a `debug()` line rather
 * than an error.
 *
 * ```yaml
 * providers:
 *   codex:
 *     dir: ~/.codex          # also honours $CODEX_HOME
 *     maxFiles: 25
 *     includeArchived: false
 * ```
 *
 * NAMING CONSTRAINT, same as the Claude Code adapter and just as load-bearing:
 * `src/core/config.ts` drops any option whose key matches
 * /token|key|secret|password/i before an adapter ever sees it. That is the
 * right default and it is not being relaxed, so no option here may be named
 * `...Token` or `...Key`. The "every documented option survives parseConfig"
 * test in `index.test.ts` guards the set against that regression.
 */
export interface CodexOptions {
  /** Override the Codex home directory. Also honours $CODEX_HOME. */
  dir?: string;
  /** Rollouts opened in one read, newest first. Default 25. */
  maxFiles?: number;
  /**
   * Also scan `archived_sessions/`. Default false: the newest snapshot wins
   * and an archived rollout is by definition not the newest.
   */
  includeArchived?: boolean;
}

interface ResolvedOptions {
  codexDir: string;
  maxFiles: number;
  includeArchived: boolean;
}

/** The snapshot the scan settled on, plus how much work it took to find it. */
interface Found {
  snapshot: RateSnapshot;
  /** Rollouts opened in total, the one that answered included. 1 is normal. */
  filesRead: number;
}

/* -------------------------------------------------------------------------- */
/* option reading - tolerant, never throws                                    */
/* -------------------------------------------------------------------------- */

function optString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optBoolean(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** A finite number, written as a number or as a numeric string. */
function optNumber(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** The Codex home directory, resolved identically for `detect` and `read`. */
function resolveCodexDir(ctx: AdapterContext): string {
  const override = optString(ctx.options, 'dir') ?? optString(ctx.options, 'codexDir');
  return codexHomeDir(ctx.homeDir, override);
}

function resolveOptions(ctx: AdapterContext): ResolvedOptions {
  let maxFiles = MAX_ROLLOUT_FILES;
  const rawMaxFiles = optNumber(ctx.options, 'maxFiles');
  if (rawMaxFiles !== undefined) {
    if (rawMaxFiles >= 1) maxFiles = Math.min(Math.floor(rawMaxFiles), MAX_ROLLOUT_FILES_CEILING);
    else ctx.debug(`${PROVIDER_ID}: ignoring maxFiles ${rawMaxFiles}, expected at least 1`);
  }

  return {
    codexDir: resolveCodexDir(ctx),
    maxFiles,
    includeArchived: optBoolean(ctx.options, 'includeArchived') ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* formatting for notes (local, so providers never import the CLI layer)      */
/* -------------------------------------------------------------------------- */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function plural(n: number, one: string, many: string = one + 's'): string {
  return n === 1 ? one : many;
}

/**
 * A percentage as a human reads it: '0%', '54.3%', '100%'.
 *
 * One decimal at most, and no trailing '.0', because the precision OpenAI
 * sends (0.0) is not precision we should imply we can act on.
 */
function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '0%';
  const rounded = Math.round(n * 10) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
}

/**
 * How long ago the snapshot was taken: 'less than a minute', '45m', '2h 14m',
 * '3d 06h'.
 *
 * A negative age - the snapshot is stamped in the future, which a clock change
 * or a timezone-confused writer can produce - reads as 'less than a minute'
 * rather than as a nonsense negative duration. Being vague about a weird clock
 * is fine; printing '-3h old' is not.
 */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < MS_PER_MINUTE) return 'less than a minute';

  const minutes = Math.floor(ms / MS_PER_MINUTE);
  if (ms < MS_PER_HOUR) return `${minutes}m`;

  const hours = Math.floor(ms / MS_PER_HOUR);
  if (ms < MS_PER_DAY) return `${hours}h ${pad2(minutes % 60)}m`;

  const days = Math.floor(ms / MS_PER_DAY);
  return `${days}d ${pad2(hours % 24)}h`;
}

/** 300 -> '5h', 10080 -> '7d', 90 -> '90m'. The window length, as stated. */
function formatWindowLength(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'an unknown length';
  if (Number.isInteger(minutes)) {
    if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
    if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
  }
  return `${Math.round(minutes)}m`;
}

/* -------------------------------------------------------------------------- */
/* finding the newest snapshot                                                */
/* -------------------------------------------------------------------------- */

/**
 * The newest usable `rate_limits` snapshot in one rollout, or null.
 *
 * The file is streamed and the best snapshot kept by timestamp rather than by
 * position. Codex appends in order, so the last one normally wins anyway, but
 * ordering the numbers we print by an instant we actually read beats trusting
 * an append order nobody has promised us.
 *
 * A record whose `rate_limits` carries no usable window is counted, not
 * returned: it has no percentage in it, so treating it as the answer would
 * turn a readable older snapshot into no reading at all. Its LINE NUMBER goes
 * to `debug` - never the line, never a fragment of it.
 *
 * Never throws. A rollout that vanishes or locks mid-read costs at worst a
 * slightly older snapshot, because the caller falls through to the next file.
 */
async function newestSnapshotIn(file: string, ctx: AdapterContext): Promise<RateSnapshot | null> {
  let best: RateSnapshot | null = null;
  let lineNumber = 0;
  let windowless = 0;
  let firstWindowlessLine = 0;

  try {
    for await (const line of streamLines(file)) {
      lineNumber += 1;

      // Every line that is not a `token_count` event returns null here and is
      // never looked at again. That is the whole privacy contract: prompts and
      // responses pass through this loop unread.
      const snapshot = parseRateLimitLine(line);
      if (snapshot === null) continue;

      if (snapshot.session === null && snapshot.weekly === null) {
        windowless += 1;
        if (firstWindowlessLine === 0) firstWindowlessLine = lineNumber;
        continue;
      }

      if (best === null || snapshot.at.getTime() > best.at.getTime()) best = snapshot;
    }
  } catch (error) {
    // One unreadable rollout must never cost us the whole reading.
    ctx.debug(`${PROVIDER_ID}: stopped reading ${file} (${messageOf(error)})`);
  }

  if (windowless > 0) {
    ctx.debug(
      `${PROVIDER_ID}: ${windowless} rate_limits ${plural(windowless, 'record')} in ${file} ` +
        `carried no usable window (first at line ${firstWindowlessLine})`,
    );
  }

  return best;
}

/**
 * Walk the rollouts newest first and return the NEWEST snapshot in them.
 *
 * The subtlety, and the reason this is not simply "return the first file that
 * answers": `listRollouts` orders by FILE MTIME, and a file's mtime is not the
 * instant of its newest `token_count`. A session that recorded a prompt after
 * its last model turn has a newer mtime than a session that was still burning
 * quota, so the mtime-newest file can hold the older snapshot. Stopping there
 * would print a percentage that is not the newest one on disk - with two Codex
 * windows open, the exact failure this tool exists to avoid.
 *
 * The termination rule is exact rather than a heuristic. An append-only log
 * cannot hold a line stamped after its own last write, so `entry.mtimeMs` is an
 * upper bound on every timestamp inside that file; and the list is
 * mtime-descending. So once the next candidate's mtime is no later than the
 * best snapshot we already hold, neither it nor anything after it can beat that
 * snapshot, and the walk stops. On a normal machine the second candidate is
 * already older than the first one's snapshot, so exactly one file is opened -
 * the same work the old rule did, minus the wrong answer.
 */
async function findSnapshot(
  entries: readonly RolloutEntry[],
  ctx: AdapterContext,
): Promise<Found | null> {
  let best: RateSnapshot | null = null;
  let filesRead = 0;

  for (const entry of entries) {
    if (best !== null && entry.mtimeMs <= best.at.getTime()) break;

    filesRead += 1;
    const snapshot = await newestSnapshotIn(entry.file, ctx);
    if (snapshot === null) continue;
    if (best === null || snapshot.at.getTime() > best.at.getTime()) best = snapshot;
  }

  return best === null ? null : { snapshot: best, filesRead };
}

/* -------------------------------------------------------------------------- */
/* building readings                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The start of the window, back-computed from the reset time and the window
 * length. OpenAI sends no start, and these are rolling windows, so
 * `resets_at - window_minutes` is the only start there is.
 *
 * Returns null rather than an Invalid Date if the arithmetic leaves the range
 * a Date can hold.
 */
function windowStartOf(window: RateWindow): string | null {
  const startMs = window.resetsAt.getTime() - window.windowMinutes * MS_PER_MINUTE;
  if (!Number.isFinite(startMs)) return null;
  const start = new Date(startMs);
  return Number.isNaN(start.getTime()) ? null : start.toISOString();
}

/**
 * Explain the reading.
 *
 * Two things have to be in here every time. First, that the percentage is
 * OpenAI's own - this is the one adapter where that is true, and the whole
 * point of `confidence: 'reported'` is lost if the user cannot tell why.
 * Second, how old the figure is: it moves only when Codex next runs, and a
 * gauge that looks live while showing an hour-old number is exactly the sort
 * of confident wrong answer this project exists to avoid.
 */
function buildNote(
  window: RateWindow,
  snapshot: RateSnapshot,
  selection: RolloutSelection,
  found: Found,
  now: Date,
): string {
  const parts: string[] = [];

  parts.push(
    `${formatPercent(window.usedPercent)} of the ${formatWindowLength(window.windowMinutes)} ` +
      `window is OpenAI's own figure (rate_limits.used_percent, written by Codex into its ` +
      `rollout log) - quota-monitor never recomputes it from local token counts`,
  );

  const ageMs = now.getTime() - snapshot.at.getTime();
  parts.push(
    `NOT LIVE: this snapshot is ${formatAge(ageMs)} old (taken ${snapshot.at.toISOString()}) and ` +
      `will not change until you next run Codex`,
  );

  // The window can outlive the snapshot's usefulness entirely. A five-hour
  // window read from a rollout written yesterday has already rolled over, so
  // the percentage describes a window the user is no longer in - and left
  // unsaid, a stale 85% reads as 85% of the window they are in right now. The
  // reset countdown on the first line says the same thing in fewer words; this
  // is the sentence that explains it.
  const sinceReset = now.getTime() - window.resetsAt.getTime();
  if (sinceReset >= MS_PER_MINUTE) {
    parts.push(
      `ALREADY RESET: the ${formatWindowLength(window.windowMinutes)} window this figure ` +
        `describes ended ${formatAge(sinceReset)} ago, so it says nothing about the window you ` +
        `are in now`,
    );
  }

  if (window.clamped === true) {
    parts.push(
      `OpenAI reported a used_percent outside 0-100, shown clamped to ` +
        `${formatPercent(window.usedPercent)}`,
    );
  }

  if (selection.skippedCompressed > 0) {
    const n = selection.skippedCompressed;
    parts.push(
      `${n} older ${plural(n, 'rollout')} ${plural(n, 'is', 'are')} zstd-compressed ` +
        `(.jsonl.zst) and ${plural(n, 'was', 'were')} not opened - quota-monitor adds no zstd ` +
        `dependency - so anything only those files record is missing from this view`,
    );
  }

  const credits = snapshot.credits;
  if (credits !== null) {
    if (credits.unlimited) parts.push('Codex reports credits as unlimited');
    else if (credits.hasCredits) {
      const balance = credits.balance;
      parts.push(
        balance !== null && PLAIN_BALANCE.test(balance)
          ? `Codex reports a credit balance of ${balance}`
          : 'Codex reports a credit balance',
      );
    }
  }

  // `filesRead` counts every rollout OPENED, the one that answered included.
  // The old wording, "2 opened before one carried a snapshot", said that two
  // files came up empty when two were opened in total - and it is no longer
  // even the right shape, because the scan now keeps reading past a file that
  // did answer whenever a later file could still hold a newer snapshot. State
  // the opens and what was done with them.
  parts.push(
    `read from the newest of ${selection.files.length} ` +
      `${plural(selection.files.length, 'rollout')} scanned` +
      (found.filesRead > 1
        ? ` (${found.filesRead} rollouts opened; this is the newest snapshot in them)`
        : ''),
  );

  return parts.join('; ');
}

function buildReading(
  window: QuotaWindow,
  rate: RateWindow,
  snapshot: RateSnapshot,
  selection: RolloutSelection,
  found: Found,
  now: Date,
): QuotaReading {
  const reading: QuotaReading = {
    provider: PROVIDER_ID,
    label: planLabel(snapshot.planType),
    window,
    // OpenAI's number, unmodified, against the 100 that makes it a percentage.
    used: rate.usedPercent,
    limit: PERCENT_LIMIT,
    unit: 'percent',
    windowStart: windowStartOf(rate),
    resetsAt: rate.resetsAt.toISOString(),
    // Not negotiable, and the mirror image of the Claude Code adapter: this
    // figure was published by the provider, so it must never render with the
    // '~' that marks an estimate of ours.
    confidence: 'reported',
  };

  const note = buildNote(rate, snapshot, selection, found, now);
  if (note !== '') reading.note = note;

  return reading;
}

/* -------------------------------------------------------------------------- */
/* the adapter                                                                */
/* -------------------------------------------------------------------------- */

export const codexAdapter: QuotaAdapter = {
  id: PROVIDER_ID,
  displayName: DISPLAY_NAME,

  /**
   * True when `<codex-home>/sessions` holds at least one readable `.jsonl`
   * rollout. Never throws: an absent or unreadable Codex home is simply
   * "Codex is not here".
   *
   * A tree holding nothing but `*.jsonl.zst` reads as NOT detected, which is
   * the honest answer - we cannot open any of it, so we have nothing to say.
   *
   * `includeArchived` is honoured here for the same reason `dir` is: `detect`
   * gates `read`, so any option that widens what `read` would look at has to
   * widen what `detect` looks at too. Without it, a user who set
   * `includeArchived: true` because their live `sessions/` is empty got a
   * silent "Codex is not here" and no way to tell the option was ignored.
   */
  async detect(ctx: AdapterContext): Promise<boolean> {
    try {
      const dir = resolveCodexDir(ctx);
      const selection = await listRollouts(dir, {
        limit: 1,
        includeArchived: optBoolean(ctx.options, 'includeArchived') ?? false,
      });
      if (selection.files.length === 0) {
        ctx.debug(
          `${PROVIDER_ID}: no readable rollouts under ${dir}/sessions` +
            (selection.skippedCompressed > 0
              ? ` (${selection.skippedCompressed} zstd-compressed and skipped)`
              : ''),
        );
        return false;
      }
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Return one reading per rate-limit window OpenAI reported in the newest
   * rollout that carries a snapshot.
   *
   * Returns `[]` - not a zeroed row - when no snapshot can be found. A blank
   * gauge is a fact; a fabricated 0% is a claim we cannot support.
   */
  async read(ctx: AdapterContext): Promise<QuotaReading[]> {
    const opts = resolveOptions(ctx);
    const now = ctx.now();

    const selection = await listRollouts(opts.codexDir, {
      limit: opts.maxFiles,
      includeArchived: opts.includeArchived,
    });

    ctx.debug(
      `${PROVIDER_ID}: ${selection.scanned} ${plural(selection.scanned, 'rollout')} under ` +
        `${opts.codexDir}, reading the newest ${selection.files.length}` +
        (selection.skippedCompressed > 0
          ? `, skipping ${selection.skippedCompressed} zstd-compressed`
          : ''),
    );

    if (selection.files.length === 0) return [];

    const found = await findSnapshot(selection.entries, ctx);
    if (found === null) {
      ctx.debug(
        `${PROVIDER_ID}: no rate_limits snapshot in the newest ${selection.files.length} ` +
          `${plural(selection.files.length, 'rollout')}; reporting nothing rather than zero`,
      );
      return [];
    }

    const snapshot = found.snapshot;
    const windows: ReadonlyArray<readonly [QuotaWindow, RateWindow | null]> = [
      ['session', snapshot.session],
      ['weekly', snapshot.weekly],
    ];

    const readings: QuotaReading[] = [];
    for (const [window, rate] of windows) {
      if (rate === null) continue;
      readings.push(buildReading(window, rate, snapshot, selection, found, now));
    }
    return readings;
  },
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
