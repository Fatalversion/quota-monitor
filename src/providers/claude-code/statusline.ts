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

/** One window as the snapshot file holds it. */
export interface SnapshotWindow extends ObservedWindow {
  /** When the kept figure last changed. Repeating it does not move this. */
  observedAt: Date;
}

export interface RateLimitSnapshot {
  /** When the file was last written, which is when any window last changed. */
  writtenAt: Date;
  windows: { [W in LimitWindow]?: SnapshotWindow };
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
  };
  if (kept === undefined) return fresh;

  const delta = next.resetsAt.getTime() - kept.resetsAt.getTime();
  if (Math.abs(delta) <= SAME_WINDOW_TOLERANCE_MS) {
    return next.usedPercentage > kept.usedPercentage ? fresh : kept;
  }
  return delta > 0 ? fresh : kept;
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
): { snapshot: RateLimitSnapshot; changed: boolean } {
  const windows: RateLimitSnapshot['windows'] = {};
  let changed = false;

  for (const window of LIMIT_WINDOWS) {
    const kept = existing?.windows[window];
    const merged = mergeWindow(kept, observed[window], now);
    if (merged !== undefined) windows[window] = merged;
    if (merged !== kept) changed = true;
  }

  const writtenAt = changed || existing === null ? now : existing.writtenAt;
  return { snapshot: { writtenAt, windows }, changed };
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
    };
  }

  const payload = {
    tool: 'quota-monitor',
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    writtenAt: snapshot.writtenAt.toISOString(),
    windows,
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
    const entry = field(raw, window);
    const used = field(entry, 'usedPercentage');
    const resetsAt = isoDate(field(entry, 'resetsAt'));
    const observedAt = isoDate(field(entry, 'observedAt'));
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue;
    if (resetsAt === null || observedAt === null) continue;
    windows[window] = {
      usedPercentage: used,
      resetsAt,
      observedAt,
      clamped: field(entry, 'clamped') === true,
    };
  }

  return { writtenAt, windows };
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
