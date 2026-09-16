/**
 * Anthropic's own usage percentages, as Claude Code's status line hands them
 * over.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Nothing Claude Code writes to disk records a rate limit, so every percentage
 * the transcript scan can produce is `derived`. There is exactly one sanctioned
 * place the provider's own figure leaves Claude Code: the JSON a status line
 * command receives on stdin, which carries
 *
 *     rate_limits.five_hour.used_percentage    0 to 100
 *     rate_limits.five_hour.resets_at          Unix epoch SECONDS
 *     rate_limits.seven_day.used_percentage    0 to 100
 *     rate_limits.seven_day.resets_at          Unix epoch SECONDS
 *
 * (code.claude.com/docs/en/statusline, checked 2026-09-15). The user points
 * their status line at `quota statusline`, which records those numbers into a
 * snapshot file that belongs to quota-monitor, and the adapter reads the
 * snapshot back as `confidence: 'reported'`.
 *
 * THE LINES THIS DOES NOT CROSS
 * -----------------------------
 * - It writes nothing into ~/.claude. The user adds the `statusLine` entry to
 *   their own settings; `quota statusline --print-config` prints the entry and
 *   edits nothing.
 * - It reads no credential and makes no network call. The figures arrive on
 *   stdin from a process the user configured.
 * - It keeps the numbers and nothing else. The same payload carries the working
 *   directory, the repository, the session name and the pull request URL, and
 *   none of it is stored, logged or echoed.
 *
 * ABSENT FIELDS ARE NORMAL
 * ------------------------
 * `rate_limits` exists only for Pro and Max subscribers and only after the
 * first API response of a session; each window may be missing on its own; and
 * Claude Code drops a window once its `resets_at` has passed. A payload with no
 * usable window is routine, and it never erases what is already on disk.
 *
 * MANY SESSIONS, ONE FILE
 * -----------------------
 * Every running session fires its own status line, and an idle one re-renders
 * with whatever its LAST response carried: a permission-mode toggle hours later
 * hands over hours-old numbers. Last writer wins would let that idle session
 * overwrite a live one, so the merge is order-independent, per window:
 *
 *   - a later `resets_at` is a newer window, and replaces an older one;
 *   - within the same window the HIGHER percentage is kept, because usage
 *     inside one window only accumulates, so a lower figure can only have come
 *     from an older response;
 *   - an older window never replaces a newer one.
 *
 * `observedAt` moves only when the kept figure changes. An idle session
 * repeating an old number must not make that number look fresh.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The two subscription windows, named as Claude Code names them. */
export const LIMIT_WINDOWS = ['five_hour', 'seven_day'] as const;

export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Nominal window lengths. Used to back-compute where a window opened, since the
 * payload carries only when it resets, and to reject a reset time that cannot
 * belong to the window it is filed under.
 */
export const LIMIT_WINDOW_MS: Readonly<Record<LimitWindow, number>> = Object.freeze({
  five_hour: 5 * MS_PER_HOUR,
  seven_day: 7 * MS_PER_DAY,
});

/**
 * Two reset times closer than this describe the same window.
 *
 * The windows are hours apart, so ten minutes can never merge two different
 * windows, and it absorbs any rounding in how the reset time is reported.
 */
export const SAME_WINDOW_TOLERANCE_MS = 10 * MS_PER_MINUTE;

/** Largest status line payload accepted. The documented example is about 2 KB. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Largest snapshot file read back. A real one is a few hundred bytes. */
const MAX_SNAPSHOT_BYTES = 64 * 1024;

export const SNAPSHOT_KIND = 'claude-code-rate-limits';
export const SNAPSHOT_VERSION = 1;

/** One window as a status line payload reported it. */
export interface ObservedWindow {
  /** Anthropic's figure, clamped to 0-100. */
  usedPercentage: number;
  resetsAt: Date;
  /** True when the payload carried a value outside 0-100. */
  clamped: boolean;
}

export type ObservedLimits = { [W in LimitWindow]?: ObservedWindow };

/** Percentage points per token, and the observation it came from. */
export interface MeasuredRate {
  pointsPerToken: number;
  /** Points the provider added across the interval. */
  points: number;
  /** Local tokens recorded in the same interval. */
  tokens: number;
  /** The later of the two figures it was measured between. */
  measuredAt: Date;
}

/** A figure this window used to carry, and when it did. */
export interface Observation {
  usedPercentage: number;
  observedAt: Date;
}

/**
 * How many superseded figures one window keeps.
 *
 * They exist to measure a RATE - what one of this user's tokens costs against
 * this window, in percentage points - so the useful ones are the recent ones:
 * a week-old pair describes a week-old mix of models. Twelve is a few hundred
 * bytes and more span than any rate should be measured over.
 */
export const MAX_HISTORY = 12;

/** One window as the snapshot file holds it. */
export interface SnapshotWindow extends ObservedWindow {
  /** When the kept figure last changed. Repeating it does not move this. */
  observedAt: Date;
  /**
   * Figures this window carried BEFORE the current one, oldest first, and only
   * ever for the current window - a reset clears them.
   *
   * Two reports plus the transcripts between them say what Anthropic charged
   * for a known quantity of local work, which is the only way this tool can
   * know the rate rather than assume it. A configured token cap cannot: on the
   * machine this was written for, a week of mixed models averaged 7.5 points
   * per million tokens while the last seventeen hours of 1M-context Opus ran
   * at 33, a 4.5x difference that no constant survives.
   */
  history: readonly Observation[];
}

/** Longest model name kept, and the most of them. A guard, not a policy. */
export const MAX_MODEL_NAME = 60;
export const MAX_MODELS = 8;

export interface RateLimitSnapshot {
  /** When the file was last written, which is when any window last changed. */
  writtenAt: Date;
  windows: { [W in LimitWindow]?: SnapshotWindow };
  /**
   * What one of this user's tokens costs against each window, in percentage
   * points, as last measured between two reported figures.
   *
   * Kept because the thing it is measured from does not survive: `history` is
   * cleared when a window resets, and a window that has just reset is exactly
   * when the estimate has to stand on its own. A rate measured yesterday is a
   * far better denominator than a constant solved months ago on someone else's
   * model mix - on this machine the two differed by 4.5x inside one week.
   */
  rates?: { [W in LimitWindow]?: MeasuredRate };
  /**
   * Per-model weekly limits, keyed by the name the provider printed.
   *
   * Claude Code's `/usage` reports one of these beside the plan's own weekly
   * figure ("Current week (Fable): 76%"), and on a Max plan it is frequently
   * the one that stops the work first. The status line payload does NOT carry
   * it, so these only move when a probe runs - which is exactly why they are
   * stored rather than recomputed, and why every reading built from them wears
   * its `observedAt`.
   *
   * Keyed by name because the provider names them and we do not get an id.
   */
  models: Record<string, SnapshotWindow>;
}

/**
 * Where the snapshot lives: beside the config file, in quota-monitor's own
 * directory, never inside ~/.claude.
 */
export function statusLineSnapshotPath(homeDir: string): string {
  return join(homeDir, '.config', 'quota-monitor', 'claude-code-rate-limits.json');
}

/* -------------------------------------------------------------------------- */
/* reading the status line payload                                            */
/* -------------------------------------------------------------------------- */

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function observedWindow(value: unknown, window: LimitWindow, now: Date): ObservedWindow | null {
  const used = field(value, 'used_percentage');
  const resets = field(value, 'resets_at');
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;

  const resetsMs = resets * 1000;
  const nowMs = now.getTime();
  const length = LIMIT_WINDOW_MS[window];

  // A reset further out than one whole window cannot describe this window.
  // This is also what catches a unit change: a value in milliseconds read as
  // seconds lands tens of thousands of years out and is refused, rather than
  // rendered as a countdown nobody could act on.
  if (resetsMs > nowMs + length + SAME_WINDOW_TOLERANCE_MS) return null;
  // A window that closed more than a whole window ago says nothing useful.
  if (resetsMs < nowMs - length) return null;

  const resetsAt = new Date(resetsMs);
  if (Number.isNaN(resetsAt.getTime())) return null;

  return {
    usedPercentage: Math.min(100, Math.max(0, used)),
    resetsAt,
    clamped: used < 0 || used > 100,
  };
}

/**
 * The rate-limit windows in one status line payload.
 *
 * Never throws. Text that is not JSON, a payload with no `rate_limits`, and a
 * window with a missing or implausible field all come back as "no window",
 * because every one of those is a routine payload rather than an error.
 */
export function parseStatusLinePayload(text: string, now: Date): ObservedLimits {
  const limits: ObservedLimits = {};
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PAYLOAD_BYTES) {
    return limits;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return limits;
  }

  const rate = field(parsed, 'rate_limits');
  for (const window of LIMIT_WINDOWS) {
    const observed = observedWindow(field(rate, window), window, now);
    if (observed !== null) limits[window] = observed;
  }
  return limits;
}

/* -------------------------------------------------------------------------- */
/* merging                                                                    */
/* -------------------------------------------------------------------------- */

function mergeWindow(
  kept: SnapshotWindow | undefined,
  next: ObservedWindow | undefined,
  now: Date,
): SnapshotWindow | undefined {
  if (next === undefined) return kept;

  const fresh: SnapshotWindow = {
    usedPercentage: next.usedPercentage,
    resetsAt: next.resetsAt,
    clamped: next.clamped,
    observedAt: now,
    history: [],
  };
  if (kept === undefined) return fresh;

  const delta = next.resetsAt.getTime() - kept.resetsAt.getTime();
  if (Math.abs(delta) <= SAME_WINDOW_TOLERANCE_MS) {
    // The same window, moved on: the figure being replaced is a measurement of
    // this window at a known instant, and the pair is what a rate is made of.
    return next.usedPercentage > kept.usedPercentage
      ? { ...fresh, history: withHistory(kept) }
      : kept;
  }
  // A different window. Its predecessor's figures describe a limit that has
  // already reset, so they can say nothing about this one.
  return delta > 0 ? fresh : kept;
}

/** `kept`'s own figure appended to its history, newest last, capped. */
function withHistory(kept: SnapshotWindow): readonly Observation[] {
  const next = [
    ...kept.history,
    { usedPercentage: kept.usedPercentage, observedAt: kept.observedAt },
  ];
  // Drop from the OLD end: a rate wants recency.
  return next.slice(Math.max(0, next.length - MAX_HISTORY));
}

/**
 * Fold one payload into the snapshot. See the header for why this is not last
 * writer wins.
 *
 * `changed` is false when nothing on disk would differ, so a caller can skip
 * the write: the status line runs on every response, and rewriting an
 * identical file each time is wear for no information.
 */
export function mergeSnapshot(
  existing: RateLimitSnapshot | null,
  observed: ObservedLimits,
  now: Date,
  models: Record<string, ObservedWindow> = {},
): { snapshot: RateLimitSnapshot; changed: boolean } {
  const windows: RateLimitSnapshot['windows'] = {};
  let changed = false;

  for (const window of LIMIT_WINDOWS) {
    const kept = existing?.windows[window];
    const merged = mergeWindow(kept, observed[window], now);
    if (merged !== undefined) windows[window] = merged;
    if (merged !== kept) changed = true;
  }

  // Per-model limits go through the very same merge: a higher figure inside one
  // window wins, a later window replaces an earlier one, and the superseded
  // figure lands in history. A model the newest report did not mention is kept
  // rather than dropped - /usage names only the model you have been using, and
  // forgetting the others every probe would make them flicker.
  const kept: Record<string, SnapshotWindow> = { ...(existing?.models ?? {}) };
  for (const [name, next] of Object.entries(models)) {
    const clean = name.trim().slice(0, MAX_MODEL_NAME);
    if (clean === '') continue;
    const merged = mergeWindow(kept[clean], next, now);
    if (merged === undefined) continue;
    if (merged !== kept[clean]) changed = true;
    kept[clean] = merged;
  }

  // Newest first, then capped: a plan cannot have eight weekly model limits,
  // and a file that grows a key per model name forever is a bug with a slow fuse.
  const trimmed: Record<string, SnapshotWindow> = {};
  for (const [name, entry] of Object.entries(kept)
    .sort((a, b) => b[1].observedAt.getTime() - a[1].observedAt.getTime())
    .slice(0, MAX_MODELS)) {
    trimmed[name] = entry;
  }

  const writtenAt = changed || existing === null ? now : existing.writtenAt;
  const rates = existing?.rates;
  return {
    snapshot: { writtenAt, windows, models: trimmed, ...(rates === undefined ? {} : { rates }) },
    changed,
  };
}

/**
 * Record a freshly measured rate for one window.
 *
 * Separate from `mergeSnapshot` because it is a different kind of fact: the
 * windows carry what the provider SAID, and this carries what we worked out
 * from two of those sayings. `changed` is false when the rate is the same one
 * already on disk, so a read that measures nothing new writes nothing.
 */
export function withRate(
  snapshot: RateLimitSnapshot,
  window: LimitWindow,
  rate: MeasuredRate | null,
): { snapshot: RateLimitSnapshot; changed: boolean } {
  if (rate === null) return { snapshot, changed: false };

  const kept = snapshot.rates?.[window];
  if (kept !== undefined && kept.measuredAt.getTime() >= rate.measuredAt.getTime()) {
    return { snapshot, changed: false };
  }

  return {
    snapshot: { ...snapshot, rates: { ...snapshot.rates, [window]: rate } },
    changed: true,
  };
}

/* -------------------------------------------------------------------------- */
/* the snapshot file                                                          */
/* -------------------------------------------------------------------------- */

export function serializeSnapshot(snapshot: RateLimitSnapshot): string {
  const windows: Record<string, unknown> = {};
  for (const window of LIMIT_WINDOWS) {
    const entry = snapshot.windows[window];
    if (entry === undefined) continue;
    windows[window] = {
      usedPercentage: entry.usedPercentage,
      resetsAt: entry.resetsAt.toISOString(),
      observedAt: entry.observedAt.toISOString(),
      clamped: entry.clamped,
      // Omitted while empty: a fresh window's file stays as small and as
      // readable as it was before history existed.
      ...(entry.history.length > 0
        ? {
            history: entry.history.map((seen) => ({
              usedPercentage: seen.usedPercentage,
              observedAt: seen.observedAt.toISOString(),
            })),
          }
        : {}),
    };
  }

  const models: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(snapshot.models)) {
    models[name] = {
      usedPercentage: entry.usedPercentage,
      resetsAt: entry.resetsAt.toISOString(),
      observedAt: entry.observedAt.toISOString(),
      clamped: entry.clamped,
      ...(entry.history.length > 0
        ? {
            history: entry.history.map((seen) => ({
              usedPercentage: seen.usedPercentage,
              observedAt: seen.observedAt.toISOString(),
            })),
          }
        : {}),
    };
  }

  const rates: Record<string, unknown> = {};
  for (const window of LIMIT_WINDOWS) {
    const rate = snapshot.rates?.[window];
    if (rate === undefined) continue;
    rates[window] = {
      pointsPerToken: rate.pointsPerToken,
      points: rate.points,
      tokens: rate.tokens,
      measuredAt: rate.measuredAt.toISOString(),
    };
  }

  const payload = {
    tool: 'quota-monitor',
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    writtenAt: snapshot.writtenAt.toISOString(),
    windows,
    ...(Object.keys(rates).length > 0 ? { rates } : {}),
    // Omitted while empty, so a file from before per-model limits and a file
    // from a plan that has none look the same.
    ...(Object.keys(models).length > 0 ? { models } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Read a snapshot back. Tolerant: a malformed window is dropped on its own, and
 * a file that is not a snapshot at all is null. A file from a newer or older
 * format is also null rather than half-understood.
 */
export function parseSnapshot(text: string): RateLimitSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (field(parsed, 'kind') !== SNAPSHOT_KIND) return null;
  if (field(parsed, 'version') !== SNAPSHOT_VERSION) return null;

  const writtenAt = isoDate(field(parsed, 'writtenAt'));
  if (writtenAt === null) return null;

  const raw = field(parsed, 'windows');
  const windows: RateLimitSnapshot['windows'] = {};

  for (const window of LIMIT_WINDOWS) {
    const entry = snapshotWindow(field(raw, window));
    if (entry !== null) windows[window] = entry;
  }

  const rates: { [W in LimitWindow]?: MeasuredRate } = {};
  const rawRates = field(parsed, 'rates');
  for (const window of LIMIT_WINDOWS) {
    const entry = field(rawRates, window);
    const pointsPerToken = field(entry, 'pointsPerToken');
    const points = field(entry, 'points');
    const tokens = field(entry, 'tokens');
    const measuredAt = isoDate(field(entry, 'measuredAt'));
    if (typeof pointsPerToken !== 'number' || !Number.isFinite(pointsPerToken)) continue;
    if (!(pointsPerToken > 0) || measuredAt === null) continue;
    if (typeof points !== 'number' || typeof tokens !== 'number') continue;
    rates[window] = { pointsPerToken, points, tokens, measuredAt };
  }

  const models: Record<string, SnapshotWindow> = {};
  const rawModels = field(parsed, 'models');
  if (typeof rawModels === 'object' && rawModels !== null && !Array.isArray(rawModels)) {
    for (const [name, value] of Object.entries(rawModels as Record<string, unknown>).slice(
      0,
      MAX_MODELS,
    )) {
      const entry = snapshotWindow(value);
      if (entry === null) continue;
      const clean = name.trim().slice(0, MAX_MODEL_NAME);
      if (clean !== '') models[clean] = entry;
    }
  }

  return { writtenAt, windows, models, ...(Object.keys(rates).length > 0 ? { rates } : {}) };
}

/** One stored window, or null when the file's version of it is not usable. */
function snapshotWindow(value: unknown): SnapshotWindow | null {
  const used = field(value, 'usedPercentage');
  const resetsAt = isoDate(field(value, 'resetsAt'));
  const observedAt = isoDate(field(value, 'observedAt'));
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (resetsAt === null || observedAt === null) return null;

  return {
    usedPercentage: used,
    resetsAt,
    observedAt,
    clamped: field(value, 'clamped') === true,
    // A file written before history existed simply has none. Same version: the
    // field is additive, and a reader that ignores it loses nothing but the
    // calibration.
    history: parseHistory(field(value, 'history'), observedAt),
  };
}

/**
 * History as the file holds it: oldest first, nothing at or after the figure it
 * belongs to, and never more than the cap.
 *
 * Tolerant like the rest of the parser - one malformed entry is dropped on its
 * own rather than taking the window with it - and it sorts rather than trusting
 * the file's order, because several sessions write this and only the instants
 * are authoritative.
 */
function parseHistory(value: unknown, observedAt: Date): readonly Observation[] {
  if (!Array.isArray(value)) return [];

  const seen: Observation[] = [];
  for (const item of value) {
    const used = field(item, 'usedPercentage');
    const at = isoDate(field(item, 'observedAt'));
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue;
    if (at === null || at.getTime() >= observedAt.getTime()) continue;
    seen.push({ usedPercentage: used, observedAt: at });
  }

  seen.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  return seen.slice(Math.max(0, seen.length - MAX_HISTORY));
}

/** The snapshot on disk, or null when there is none worth trusting. Never throws. */
export async function readRateLimitSnapshot(file: string): Promise<RateLimitSnapshot | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return null;
    return parseSnapshot(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Codes Windows raises when another process briefly holds the target file. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (attempt >= attempts || typeof code !== 'string' || !RETRYABLE_RENAME.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

/**
 * Write the snapshot atomically: a temp file beside it, then a rename over it.
 *
 * Claude Code cancels a status line command that is still running when the
 * next update arrives, so a write can be killed at any instant. A rename means
 * the reader sees the old file or the new one and never half of either.
 */
export async function writeRateLimitSnapshot(
  file: string,
  snapshot: RateLimitSnapshot,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, serializeSnapshot(snapshot), 'utf8');
  try {
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface RecordResult {
  /** What this payload carried. */
  observed: ObservedLimits;
  /** The snapshot after merging, whether or not it was written. */
  snapshot: RateLimitSnapshot;
  wrote: boolean;
}

/**
 * The whole `quota statusline` job: parse, merge with what is on disk, write
 * only when something changed.
 *
 * Throws only when the write itself fails. The caller decides what a failed
 * write costs; the status line command still prints what it was given.
 */
export async function recordStatusLine(
  payload: string,
  file: string,
  now: Date,
): Promise<RecordResult> {
  const observed = parseStatusLinePayload(payload, now);
  const existing = await readRateLimitSnapshot(file);
  const { snapshot, changed } = mergeSnapshot(existing, observed, now);
  if (changed) await writeRateLimitSnapshot(file, snapshot);
  return { observed, snapshot, wrote: changed };
}

/* -------------------------------------------------------------------------- */
/* the status line text                                                       */
/* -------------------------------------------------------------------------- */

const SHORT_NAME: Readonly<Record<LimitWindow, string>> = Object.freeze({
  five_hour: '5h',
  seven_day: '7d',
});

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** '18%', '23.5%'. One decimal at most, and never a trailing '.0'. */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '0%';
  const rounded = Math.round(n * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}%`;
}

/** Time left: '<1m', '45m', '2h 31m', '5d 02h'. */
export function formatTimeLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms < MS_PER_MINUTE) return '<1m';
  const minutes = Math.floor(ms / MS_PER_MINUTE);
  if (ms < MS_PER_HOUR) return `${minutes}m`;
  const hours = Math.floor(ms / MS_PER_HOUR);
  if (ms < MS_PER_DAY) return `${hours}h ${pad2(minutes % 60)}m`;
  return `${Math.floor(ms / MS_PER_DAY)}d ${pad2(hours % 24)}h`;
}

/**
 * The line printed back into Claude Code: `5h 18% (2h 31m) | 7d 39% (5d 02h)`.
 *
 * A window that has already reset is left out rather than shown with a stale
 * figure and a countdown of zero. No window at all is an empty string.
 */
export function formatStatusLine(windows: RateLimitSnapshot['windows'] | ObservedLimits, now: Date): string {
  const parts: string[] = [];
  for (const window of LIMIT_WINDOWS) {
    const entry = windows[window];
    if (entry === undefined) continue;
    const left = entry.resetsAt.getTime() - now.getTime();
    if (left <= 0) continue;
    parts.push(`${SHORT_NAME[window]} ${formatPercent(entry.usedPercentage)} (${formatTimeLeft(left)})`);
  }
  return parts.join(' | ');
}
