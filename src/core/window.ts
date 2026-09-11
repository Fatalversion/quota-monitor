/**
 * Rolling-window arithmetic.
 *
 * Everything here is UTC. Local time zones are a rendering concern; a quota
 * window that shifts under a laptop crossing a time zone is a bug, so the
 * arithmetic never touches the host offset. Every boundary is computed with
 * `Date.UTC`, which normalises out-of-range day and month arguments for us and
 * therefore handles month ends, leap Februaries and December-to-January
 * rollovers without any special-casing.
 *
 * Intervals are half-open, `[start, end)`. An event stamped exactly at `start`
 * belongs to the window; one stamped exactly at `end` belongs to the next one.
 * That is the only rule that makes consecutive windows tile a timeline without
 * double-counting a call that lands on a boundary.
 *
 * There are two window models here and they are not interchangeable.
 * `windowBounds` is CLOCK-ANCHORED and is right for `daily`, `weekly` and
 * `monthly`, which really are calendar quantities. `activityAnchoredWindow` is
 * ACTIVITY-ANCHORED: the window opens on the first event and runs from there,
 * which is how a provider's rolling session limit actually behaves. Reaching
 * for the clock-aligned one to model a rolling limit is the bug this module
 * was corrected for; see the comments on both functions.
 *
 * Nothing here knows about limits. These functions produce a numerator and the
 * span it covers; the denominator lives with the plan configuration, and any
 * reading built on one is `confidence: 'derived'`. Anchoring the window
 * correctly does not change that: the cap is still ours, so the reading is
 * still `derived`.
 */

import { ZERO_TOKENS } from './types.js';
import type { QuotaWindow, TokenCounts, UsageEvent } from './types.js';

/**
 * A window, plus its length when the window kind needs one.
 *
 * `hours` is only meaningful for `kind: 'session'`, where it is the length of
 * one session block. It is ignored for every other kind.
 */
export type WindowSpec = { kind: QuotaWindow; hours?: number | undefined };

/** Claude Code's session block, and the default for any tool that has one. */
export const DEFAULT_SESSION_HOURS = 5;

/** Monday, matching ISO-8601 week numbering. Same 0-6 scale as `getUTCDay`. */
export const DEFAULT_WEEK_STARTS_ON = 1;

export interface WindowBoundsOptions {
  /** Length of one 'session' block in hours. Must be > 0 and <= 24. */
  sessionHours?: number | undefined;
  /** Day a 'weekly' window opens on: 0 = Sunday .. 6 = Saturday. */
  weekStartsOn?: number | undefined;
}

/** A half-open interval, `[start, end)`. */
export interface WindowRange {
  start: Date;
  end: Date;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Epoch ms of a Date, or NaN for anything that is not a usable Date. */
function timeOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : NaN;
}

function requireTime(value: Date, label: string): number {
  const ms = timeOf(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`window: ${label} must be a valid Date`);
  }
  return ms;
}

/** Epoch ms of the UTC midnight that opens the day containing `ms`. */
function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function resolveSessionHours(raw: number | undefined): number {
  const hours = raw ?? DEFAULT_SESSION_HOURS;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error(
      `window: sessionHours must be a finite number greater than 0 and at most 24, got ${String(raw)}`,
    );
  }
  return hours;
}

function resolveWeekStartsOn(raw: number | undefined): number {
  const day = raw ?? DEFAULT_WEEK_STARTS_ON;
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new Error(
      `window: weekStartsOn must be an integer 0 (Sunday) through 6 (Saturday), got ${String(raw)}`,
    );
  }
  return day;
}

/**
 * The window of `kind` that contains `now`.
 *
 * - `session` - WRONG MODEL FOR EVERY ROLLING LIMIT WE KNOW OF. READ THIS
 *   BEFORE USING IT. A provider session limit opens on your first message and
 *   runs from THAT instant, not from a clock boundary; a clock block sweeps in
 *   usage from the previous window and, measured on real transcripts, nearly
 *   doubled the Claude Code session figure. Use `activityAnchoredWindow` for
 *   anything a provider actually enforces. This arm is retained only for a
 *   caller that genuinely wants a fixed clock block - a per-block breakdown of
 *   a day, a histogram, a report bucketed to the same edges every day - and
 *   for the `daily`/`weekly`/`monthly` kinds below, which really are calendar
 *   anchored and are not affected by any of this.
 *
 *   It is a block of `sessionHours` (default 5) anchored to the clock,
 *   so blocks open at 00:00, 05:00, 10:00, 15:00, 20:00 UTC and the sequence
 *   restarts at each UTC midnight. 24 is not divisible by 5, so the last block
 *   of a day is short: it ends at midnight rather than running past it. That
 *   keeps the blocks a non-overlapping tiling of the day, which in turn makes
 *   `end` an honest reset time - the window this function reports one minute
 *   before it closes is the same window it reported an hour earlier. A
 *   `sessionHours` that divides 24 evenly (1, 2, 3, 4, 6, 8, 12, 24) never
 *   produces a short block.
 * - `daily` - UTC midnight to the next UTC midnight.
 * - `weekly` - seven days opening at 00:00 UTC on `weekStartsOn`, Monday by
 *   default.
 * - `monthly` - the calendar month in UTC, first of the month to first of the
 *   next.
 * - `balance` - throws. A balance is a running total with no time bounds.
 *
 * The returned interval always satisfies `start <= now < end`.
 *
 * @throws if `now` is an invalid Date, if `kind` is `'balance'` or unknown, or
 * if an option is out of range.
 */
export function windowBounds(
  kind: QuotaWindow,
  now: Date,
  opts?: WindowBoundsOptions,
): WindowRange {
  const nowMs = requireTime(now, 'now');

  switch (kind) {
    case 'session': {
      const hours = resolveSessionHours(opts?.sessionHours);
      const blockMs = Math.round(hours * MS_PER_HOUR);
      if (blockMs < 1) {
        throw new Error(`window: sessionHours ${hours} is shorter than one millisecond`);
      }
      const dayStart = startOfUtcDay(nowMs);
      const nextDayStart = dayStart + MS_PER_DAY;
      const index = Math.floor((nowMs - dayStart) / blockMs);
      const start = dayStart + index * blockMs;
      const end = Math.min(start + blockMs, nextDayStart);
      return { start: new Date(start), end: new Date(end) };
    }

    case 'daily': {
      const d = new Date(nowMs);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const day = d.getUTCDate();
      return {
        start: new Date(Date.UTC(y, m, day)),
        end: new Date(Date.UTC(y, m, day + 1)),
      };
    }

    case 'weekly': {
      const startsOn = resolveWeekStartsOn(opts?.weekStartsOn);
      const d = new Date(nowMs);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const day = d.getUTCDate();
      // Whole days elapsed since the most recent `startsOn`, 0-6.
      const elapsed = (d.getUTCDay() - startsOn + 7) % 7;
      return {
        start: new Date(Date.UTC(y, m, day - elapsed)),
        end: new Date(Date.UTC(y, m, day - elapsed + 7)),
      };
    }

    case 'monthly': {
      const d = new Date(nowMs);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      // Month index 12 rolls into January of the next year; Date.UTC does it.
      return {
        start: new Date(Date.UTC(y, m, 1)),
        end: new Date(Date.UTC(y, m + 1, 1)),
      };
    }

    case 'balance':
      throw new Error(
        "window: the 'balance' window has no time bounds - it is a running total, " +
          'so read it without a start and end rather than calling windowBounds.',
      );

    default: {
      const unreachable: never = kind;
      throw new Error(`window: unknown quota window ${String(unreachable)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* activity-anchored windows                                                  */
/* -------------------------------------------------------------------------- */

/** Length of one anchored window. */
export interface AnchoredWindowOptions {
  /** Length of one window in hours. Must be > 0. Default 5. */
  hours?: number | undefined;
}

/**
 * The rolling window that is open right now, or an honest "none is".
 *
 * The two shapes are discriminated by `live`, so a caller cannot read `start`
 * without having established that a window exists. `reason` says which of the
 * two ways there is nothing to report, and `lastEnd` is when the most recent
 * window closed - null when no window ever opened inside the timestamps given.
 */
export type AnchoredWindow =
  | { readonly live: true; readonly start: Date; readonly end: Date }
  | {
      readonly live: false;
      readonly start: null;
      readonly end: null;
      readonly reason: 'no-events' | 'expired';
      readonly lastEnd: Date | null;
    };

/** Widest window this function will chain: 31 days. Anything more is a typo. */
const MAX_ANCHORED_HOURS = 24 * 31;

function resolveAnchoredHours(raw: number | undefined): number {
  const hours = raw ?? DEFAULT_SESSION_HOURS;
  if (
    typeof hours !== 'number' ||
    !Number.isFinite(hours) ||
    hours <= 0 ||
    hours > MAX_ANCHORED_HOURS
  ) {
    throw new Error(
      `window: hours must be a finite number greater than 0 and at most ${MAX_ANCHORED_HOURS}, ` +
        `got ${String(raw)}`,
    );
  }
  return hours;
}

/**
 * The rolling window that `now` falls in, anchored to activity rather than to
 * the clock.
 *
 * THIS IS THE MODEL ANTHROPIC ACTUALLY USES for the Claude Code five-hour
 * limit, and getting it wrong is not a rounding error. A window opens on your
 * first message and runs `hours` from THAT instant; when it closes, the next
 * message you send opens a fresh one. Measured against real transcripts on
 * 2026-09-11, a clock-aligned 05:00Z block swept in 1h49m of usage belonging
 * to the previous window and reported 1,351,060 tokens where the truth,
 * anchored at 06:49Z, was 709,837 - very nearly double.
 *
 * The chain is therefore: the earliest timestamp opens window one; the first
 * timestamp at or after window one's end opens window two; and so on until a
 * window's end is later than `now`. That window is the current one. Idle time
 * is not a window: a gap longer than `hours` simply means the next message
 * starts the clock again.
 *
 * Boundaries are half-open, `[start, end)`, exactly as everywhere else here,
 * so a timestamp landing exactly on a window's end opens the next window
 * rather than extending the old one, and a `now` exactly on the end sees that
 * window as closed.
 *
 * The three cases with no window to report are all real and all reported
 * rather than papered over:
 *
 *   - no usable timestamps at all -> `{ live: false, reason: 'no-events' }`.
 *   - every window closed before `now` -> `{ live: false, reason: 'expired' }`
 *     carrying the `lastEnd` it closed at. There is no window open; inventing
 *     one that "starts now" would show a countdown for a limit that is not
 *     running.
 *   - a single timestamp behaves like any other: it opens a window, which is
 *     live for `hours` and then expires.
 *
 * Input handling is deliberately forgiving, because it comes from log files:
 * entries that are not usable Dates are skipped, order is not trusted (a copy
 * is sorted, the caller's array is never mutated), and a timestamp later than
 * `now` is ignored, since a window cannot have been opened by a message that
 * has not happened yet - clock skew must not fabricate a future window.
 *
 * @throws if `now` is not a valid Date or `hours` is out of range. Bad data is
 * skipped; a bad call is a bug and says so.
 */
export function activityAnchoredWindow(
  timestamps: readonly Date[],
  now: Date,
  opts?: AnchoredWindowOptions,
): AnchoredWindow {
  const nowMs = requireTime(now, 'now');
  const lengthMs = Math.round(resolveAnchoredHours(opts?.hours) * MS_PER_HOUR);
  if (lengthMs < 1) {
    throw new Error('window: hours is shorter than one millisecond');
  }

  const stamps: number[] = [];
  if (Array.isArray(timestamps)) {
    for (const value of timestamps) {
      const ms = timeOf(value);
      if (!Number.isFinite(ms) || ms > nowMs) continue;
      stamps.push(ms);
    }
  }
  stamps.sort((a, b) => a - b);

  const first = stamps[0];
  if (first === undefined) {
    return { live: false, start: null, end: null, reason: 'no-events', lastEnd: null };
  }

  let startMs = first;
  let endMs = startMs + lengthMs;
  let cursor = 1;

  // Each iteration closes one expired window and opens the next. `cursor` only
  // ever moves forward, so the whole chain costs one pass over the timestamps.
  while (endMs <= nowMs) {
    let nextStart: number | undefined;
    while (cursor < stamps.length) {
      const ms = stamps[cursor];
      cursor += 1;
      if (ms !== undefined && ms >= endMs) {
        nextStart = ms;
        break;
      }
    }
    if (nextStart === undefined) {
      return {
        live: false,
        start: null,
        end: null,
        reason: 'expired',
        lastEnd: new Date(endMs),
      };
    }
    startMs = nextStart;
    endMs = startMs + lengthMs;
  }

  return { live: true, start: new Date(startMs), end: new Date(endMs) };
}

/**
 * The events that fall in `[start, end)`, in their original order.
 *
 * Returns the same event objects, never copies, and never mutates the input.
 * An event whose `at` is not a usable Date is skipped rather than throwing -
 * one malformed record must not cost us the whole window.
 *
 * @throws only if `start` or `end` is not a valid Date, which is a caller bug
 * rather than bad data.
 */
export function eventsInWindow(events: UsageEvent[], start: Date, end: Date): UsageEvent[] {
  const from = requireTime(start, 'start');
  const to = requireTime(end, 'end');

  const kept: UsageEvent[] = [];
  if (!Array.isArray(events) || to <= from) return kept;

  for (const event of events) {
    if (!event) continue;
    const at = timeOf(event.at);
    if (!Number.isFinite(at)) continue;
    if (at >= from && at < to) kept.push(event);
  }
  return kept;
}

/** Non-negative finite number, or 0. A token count can be neither. */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * Field-by-field total across `events`.
 *
 * Deliberately returns the five classes separately and offers no grand total.
 * `cacheRead` is normally an order of magnitude larger than every other field
 * and is billed at a fraction of the input rate, so a single summed "tokens
 * used" number is not a meaningful figure and must not be presented as one.
 * Collapse the classes into one comparable quantity with a cost estimate
 * instead.
 *
 * Never throws. An event with a missing or malformed `tokens` object
 * contributes nothing; a non-finite or negative field counts as 0.
 */
export function sumTokens(events: UsageEvent[]): TokenCounts {
  const total: TokenCounts = { ...ZERO_TOKENS };
  if (!Array.isArray(events)) return total;

  for (const event of events) {
    if (!event) continue;
    const tokens: Partial<TokenCounts> | undefined = event.tokens;
    if (!tokens || typeof tokens !== 'object') continue;
    total.input += count(tokens.input);
    total.output += count(tokens.output);
    total.cacheCreation += count(tokens.cacheCreation);
    total.cacheRead += count(tokens.cacheRead);
    total.thinking += count(tokens.thinking);
  }
  return total;
}
