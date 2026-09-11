/**
 * Terminal formatting for quota readings.
 *
 * Everything here is pure: functions take data and return strings. Nothing in
 * this module reads a file, touches the network, or writes to stdout - the
 * caller owns the console. That keeps the whole rendering surface trivially
 * testable and makes the "no telemetry, no network" rule impossible to break
 * by accident.
 *
 * Two honesty rules are baked into the output rather than left to callers:
 *
 *  1. A reading whose denominator we supplied (`confidence: 'derived'`) always
 *     prints its percentage with a leading '~'. There is no way to render a
 *     derived figure as if the provider had reported it.
 *  2. A reading with no known limit prints no percentage at all - not "0%",
 *     not "?%". It shows raw usage against a dashed, empty track so the eye
 *     reads "unknown", and the bar cannot be mistaken for "barely used".
 *
 * The `percent` unit is the mirror of rule 1 and the reason it exists. A
 * provider that publishes its own percentage (Codex reports OpenAI's
 * `used_percent`) gives us used = the percentage and limit = 100, so the
 * percentage column IS the reading. Printing "0.0/100 percent" beside it would
 * be noise, so the used/limit pair is dropped for that unit - and because such
 * a reading is `reported`, its percentage carries no '~'. The presence or
 * absence of that one character is the whole distinction; see `percentCell`.
 *
 * Colour is raw ANSI, never a dependency, and is off unless `opts.color` is
 * true. When it is off the returned strings contain no escape bytes at all.
 */

import { percentUsed } from '../core/types.js';
import type { AdapterResult, Confidence, QuotaReading, QuotaUnit } from '../core/types.js';

export interface RenderOptions {
  /** Bar width in characters. Default 14. Values below 1 render an empty bar. */
  width?: number;
  /** Swap block glyphs for '#' / '-' so terminals without a good font work. */
  ascii?: boolean;
  /** Emit raw ANSI colour codes. Default false: output is plain text. */
  color?: boolean;
  /** Append an indented line carrying the window start and the adapter note. */
  verbose?: boolean;
  /** Pad the left-hand key column to this many characters. `renderAll` sets it. */
  labelWidth?: number;
}

/** Default bar width in characters. */
export const DEFAULT_BAR_WIDTH = 14;

/** Width of the percentage column. '~100%' is the widest value it can hold. */
const PERCENT_CELL_WIDTH = 5;

/** Longest error text we will print on one line before truncating. */
const MAX_ERROR_LENGTH = 120;

interface Glyphs {
  /** Consumed portion of the track. */
  readonly filled: string;
  /** Remaining portion of a track whose total is known. */
  readonly empty: string;
  /** Track for a reading with no known limit. */
  readonly dashed: string;
  /** Separator between trailer fields. */
  readonly separator: string;
}

/** U+2588 FULL BLOCK, U+2591 LIGHT SHADE, U+2508 LIGHT QUADRUPLE DASH, U+00B7 MIDDLE DOT. */
const UNICODE_GLYPHS: Glyphs = {
  filled: '█',
  empty: '░',
  dashed: '┈',
  separator: ' · ',
};

/** Pure ASCII fallback for terminals and fonts that mangle box drawing. */
const ASCII_GLYPHS: Glyphs = {
  filled: '#',
  empty: '-',
  dashed: '.',
  separator: ' | ',
};

/** Built from a char code so no literal escape byte ever sits in this source. */
const ESC = String.fromCharCode(27);

const ANSI = {
  reset: ESC + '[0m',
  dim: ESC + '[2m',
  green: ESC + '[32m',
  yellow: ESC + '[33m',
  red: ESC + '[31m',
} as const;

/**
 * Short unit tags. 'usd' and 'percent' are empty because the '$' and the '%'
 * already carry the unit - and "percent" spelled out beside a percentage would
 * read as a second, different number.
 */
const UNIT_SUFFIX: Readonly<Record<QuotaUnit, string>> = Object.freeze({
  requests: 'req',
  tokens: 'tok',
  credits: 'cr',
  usd: '',
  percent: '',
});

function glyphsFor(ascii: boolean): Glyphs {
  return ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/** Wrap `text` in an ANSI code, but only when colour is on and the text is non-empty. */
function paint(text: string, code: string, enabled: boolean): string {
  if (!enabled || text === '') return text;
  return code + text + ANSI.reset;
}

/** Green under 75%, amber from 75%, red from 90%. */
function severity(pct: number): string {
  if (pct >= 90) return ANSI.red;
  if (pct >= 75) return ANSI.yellow;
  return ANSI.green;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A horizontal usage bar of exactly `width` characters.
 *
 * `pct` is clamped to 0-100, so an over-limit reading renders full rather than
 * overflowing the track. `null` - an unknown limit - renders as a dashed track,
 * dimmed when colour is on, and never as an empty "0%" bar.
 *
 * A non-zero percentage always lights at least one cell, and only a true 100%
 * fills the last one: a bar that looks full means the limit really is reached.
 */
export function bar(
  pct: number | null,
  width: number = DEFAULT_BAR_WIDTH,
  opts?: { ascii?: boolean; color?: boolean },
): string {
  const ascii = opts?.ascii === true;
  const color = opts?.color === true;
  const cells = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : DEFAULT_BAR_WIDTH;
  if (cells === 0) return '';

  const glyphs = glyphsFor(ascii);

  if (pct === null || !Number.isFinite(pct)) {
    return paint(glyphs.dashed.repeat(cells), ANSI.dim, color);
  }

  const clamped = Math.min(100, Math.max(0, pct));
  let filled: number;
  if (clamped >= 100) {
    filled = cells;
  } else if (clamped <= 0) {
    filled = 0;
  } else {
    filled = Math.max(1, Math.min(cells - 1, Math.round((clamped / 100) * cells)));
  }

  const head = glyphs.filled.repeat(filled);
  const tail = glyphs.empty.repeat(cells - filled);
  if (!color) return head + tail;
  return paint(head, severity(clamped), true) + paint(tail, ANSI.dim, true);
}

/**
 * Compact token counts: 1234 -> '1.2K', 4100000 -> '4.1M'.
 *
 * Thresholds sit just below each boundary so a value that would round up to
 * '1000.0K' is promoted to '1.0M' instead.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 999.95e6) return sign + (abs / 1e9).toFixed(1) + 'B';
  if (abs >= 999.95e3) return sign + (abs / 1e6).toFixed(1) + 'M';
  if (abs >= 999.5) return sign + (abs / 1e3).toFixed(1) + 'K';
  return sign + String(Math.round(abs));
}

/** Money, always two decimals and thousands-grouped: 18.4 -> '$18.40'. */
export function formatUsd(n: number): string {
  const value = Number.isFinite(n) ? n : 0;
  const sign = value < 0 ? '-' : '';
  const cents = Math.round(Math.abs(value) * 100);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + '$' + grouped + '.' + pad2(fraction);
}

/**
 * Time remaining, coarsened to two units: '2h 14m', '3d 06h', '45m', 'now'.
 *
 * Anything already elapsed, or less than a minute away, is 'now'. An unusable
 * date yields '?' rather than a confident lie.
 */
export function formatCountdown(from: Date, to: Date): string {
  const start = from instanceof Date ? from.getTime() : Number.NaN;
  const end = to instanceof Date ? to.getTime() : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '?';

  const totalMinutes = Math.floor((end - start) / 60000);
  if (totalMinutes <= 0) return 'now';

  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  if (days > 0) return days + 'd ' + pad2(totalHours % 24) + 'h';
  if (totalHours > 0) return totalHours + 'h ' + pad2(totalMinutes % 60) + 'm';
  return totalMinutes + 'm';
}

/**
 * A percentage as a human reads it: '0%', '54.3%', '100%'.
 *
 * At most one decimal, and never a trailing '.0'. Used only where a percent
 * reading cannot reach the percentage column - see `renderReading`; the column
 * itself is whole numbers so that it stays exactly `PERCENT_CELL_WIDTH` wide.
 */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '0%';
  const rounded = Math.round(n * 10) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
}

/** Format a usage figure in the reading's own unit. */
function formatAmount(amount: number, unit: QuotaUnit): string {
  if (unit === 'usd') return formatUsd(amount);
  if (unit === 'percent') return formatPercent(amount);
  return formatTokens(amount);
}

function unitTag(unit: QuotaUnit): string {
  return UNIT_SUFFIX[unit] ?? '';
}

/**
 * The percentage column: right-aligned, '~'-marked when derived, and blank
 * (but still the same width) when the limit is unknown so columns stay square.
 */
function percentCell(pct: number | null, confidence: Confidence, color: boolean): string {
  if (pct === null) return ' '.repeat(PERCENT_CELL_WIDTH);
  // Never claim 100% until the limit is genuinely reached.
  const shown = pct >= 100 ? 100 : Math.min(99, Math.max(0, Math.floor(pct)));
  const marker = confidence === 'derived' ? '~' : '';
  return paint((marker + shown + '%').padStart(PERCENT_CELL_WIDTH), severity(pct), color);
}

/**
 * Flatten an error string to one printable line. Control bytes are replaced
 * rather than passed through: an adapter error is untrusted text and must not
 * be able to move the cursor or set colours of its own.
 */
function oneLine(text: string): string {
  let stripped = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) ?? 0;
    stripped += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const flat = stripped.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'unknown error';
  if (flat.length <= MAX_ERROR_LENGTH) return flat;
  return flat.slice(0, MAX_ERROR_LENGTH - 3) + '...';
}

/** The left-hand key: which provider, which window. */
function headFor(reading: QuotaReading): string {
  return (reading.provider + ' ' + reading.window).trim();
}

/** Parse an ISO timestamp, returning null for anything unusable. */
function parseIso(value: string | null): Date | null {
  if (value === null || value === '') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * One reading as terminal lines.
 *
 * Line 1 is always present: key, bar, percentage (or blank), then a trailer of
 * plan label, raw usage, estimated cost and reset countdown. Line 2 appears
 * only with `opts.verbose`, and only when the reading carries a window start
 * or a note - that is where a derived denominator explains itself.
 *
 * A reset that has already passed prints as 'window ended <ago>' rather than
 * 'resets now', so a percentage from a window that has since rolled over
 * cannot be read as the state of the window the user is in. See the trailer.
 */
export function renderReading(reading: QuotaReading, now: Date, opts?: RenderOptions): string[] {
  const ascii = opts?.ascii === true;
  const color = opts?.color === true;
  const width = opts?.width ?? DEFAULT_BAR_WIDTH;
  const labelWidth = opts?.labelWidth ?? 0;
  const glyphs = glyphsFor(ascii);

  const pct = percentUsed(reading);
  const head = headFor(reading).padEnd(labelWidth);
  const track = '[' + bar(pct, width, { ascii, color }) + ']';
  const cell = percentCell(pct, reading.confidence, color);

  const trailer: string[] = [];
  if (reading.label !== '') trailer.push(reading.label);

  // A percent reading's used/limit pair is "42/100 percent", which says
  // nothing the percentage column has not already said better. Drop it - but
  // only while that column is actually showing the number. If the limit is
  // unusable the column is blank, and then the raw figure is all we have.
  if (reading.unit !== 'percent' || pct === null) {
    const tag = unitTag(reading.unit);
    const used = formatAmount(reading.used, reading.unit);
    const amount =
      reading.limit === null ? used : used + '/' + formatAmount(reading.limit, reading.unit);
    trailer.push(tag === '' ? amount : amount + ' ' + tag);
  }

  const cost = reading.estimatedCostUsd;
  if (cost !== undefined && Number.isFinite(cost)) {
    // Always '~': a cost we worked out from a price sheet is an estimate.
    trailer.push('~' + formatUsd(cost));
  }

  const resetsAt = parseIso(reading.resetsAt);
  if (resetsAt !== null) {
    const countdown = formatCountdown(now, resetsAt);
    if (countdown !== 'now') {
      trailer.push('resets in ' + countdown);
    } else {
      // The reset is not ahead of us. For a window computed against the current
      // clock that means "imminently", but a reading can also carry a reset
      // that has already been and gone: Codex reports the window that was
      // current when its rollout was written, and a 5-hour window read from
      // yesterday's log expired hours ago. Printing 'resets now' for that says
      // the bar is about to clear, when in truth the bar describes a window the
      // user left long ago. Name the elapsed time instead.
      const elapsed = formatCountdown(resetsAt, now);
      trailer.push(elapsed === 'now' ? 'resets now' : 'window ended ' + elapsed + ' ago');
    }
  }

  const lines: string[] = [];
  lines.push([head, track, cell, trailer.join(glyphs.separator)].join('  ').trimEnd());

  if (opts?.verbose === true) {
    const extras: string[] = [];
    if (reading.windowStart !== null && reading.windowStart !== '') {
      extras.push('window from ' + reading.windowStart);
    }
    if (reading.note !== undefined && reading.note !== '') extras.push(reading.note);
    if (extras.length > 0) {
      lines.push(paint('    ' + extras.join(glyphs.separator), ANSI.dim, color));
    }
  }

  return lines;
}

/**
 * Every adapter result as one block of text.
 *
 * A failed adapter is a single muted line naming its error - it never throws,
 * never aborts the rest of the report, and never pretends to have data. An
 * adapter that succeeded with nothing to say gets a 'no data' line for the
 * same reason: silence would look like a bug.
 */
export function renderAll(results: AdapterResult[], now: Date, opts?: RenderOptions): string {
  if (!Array.isArray(results) || results.length === 0) return 'no providers configured';

  const color = opts?.color === true;

  let labelWidth = 0;
  for (const result of results) {
    if (!result) continue;
    if (result.ok === true && Array.isArray(result.readings) && result.readings.length > 0) {
      for (const reading of result.readings) {
        if (!reading) continue;
        labelWidth = Math.max(labelWidth, headFor(reading).length);
      }
    } else {
      labelWidth = Math.max(labelWidth, result.id.length);
    }
  }

  const lines: string[] = [];
  for (const result of results) {
    if (!result) continue;
    if (result.ok === true) {
      const readings = Array.isArray(result.readings) ? result.readings : [];
      if (readings.length === 0) {
        lines.push(paint(result.id.padEnd(labelWidth) + '  no data', ANSI.dim, color));
        continue;
      }
      for (const reading of readings) {
        if (!reading) continue;
        lines.push(...renderReading(reading, now, childOptions(opts, labelWidth)));
      }
    } else {
      const text = result.id.padEnd(labelWidth) + '  failed: ' + oneLine(result.error);
      lines.push(paint(text, ANSI.dim, color));
    }
  }

  return lines.join('\n');
}

/**
 * Copy the caller's options and force the shared column width. Written out
 * field by field because `exactOptionalPropertyTypes` forbids spreading an
 * explicit `undefined` into an optional property.
 */
function childOptions(opts: RenderOptions | undefined, labelWidth: number): RenderOptions {
  const next: RenderOptions = { labelWidth };
  if (opts?.width !== undefined) next.width = opts.width;
  if (opts?.ascii !== undefined) next.ascii = opts.ascii;
  if (opts?.color !== undefined) next.color = opts.color;
  if (opts?.verbose !== undefined) next.verbose = opts.verbose;
  return next;
}
