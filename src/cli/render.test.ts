import { describe, it, expect } from 'vitest';

import {
  bar,
  formatCountdown,
  formatPercent,
  formatTokens,
  formatUsd,
  renderAll,
  renderReading,
} from './render.js';
import type { AdapterResult, QuotaReading } from '../core/types.js';

/** Glyphs restated here on purpose: the tests pin the output, not the source. */
const FULL = '█';
const LIGHT = '░';
const DASH = '┈';
const SEP = ' · ';
const ESC = String.fromCharCode(27);

/** Columns are joined by exactly two spaces. */
const GAP = '  ';
/** An unknown limit leaves the percentage column blank, not '0%', but keeps its width. */
const NO_PCT = ' '.repeat(5);
/** Pad a key to the column width `renderAll` picks, so runs of spaces are never eyeballed. */
const key = (text: string, width: number): string => text.padEnd(width);

/** Fixed clock. Nothing in this file may call Date.now() or new Date(). */
const NOW = new Date('2026-09-14T21:46:00.000Z');

const weeklyDerived: QuotaReading = {
  provider: 'claude-code',
  label: 'Max 20x',
  window: 'weekly',
  used: 4_320_000,
  limit: 8_000_000,
  unit: 'tokens',
  windowStart: '2026-09-08T00:00:00.000Z',
  resetsAt: '2026-09-15T00:00:00.000Z',
  estimatedCostUsd: 18.4,
  confidence: 'derived',
  note: 'Cap comes from the configured plan, not from disk.',
};

const unknownLimit: QuotaReading = {
  provider: 'codex',
  label: 'Plus',
  window: 'daily',
  used: 1234,
  limit: null,
  unit: 'requests',
  windowStart: null,
  resetsAt: null,
  confidence: 'derived',
};

const reportedFull: QuotaReading = {
  provider: 'copilot',
  label: 'Business',
  window: 'monthly',
  used: 300,
  limit: 300,
  unit: 'requests',
  windowStart: null,
  resetsAt: '2026-10-01T00:00:00.000Z',
  confidence: 'reported',
};

/**
 * The shape the Codex adapter emits: the provider did the division, so `used`
 * IS the percentage, `limit` is the 100 that makes it one, and `confidence` is
 * 'reported'. Everything in `describe('percent readings')` below hangs off
 * this fixture.
 */
const codexReported: QuotaReading = {
  provider: 'codex',
  label: 'Plus',
  window: 'session',
  used: 42.7,
  limit: 100,
  unit: 'percent',
  windowStart: '2026-09-14T16:46:00.000Z',
  resetsAt: '2026-09-14T23:00:00.000Z',
  confidence: 'reported',
  note: "OpenAI's own figure; snapshot is 2h 14m old.",
};

describe('bar', () => {
  it('renders an empty track at 0%', () => {
    expect(bar(0)).toBe(LIGHT.repeat(14));
  });

  it('renders a full track at 100%', () => {
    expect(bar(100)).toBe(FULL.repeat(14));
  });

  it('clamps above 100% instead of overflowing the track', () => {
    expect(bar(150)).toBe(FULL.repeat(14));
    expect(bar(100.0001)).toBe(FULL.repeat(14));
    expect(bar(1e9)).toBe(FULL.repeat(14));
    expect(bar(150).length).toBe(14);
  });

  it('clamps below 0%', () => {
    expect(bar(-20)).toBe(LIGHT.repeat(14));
    expect(bar(-0.5)).toBe(LIGHT.repeat(14));
  });

  it('renders the default width at 50%', () => {
    expect(bar(50)).toBe(FULL.repeat(7) + LIGHT.repeat(7));
  });

  it('honours an explicit width', () => {
    expect(bar(50, 10)).toBe(FULL.repeat(5) + LIGHT.repeat(5));
    expect(bar(50, 20)).toBe(FULL.repeat(10) + LIGHT.repeat(10));
    expect(bar(50, 4)).toBe(FULL.repeat(2) + LIGHT.repeat(2));
    expect(bar(100, 4)).toBe(FULL.repeat(4));
    expect(bar(0, 4)).toBe(LIGHT.repeat(4));
    expect(bar(25, 8)).toBe(FULL.repeat(2) + LIGHT.repeat(6));
    expect(bar(75, 8)).toBe(FULL.repeat(6) + LIGHT.repeat(2));
  });

  it('always returns exactly `width` characters', () => {
    for (const width of [1, 2, 3, 5, 14, 30]) {
      for (const pct of [0, 1, 33.3, 50, 99.99, 100, 400]) {
        expect(bar(pct, width)).toHaveLength(width);
      }
      expect(bar(null, width)).toHaveLength(width);
    }
  });

  it('lights at least one cell for any non-zero usage', () => {
    expect(bar(0.0001)).toBe(FULL.repeat(1) + LIGHT.repeat(13));
    expect(bar(1)).toBe(FULL.repeat(1) + LIGHT.repeat(13));
    expect(bar(3, 14)).toBe(FULL.repeat(1) + LIGHT.repeat(13));
  });

  it('keeps the last cell dark until the limit is genuinely reached', () => {
    expect(bar(99.9)).toBe(FULL.repeat(13) + LIGHT.repeat(1));
    expect(bar(99.9, 10)).toBe(FULL.repeat(9) + LIGHT.repeat(1));
  });

  it('renders an unknown limit as a dashed track, never as 0%', () => {
    expect(bar(null)).toBe(DASH.repeat(14));
    expect(bar(null, 6)).toBe(DASH.repeat(6));
    expect(bar(null)).not.toBe(bar(0));
  });

  it('treats a non-finite percentage as unknown', () => {
    expect(bar(Number.NaN)).toBe(DASH.repeat(14));
    expect(bar(Number.POSITIVE_INFINITY)).toBe(DASH.repeat(14));
  });

  it('returns an empty string for a non-positive width', () => {
    expect(bar(50, 0)).toBe('');
    expect(bar(50, -3)).toBe('');
    expect(bar(null, 0)).toBe('');
  });

  it('swaps in ASCII glyphs on request', () => {
    expect(bar(50, 8, { ascii: true })).toBe('####----');
    expect(bar(100, 8, { ascii: true })).toBe('########');
    expect(bar(0, 8, { ascii: true })).toBe('--------');
    expect(bar(null, 8, { ascii: true })).toBe('........');
    expect(bar(50, 8, { ascii: true })).not.toContain(FULL);
  });

  it('emits no escape bytes unless colour is asked for', () => {
    for (const pct of [null, 0, 50, 100, 150]) {
      expect(bar(pct)).not.toContain(ESC);
      expect(bar(pct, 8, { ascii: true })).not.toContain(ESC);
      expect(bar(pct, 8, { color: false })).not.toContain(ESC);
    }
  });

  it('adds ANSI only when colour is on, and changes nothing else', () => {
    const plain = bar(50, 8);
    const coloured = bar(50, 8, { color: true });
    expect(coloured).toContain(ESC);
    expect(stripAnsi(coloured)).toBe(plain);
    expect(stripAnsi(bar(null, 8, { color: true }))).toBe(bar(null, 8));
    // Green under 75, amber from 75, red from 90.
    expect(bar(10, 8, { color: true })).toContain(ESC + '[32m');
    expect(bar(80, 8, { color: true })).toContain(ESC + '[33m');
    expect(bar(95, 8, { color: true })).toContain(ESC + '[31m');
  });
});

describe('formatTokens', () => {
  it('leaves small counts alone', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(178)).toBe('178');
    expect(formatTokens(999)).toBe('999');
  });

  it('abbreviates thousands', () => {
    expect(formatTokens(1000)).toBe('1.0K');
    expect(formatTokens(1234)).toBe('1.2K');
    expect(formatTokens(24_408)).toBe('24.4K');
    expect(formatTokens(30_207)).toBe('30.2K');
    expect(formatTokens(999_499)).toBe('999.5K');
  });

  it('abbreviates millions and billions', () => {
    expect(formatTokens(4_100_000)).toBe('4.1M');
    expect(formatTokens(4_320_000)).toBe('4.3M');
    expect(formatTokens(8_000_000)).toBe('8.0M');
    expect(formatTokens(2_500_000_000)).toBe('2.5B');
  });

  it('promotes rather than printing a rounded 1000 of the smaller unit', () => {
    expect(formatTokens(999.6)).toBe('1.0K');
    expect(formatTokens(999_999)).toBe('1.0M');
    expect(formatTokens(999_999_999)).toBe('1.0B');
  });

  it('handles negatives and junk without throwing', () => {
    expect(formatTokens(-1234)).toBe('-1.2K');
    expect(formatTokens(-5)).toBe('-5');
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatUsd', () => {
  it('always shows two decimals', () => {
    expect(formatUsd(18.4)).toBe('$18.40');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(7)).toBe('$7.00');
    expect(formatUsd(0.005)).toBe('$0.01');
    expect(formatUsd(0.004)).toBe('$0.00');
  });

  it('groups thousands', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(999)).toBe('$999.00');
    expect(formatUsd(1_234_567.891)).toBe('$1,234,567.89');
  });

  it('puts the sign outside the symbol and survives junk', () => {
    expect(formatUsd(-3.2)).toBe('-$3.20');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });
});

describe('formatPercent', () => {
  it('drops a trailing .0 so a whole percentage reads as one', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(42)).toBe('42%');
    expect(formatPercent(100)).toBe('100%');
  });

  it('keeps one decimal, and only one', () => {
    expect(formatPercent(42.7)).toBe('42.7%');
    expect(formatPercent(42.75)).toBe('42.8%');
    expect(formatPercent(0.44)).toBe('0.4%');
  });

  it('does not imply precision the provider did not send', () => {
    // 0.04 is not "0.04%" to a reader deciding whether to keep working.
    expect(formatPercent(0.04)).toBe('0%');
  });

  it('survives junk without inventing a figure', () => {
    expect(formatPercent(Number.NaN)).toBe('0%');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('0%');
  });
});

describe('formatCountdown', () => {
  const from = new Date('2026-09-11T00:00:00.000Z');
  const plus = (ms: number): Date => new Date(from.getTime() + ms);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('renders hours and minutes', () => {
    expect(formatCountdown(from, plus(2 * HOUR + 14 * MINUTE))).toBe('2h 14m');
    expect(formatCountdown(from, plus(1 * HOUR + 5 * MINUTE))).toBe('1h 05m');
    expect(formatCountdown(from, plus(23 * HOUR + 59 * MINUTE))).toBe('23h 59m');
  });

  it('renders days and zero-padded hours', () => {
    expect(formatCountdown(from, plus(3 * DAY + 6 * HOUR))).toBe('3d 06h');
    expect(formatCountdown(from, plus(25 * HOUR))).toBe('1d 01h');
    expect(formatCountdown(from, plus(30 * DAY + 23 * HOUR))).toBe('30d 23h');
  });

  it('renders bare minutes under an hour', () => {
    expect(formatCountdown(from, plus(45 * MINUTE))).toBe('45m');
    expect(formatCountdown(from, plus(1 * MINUTE))).toBe('1m');
  });

  it("collapses anything elapsed or imminent to 'now'", () => {
    expect(formatCountdown(from, from)).toBe('now');
    expect(formatCountdown(from, plus(30_000))).toBe('now');
    expect(formatCountdown(from, plus(-1))).toBe('now');
    expect(formatCountdown(from, plus(-5 * DAY))).toBe('now');
  });

  it('refuses to guess from an unusable date', () => {
    expect(formatCountdown(from, new Date('not a date'))).toBe('?');
    expect(formatCountdown(new Date('nope'), from)).toBe('?');
  });
});

describe('renderReading', () => {
  it('renders a derived reading with a ~ before the percentage', () => {
    const lines = renderReading(weeklyDerived, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'claude-code weekly  [' +
        FULL.repeat(8) +
        LIGHT.repeat(6) +
        ']   ~54%  Max 20x' +
        SEP +
        '4.3M/8.0M tok' +
        SEP +
        '~$18.40' +
        SEP +
        'resets in 2h 14m',
    );
  });

  it('omits the ~ for a reported reading', () => {
    const lines = renderReading(reportedFull, NOW);
    expect(lines[0]).toBe(
      'copilot monthly  [' +
        FULL.repeat(14) +
        ']   100%  Business' +
        SEP +
        '300/300 req' +
        SEP +
        'resets in 16d 02h',
    );
    expect(lines[0]).not.toContain('~');
  });

  it('shows raw usage and no percentage at all when the limit is unknown', () => {
    const lines = renderReading(unknownLimit, NOW);
    expect(lines[0]).toBe(
      'codex daily' +
        GAP +
        '[' +
        DASH.repeat(14) +
        ']' +
        GAP +
        NO_PCT +
        GAP +
        'Plus' +
        SEP +
        '1.2K req',
    );
    expect(lines[0]).not.toContain('%');
  });

  it('clamps an over-limit reading to 100% rather than printing 133%', () => {
    const over: QuotaReading = { ...reportedFull, used: 400 };
    const lines = renderReading(over, NOW);
    expect(lines[0]).toContain(' 100%');
    expect(lines[0]).toContain('[' + FULL.repeat(14) + ']');
    expect(lines[0]).toContain('400/300 req');
  });

  it('never rounds up to 100% before the limit is reached', () => {
    const almost: QuotaReading = { ...reportedFull, used: 299, limit: 300 };
    expect(renderReading(almost, NOW)[0]).toContain('  99%');
  });

  it('respects the width option', () => {
    const lines = renderReading(weeklyDerived, NOW, { width: 6 });
    expect(lines[0]).toContain('[' + FULL.repeat(3) + LIGHT.repeat(3) + ']');
    expect(renderReading(unknownLimit, NOW, { width: 4 })[0]).toContain(
      '[' + DASH.repeat(4) + ']',
    );
  });

  it('renders pure ASCII on request', () => {
    const lines = renderReading(weeklyDerived, NOW, { ascii: true });
    expect(lines[0]).toBe(
      'claude-code weekly  [########------]   ~54%  Max 20x | 4.3M/8.0M tok | ~$18.40 | ' +
        'resets in 2h 14m',
    );
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7e]*$/.test(lines[0] ?? '')).toBe(true);
  });

  it('adds an indented explanation line only in verbose mode', () => {
    expect(renderReading(weeklyDerived, NOW)).toHaveLength(1);
    const lines = renderReading(weeklyDerived, NOW, { verbose: true });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '    window from 2026-09-08T00:00:00.000Z' +
        SEP +
        'Cap comes from the configured plan, not from disk.',
    );
    // Nothing to explain, so no second line.
    expect(renderReading(unknownLimit, NOW, { verbose: true })).toHaveLength(1);
  });

  it('formats a usd reading as money', () => {
    const spend: QuotaReading = {
      provider: 'devin',
      label: 'Team',
      window: 'monthly',
      used: 42.5,
      limit: 500,
      unit: 'usd',
      windowStart: null,
      resetsAt: null,
      confidence: 'reported',
    };
    expect(renderReading(spend, NOW)[0]).toBe(
      'devin monthly  [' + FULL.repeat(1) + LIGHT.repeat(13) + ']     8%  Team' + SEP + '$42.50/$500.00',
    );
  });

  it("says 'resets now' for a window rolling over within the minute", () => {
    const rolling: QuotaReading = { ...weeklyDerived, resetsAt: '2026-09-14T21:46:30.000Z' };
    expect(renderReading(rolling, NOW)[0]).toContain('resets now');
  });

  /**
   * REGRESSION. A reading can carry a reset that has already been and gone -
   * Codex reports the window that was current when its rollout was written, so
   * a 5-hour window read from a log written days ago expired days ago. That
   * used to print 'resets now', which tells the user the bar is about to clear
   * when in fact the bar describes a window they left long ago. The elapsed
   * time has to be named.
   */
  it("says how long ago an already-elapsed window ended, never 'resets now'", () => {
    const expired: QuotaReading = { ...weeklyDerived, resetsAt: '2026-09-01T00:00:00.000Z' };
    const line = renderReading(expired, NOW)[0] ?? '';
    expect(line).toContain('window ended 13d 21h ago');
    expect(line).not.toContain('resets now');
    expect(line).not.toContain('resets in');
  });

  it('drops the countdown when the reset time is missing or unparseable', () => {
    const noReset: QuotaReading = { ...weeklyDerived, resetsAt: null };
    expect(renderReading(noReset, NOW)[0]).not.toContain('resets');
    const junk: QuotaReading = { ...weeklyDerived, resetsAt: 'sometime on tuesday' };
    expect(renderReading(junk, NOW)[0]).not.toContain('resets');
  });

  it('pads the key column to labelWidth', () => {
    const lines = renderReading(unknownLimit, NOW, { labelWidth: 18 });
    expect(lines[0]?.startsWith(key('codex daily', 18) + GAP + '[')).toBe(true);
  });

  it('emits no escape bytes by default and never trailing whitespace', () => {
    for (const reading of [weeklyDerived, unknownLimit, reportedFull]) {
      for (const line of renderReading(reading, NOW, { verbose: true })) {
        expect(line).not.toContain(ESC);
        expect(line).toBe(line.trimEnd());
      }
    }
  });

  it('produces the same text with colour stripped back off', () => {
    const plain = renderReading(weeklyDerived, NOW, { verbose: true });
    const coloured = renderReading(weeklyDerived, NOW, { verbose: true, color: true });
    expect(coloured.join('\n')).toContain(ESC);
    expect(coloured.map(stripAnsi)).toEqual(plain);
  });
});

describe('renderAll', () => {
  const ok = (id: string, readings: QuotaReading[]): AdapterResult => ({ ok: true, id, readings });
  const failed = (id: string, error: string): AdapterResult => ({ ok: false, id, error });

  it('aligns every row on one key column', () => {
    const text = renderAll(
      [
        ok('claude-code', [weeklyDerived]),
        ok('codex', [unknownLimit]),
        failed('devin', 'ENOENT: no such file'),
        ok('gemini', []),
      ],
      NOW,
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      'claude-code weekly  [' +
        FULL.repeat(8) +
        LIGHT.repeat(6) +
        ']   ~54%  Max 20x' +
        SEP +
        '4.3M/8.0M tok' +
        SEP +
        '~$18.40' +
        SEP +
        'resets in 2h 14m',
    );
    expect(lines[1]).toBe(
      key('codex daily', 18) +
        GAP +
        '[' +
        DASH.repeat(14) +
        ']' +
        GAP +
        NO_PCT +
        GAP +
        'Plus' +
        SEP +
        '1.2K req',
    );
    expect(lines[2]).toBe(key('devin', 18) + GAP + 'failed: ENOENT: no such file');
    expect(lines[3]).toBe(key('gemini', 18) + GAP + 'no data');
    // The bar starts at the same column on every reading row.
    expect(lines[0]?.indexOf('[')).toBe(lines[1]?.indexOf('['));
  });

  it('renders a failure as one muted line and keeps going', () => {
    const text = renderAll(
      [failed('devin', 'boom'), ok('codex', [unknownLimit]), failed('copilot', 'nope')],
      NOW,
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    // 'codex daily' is the widest key here, so every row pads to 11.
    expect(lines[0]).toBe(key('devin', 11) + GAP + 'failed: boom');
    expect(lines[2]).toBe(key('copilot', 11) + GAP + 'failed: nope');
    expect(lines[1]).toContain('Plus');
  });

  it('flattens a multi-line error and strips control bytes from it', () => {
    const text = renderAll([failed('devin', 'line one\nline two\t' + ESC + '[31mred')], NOW);
    expect(text).toBe('devin  failed: line one line two [31mred');
    expect(text).not.toContain(ESC);
  });

  it('truncates an absurdly long error instead of wrapping the widget', () => {
    const text = renderAll([failed('devin', 'x'.repeat(500))], NOW);
    expect(text).toBe('devin  failed: ' + 'x'.repeat(117) + '...');
  });

  it('never prints an empty failure line', () => {
    expect(renderAll([failed('devin', '   ')], NOW)).toBe('devin  failed: unknown error');
  });

  it('handles an empty result list', () => {
    expect(renderAll([], NOW)).toBe('no providers configured');
  });

  it('passes options through to every row', () => {
    const text = renderAll([ok('claude-code', [weeklyDerived])], NOW, { ascii: true, width: 4 });
    expect(text).toContain('[##--]');
    expect(text).not.toContain(FULL);
    const verbose = renderAll([ok('claude-code', [weeklyDerived])], NOW, { verbose: true });
    expect(verbose.split('\n')).toHaveLength(2);
  });

  it('emits no escape bytes unless colour is on', () => {
    const results = [
      ok('claude-code', [weeklyDerived]),
      failed('devin', 'boom'),
      ok('gemini', []),
    ];
    expect(renderAll(results, NOW)).not.toContain(ESC);
    expect(renderAll(results, NOW, { color: true })).toContain(ESC);
    expect(stripAnsi(renderAll(results, NOW, { color: true }))).toBe(renderAll(results, NOW));
  });

  it('renders several readings from one adapter', () => {
    const text = renderAll(
      [ok('claude-code', [weeklyDerived, { ...weeklyDerived, window: 'session', used: 120_000 }])],
      NOW,
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('claude-code session');
    expect(lines[1]).toContain('120.0K/8.0M tok');
  });
});

/**
 * The `percent` unit exists so a provider that publishes its own figure is not
 * forced through a denominator we invented. Two things have to hold for that to
 * mean anything on screen: the percentage carries no '~', and the used/limit
 * pair - "42.7/100 percent" - never appears, because the percentage column has
 * already said it better.
 */
describe('percent readings', () => {
  it('shows the bar and the percentage, and no used/limit pair', () => {
    const lines = renderReading(codexReported, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'codex session' +
        GAP +
        '[' +
        FULL.repeat(6) +
        LIGHT.repeat(8) +
        ']' +
        GAP +
        '  42%' +
        GAP +
        'Plus' +
        SEP +
        'resets in 1h 14m',
    );
  });

  it('never prints the nonsense pair the unit was added to avoid', () => {
    const line = renderReading(codexReported, NOW)[0] ?? '';
    expect(line).not.toContain('/100');
    expect(line).not.toContain('percent');
    expect(line).not.toContain('42.7');
    // ...and nothing that looks like a token count sneaks in either.
    expect(line).not.toContain('tok');
  });

  it('carries no ~ - that marker is reserved for a denominator we supplied', () => {
    const line = renderReading(codexReported, NOW)[0] ?? '';
    expect(line).not.toContain('~');
    expect(line).toContain('  42%');
  });

  it('marks a percent reading we somehow derived, so the rule stays symmetric', () => {
    const derived: QuotaReading = { ...codexReported, confidence: 'derived' };
    expect(renderReading(derived, NOW)[0]).toContain(' ~42%');
  });

  it('renders 0% as an empty track rather than as missing data', () => {
    const idle: QuotaReading = { ...codexReported, used: 0 };
    const line = renderReading(idle, NOW)[0] ?? '';
    expect(line).toContain('[' + LIGHT.repeat(14) + ']');
    expect(line).toContain('   0%');
    expect(line).not.toContain('0/100');
  });

  it('renders a fully consumed window as 100%', () => {
    const spent: QuotaReading = { ...codexReported, used: 100 };
    const line = renderReading(spent, NOW)[0] ?? '';
    expect(line).toContain('[' + FULL.repeat(14) + ']');
    expect(line).toContain(' 100%');
    expect(line).not.toContain('~');
  });

  it('falls back to the raw figure when the percentage column is blank', () => {
    // Defensive: nothing should emit this, but a percent reading with no
    // usable limit must still show its number rather than nothing at all.
    const capless: QuotaReading = { ...codexReported, limit: null };
    const line = renderReading(capless, NOW)[0] ?? '';
    expect(line).toContain('[' + DASH.repeat(14) + ']');
    expect(line).toContain('42.7%');
  });

  it('still explains itself under --verbose', () => {
    const lines = renderReading(codexReported, NOW, { verbose: true });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '    window from 2026-09-14T16:46:00.000Z' +
        SEP +
        "OpenAI's own figure; snapshot is 2h 14m old.",
    );
  });

  it('lines up beside a token reading from another provider', () => {
    const text = renderAll(
      [
        { ok: true, id: 'claude-code', readings: [weeklyDerived] },
        { ok: true, id: 'codex', readings: [codexReported] },
      ],
      NOW,
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.indexOf('[')).toBe(lines[1]?.indexOf('['));
    // One row is an estimate of ours, the other is OpenAI's own. Only the
    // first may wear the '~'.
    expect(lines[0]).toContain('~54%');
    expect(lines[1]).not.toContain('~');
  });

  it('renders in ASCII and in colour without changing the text', () => {
    expect(renderReading(codexReported, NOW, { ascii: true })[0]).toBe(
      'codex session  [######--------]    42%  Plus | resets in 1h 14m',
    );
    const plain = renderReading(codexReported, NOW, { verbose: true });
    const coloured = renderReading(codexReported, NOW, { verbose: true, color: true });
    expect(coloured.map(stripAnsi)).toEqual(plain);
  });
});

/** Local helper so the colour assertions do not depend on the module under test. */
function stripAnsi(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC && text[i + 1] === '[') {
      i += 2;
      while (i < text.length && text[i] !== 'm') i += 1;
      i += 1;
      continue;
    }
    out += text[i] ?? '';
    i += 1;
  }
  return out;
}

describe('a limit that applies to one model', () => {
  it('names the scope in the key column, so two weekly rows cannot be confused', () => {
    const plan: QuotaReading = {
      ...weeklyDerived,
      used: 83,
      limit: 100,
      unit: 'percent',
      confidence: 'reported',
    };
    const model: QuotaReading = { ...plan, used: 76, scope: 'Fable' };

    expect(renderReading(plan, NOW).join(' ')).toContain('claude-code weekly');
    expect(renderReading(model, NOW).join(' ')).toContain('claude-code weekly (Fable)');
  });
});
