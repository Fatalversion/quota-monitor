import { describe, it, expect } from 'vitest';

import {
  DEFAULT_SESSION_HOURS,
  DEFAULT_WEEK_STARTS_ON,
  activityAnchoredWindow,
  eventsInWindow,
  sumTokens,
  windowBounds,
} from './window.js';
import type { WindowSpec } from './window.js';
import { ZERO_TOKENS } from './types.js';
import type { QuotaWindow, TokenCounts, UsageEvent } from './types.js';

/**
 * Every date in this file is written out in full and in UTC. Nothing here may
 * call `Date.now()` or `new Date()` with no argument.
 */
function utc(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`test bug: bad fixture date ${iso}`);
  return d;
}

function iso(d: Date): string {
  return d.toISOString();
}

function event(atIso: string, opts: { id?: string; tokens?: Partial<TokenCounts> } = {}): UsageEvent {
  const base: UsageEvent = {
    provider: 'claude-code',
    at: utc(atIso),
    model: 'claude-opus-5',
    tokens: { ...ZERO_TOKENS, ...opts.tokens },
  };
  return opts.id === undefined ? base : { ...base, sessionId: opts.id };
}

describe('windowBounds - session', () => {
  it('defaults to five-hour blocks anchored to UTC midnight', () => {
    expect(DEFAULT_SESSION_HOURS).toBe(5);
    const { start, end } = windowBounds('session', utc('2024-03-10T00:00:00.000Z'));
    expect(iso(start)).toBe('2024-03-10T00:00:00.000Z');
    expect(iso(end)).toBe('2024-03-10T05:00:00.000Z');
  });

  it('keeps the same block for the last millisecond before it closes', () => {
    const { start, end } = windowBounds('session', utc('2024-03-10T04:59:59.999Z'));
    expect(iso(start)).toBe('2024-03-10T00:00:00.000Z');
    expect(iso(end)).toBe('2024-03-10T05:00:00.000Z');
  });

  it('rolls to the next block exactly on the boundary instant', () => {
    const { start, end } = windowBounds('session', utc('2024-03-10T05:00:00.000Z'));
    expect(iso(start)).toBe('2024-03-10T05:00:00.000Z');
    expect(iso(end)).toBe('2024-03-10T10:00:00.000Z');
  });

  it('anchors a mid-block instant to 15:00', () => {
    const { start, end } = windowBounds('session', utc('2024-03-10T17:42:11.500Z'));
    expect(iso(start)).toBe('2024-03-10T15:00:00.000Z');
    expect(iso(end)).toBe('2024-03-10T20:00:00.000Z');
  });

  it('ends the short final block of the day at midnight rather than past it', () => {
    // 24 is not divisible by 5, so the 20:00 block is four hours, not five.
    const { start, end } = windowBounds('session', utc('2024-03-10T22:17:00.000Z'));
    expect(iso(start)).toBe('2024-03-10T20:00:00.000Z');
    expect(iso(end)).toBe('2024-03-11T00:00:00.000Z');
  });

  it('closes the final block on the first of the next month', () => {
    const { start, end } = windowBounds('session', utc('2024-02-29T23:59:59.999Z'));
    expect(iso(start)).toBe('2024-02-29T20:00:00.000Z');
    expect(iso(end)).toBe('2024-03-01T00:00:00.000Z');
  });

  it('closes the final block of the year on 1 January', () => {
    const { start, end } = windowBounds('session', utc('2024-12-31T21:30:00.000Z'));
    expect(iso(start)).toBe('2024-12-31T20:00:00.000Z');
    expect(iso(end)).toBe('2025-01-01T00:00:00.000Z');
  });

  it('honours a custom sessionHours that divides the day evenly', () => {
    const { start, end } = windowBounds('session', utc('2024-03-10T13:45:00.000Z'), {
      sessionHours: 3,
    });
    expect(iso(start)).toBe('2024-03-10T12:00:00.000Z');
    expect(iso(end)).toBe('2024-03-10T15:00:00.000Z');
  });

  it('treats sessionHours 24 as the whole UTC day', () => {
    const { start, end } = windowBounds('session', utc('2024-03-10T13:45:00.000Z'), {
      sessionHours: 24,
    });
    expect(iso(start)).toBe('2024-03-10T00:00:00.000Z');
    expect(iso(end)).toBe('2024-03-11T00:00:00.000Z');
  });

  it('supports a fractional sessionHours', () => {
    const { start, end } = windowBounds('session', utc('2024-03-10T01:20:00.000Z'), {
      sessionHours: 0.5,
    });
    expect(iso(start)).toBe('2024-03-10T01:00:00.000Z');
    expect(iso(end)).toBe('2024-03-10T01:30:00.000Z');
  });

  it('falls back to the default when sessionHours is undefined', () => {
    const explicit = windowBounds('session', utc('2024-03-10T17:42:00.000Z'), {
      sessionHours: undefined,
    });
    const implicit = windowBounds('session', utc('2024-03-10T17:42:00.000Z'));
    expect(iso(explicit.start)).toBe(iso(implicit.start));
    expect(iso(explicit.end)).toBe(iso(implicit.end));
  });

  it('always returns a block containing now, and the blocks tile the day', () => {
    const starts: string[] = [];
    const ends: string[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(Date.UTC(2024, 6, 15, hour, 30, 0, 0));
      const { start, end } = windowBounds('session', now);
      expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(end.getTime()).toBeGreaterThan(now.getTime());
      if (starts[starts.length - 1] !== iso(start)) {
        starts.push(iso(start));
        ends.push(iso(end));
      }
    }
    expect(starts).toEqual([
      '2024-07-15T00:00:00.000Z',
      '2024-07-15T05:00:00.000Z',
      '2024-07-15T10:00:00.000Z',
      '2024-07-15T15:00:00.000Z',
      '2024-07-15T20:00:00.000Z',
    ]);
    // No gaps and no overlaps: each block ends where the next one begins.
    expect(ends).toEqual([...starts.slice(1), '2024-07-16T00:00:00.000Z']);
  });

  it('rejects an out-of-range sessionHours', () => {
    const now = utc('2024-03-10T12:00:00.000Z');
    expect(() => windowBounds('session', now, { sessionHours: 0 })).toThrow(/sessionHours/);
    expect(() => windowBounds('session', now, { sessionHours: -5 })).toThrow(/sessionHours/);
    expect(() => windowBounds('session', now, { sessionHours: 25 })).toThrow(/sessionHours/);
    expect(() => windowBounds('session', now, { sessionHours: Number.NaN })).toThrow(/sessionHours/);
    expect(() =>
      windowBounds('session', now, { sessionHours: Number.POSITIVE_INFINITY }),
    ).toThrow(/sessionHours/);
  });
});

describe('windowBounds - daily', () => {
  it('runs UTC midnight to UTC midnight', () => {
    const { start, end } = windowBounds('daily', utc('2024-03-10T17:42:11.500Z'));
    expect(iso(start)).toBe('2024-03-10T00:00:00.000Z');
    expect(iso(end)).toBe('2024-03-11T00:00:00.000Z');
  });

  it('opens a new day exactly on midnight', () => {
    const { start, end } = windowBounds('daily', utc('2024-03-10T00:00:00.000Z'));
    expect(iso(start)).toBe('2024-03-10T00:00:00.000Z');
    expect(iso(end)).toBe('2024-03-11T00:00:00.000Z');
  });

  it('rolls 28 February into the 29th in a leap year', () => {
    const { start, end } = windowBounds('daily', utc('2024-02-28T12:00:00.000Z'));
    expect(iso(start)).toBe('2024-02-28T00:00:00.000Z');
    expect(iso(end)).toBe('2024-02-29T00:00:00.000Z');
  });

  it('rolls 28 February into 1 March in a common year', () => {
    const { start, end } = windowBounds('daily', utc('2023-02-28T12:00:00.000Z'));
    expect(iso(start)).toBe('2023-02-28T00:00:00.000Z');
    expect(iso(end)).toBe('2023-03-01T00:00:00.000Z');
  });

  it('rolls 29 February into 1 March', () => {
    const { start, end } = windowBounds('daily', utc('2024-02-29T23:59:59.999Z'));
    expect(iso(start)).toBe('2024-02-29T00:00:00.000Z');
    expect(iso(end)).toBe('2024-03-01T00:00:00.000Z');
  });

  it('rolls 31 December into 1 January of the next year', () => {
    const { start, end } = windowBounds('daily', utc('2024-12-31T23:00:00.000Z'));
    expect(iso(start)).toBe('2024-12-31T00:00:00.000Z');
    expect(iso(end)).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('windowBounds - weekly', () => {
  it('starts on Monday by default', () => {
    expect(DEFAULT_WEEK_STARTS_ON).toBe(1);
    // 2024-02-14 is a Wednesday.
    const { start, end } = windowBounds('weekly', utc('2024-02-14T09:15:00.000Z'));
    expect(iso(start)).toBe('2024-02-12T00:00:00.000Z');
    expect(iso(end)).toBe('2024-02-19T00:00:00.000Z');
  });

  it('keeps a Monday instant in the week it opens', () => {
    const { start, end } = windowBounds('weekly', utc('2024-02-19T00:00:00.000Z'));
    expect(iso(start)).toBe('2024-02-19T00:00:00.000Z');
    expect(iso(end)).toBe('2024-02-26T00:00:00.000Z');
  });

  it('keeps the Sunday last millisecond in the outgoing week', () => {
    const { start, end } = windowBounds('weekly', utc('2024-02-18T23:59:59.999Z'));
    expect(iso(start)).toBe('2024-02-12T00:00:00.000Z');
    expect(iso(end)).toBe('2024-02-19T00:00:00.000Z');
  });

  it('honours weekStartsOn 0 for a Sunday week', () => {
    const { start, end } = windowBounds('weekly', utc('2024-02-14T09:15:00.000Z'), {
      weekStartsOn: 0,
    });
    expect(iso(start)).toBe('2024-02-11T00:00:00.000Z');
    expect(iso(end)).toBe('2024-02-18T00:00:00.000Z');
  });

  it('honours weekStartsOn 3 when now is that very day', () => {
    const { start, end } = windowBounds('weekly', utc('2024-02-14T09:15:00.000Z'), {
      weekStartsOn: 3,
    });
    expect(iso(start)).toBe('2024-02-14T00:00:00.000Z');
    expect(iso(end)).toBe('2024-02-21T00:00:00.000Z');
  });

  it('honours weekStartsOn 6 by reaching back to Saturday', () => {
    const { start, end } = windowBounds('weekly', utc('2024-02-14T09:15:00.000Z'), {
      weekStartsOn: 6,
    });
    expect(iso(start)).toBe('2024-02-10T00:00:00.000Z');
    expect(iso(end)).toBe('2024-02-17T00:00:00.000Z');
  });

  it('spans a month end', () => {
    // 2024-02-29 is a Thursday, so its week runs into March.
    const { start, end } = windowBounds('weekly', utc('2024-02-29T18:00:00.000Z'));
    expect(iso(start)).toBe('2024-02-26T00:00:00.000Z');
    expect(iso(end)).toBe('2024-03-04T00:00:00.000Z');
  });

  it('spans a year end', () => {
    // 2025-01-01 is a Wednesday; its Monday is 2024-12-30.
    const { start, end } = windowBounds('weekly', utc('2025-01-01T06:00:00.000Z'));
    expect(iso(start)).toBe('2024-12-30T00:00:00.000Z');
    expect(iso(end)).toBe('2025-01-06T00:00:00.000Z');
  });

  it('rejects an out-of-range weekStartsOn', () => {
    const now = utc('2024-02-14T09:15:00.000Z');
    expect(() => windowBounds('weekly', now, { weekStartsOn: -1 })).toThrow(/weekStartsOn/);
    expect(() => windowBounds('weekly', now, { weekStartsOn: 7 })).toThrow(/weekStartsOn/);
    expect(() => windowBounds('weekly', now, { weekStartsOn: 1.5 })).toThrow(/weekStartsOn/);
    expect(() => windowBounds('weekly', now, { weekStartsOn: Number.NaN })).toThrow(/weekStartsOn/);
  });
});

describe('windowBounds - monthly', () => {
  it('covers a leap February end to end', () => {
    const { start, end } = windowBounds('monthly', utc('2024-02-29T23:59:59.999Z'));
    expect(iso(start)).toBe('2024-02-01T00:00:00.000Z');
    expect(iso(end)).toBe('2024-03-01T00:00:00.000Z');
  });

  it('covers a common-year February end to end', () => {
    const { start, end } = windowBounds('monthly', utc('2023-02-15T10:00:00.000Z'));
    expect(iso(start)).toBe('2023-02-01T00:00:00.000Z');
    expect(iso(end)).toBe('2023-03-01T00:00:00.000Z');
  });

  it('rolls December into January of the next year', () => {
    const { start, end } = windowBounds('monthly', utc('2024-12-15T12:00:00.000Z'));
    expect(iso(start)).toBe('2024-12-01T00:00:00.000Z');
    expect(iso(end)).toBe('2025-01-01T00:00:00.000Z');
  });

  it('keeps the last instant of December inside December', () => {
    const { start, end } = windowBounds('monthly', utc('2024-12-31T23:59:59.999Z'));
    expect(iso(start)).toBe('2024-12-01T00:00:00.000Z');
    expect(iso(end)).toBe('2025-01-01T00:00:00.000Z');
  });

  it('handles a 31-day month', () => {
    const { start, end } = windowBounds('monthly', utc('2024-01-31T20:00:00.000Z'));
    expect(iso(start)).toBe('2024-01-01T00:00:00.000Z');
    expect(iso(end)).toBe('2024-02-01T00:00:00.000Z');
  });

  it('starts a new month exactly on the first', () => {
    const { start, end } = windowBounds('monthly', utc('2024-11-01T00:00:00.000Z'));
    expect(iso(start)).toBe('2024-11-01T00:00:00.000Z');
    expect(iso(end)).toBe('2024-12-01T00:00:00.000Z');
  });
});

describe('windowBounds - rejected inputs', () => {
  it("throws a clear error for the 'balance' window", () => {
    expect(() => windowBounds('balance', utc('2024-03-10T12:00:00.000Z'))).toThrow(/balance/);
    expect(() => windowBounds('balance', utc('2024-03-10T12:00:00.000Z'))).toThrow(
      /no time bounds/,
    );
  });

  it('throws for an invalid now', () => {
    expect(() => windowBounds('daily', new Date('not a date'))).toThrow(/valid Date/);
    expect(() => windowBounds('monthly', new Date(Number.NaN))).toThrow(/valid Date/);
  });

  it('throws for an unknown window kind', () => {
    const bogus = 'yearly' as unknown as QuotaWindow;
    expect(() => windowBounds(bogus, utc('2024-03-10T12:00:00.000Z'))).toThrow(
      /unknown quota window/,
    );
  });

  it('accepts a WindowSpec-shaped configuration for every bounded kind', () => {
    const specs: WindowSpec[] = [
      { kind: 'session', hours: 4 },
      { kind: 'daily' },
      { kind: 'weekly' },
      { kind: 'monthly' },
    ];
    const now = utc('2024-02-14T09:15:00.000Z');
    for (const spec of specs) {
      const { start, end } = windowBounds(spec.kind, now, { sessionHours: spec.hours });
      expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(end.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

/**
 * The window the provider actually enforces.
 *
 * These are pinned against a real reading taken on 2026-09-11 at 08:17Z, when
 * Claude Code's own /usage panel said the five-hour session was 13% used and
 * reset in three hours - i.e. at 11:49Z, from a window that opened at 06:49Z
 * on the first message after the previous one lapsed. Our clock-aligned block
 * said 05:00Z-10:00Z and reported nearly double the usage. Every expectation
 * below that mentions 06:49 exists to keep that from coming back.
 */
describe('activityAnchoredWindow', () => {
  /** The real chain from that morning, condensed to its shape. */
  const MORNING = [
    '2026-09-11T01:49:00.000Z', // opens the previous window, 01:49 -> 06:49
    '2026-09-11T05:10:00.000Z', // still inside it
    '2026-09-11T06:30:00.000Z', // still inside it
    '2026-09-11T06:49:00.000Z', // exactly on its end: opens the current one
    '2026-09-11T07:30:00.000Z',
    '2026-09-11T08:00:00.000Z',
  ].map(utc);

  const AT_0817 = utc('2026-09-11T08:17:00.000Z');

  it('chains from the first event and returns the window open now', () => {
    const window = activityAnchoredWindow(MORNING, AT_0817);

    expect(window.live).toBe(true);
    if (!window.live) throw new Error('unreachable: asserted live above');
    expect(iso(window.start)).toBe('2026-09-11T06:49:00.000Z');
    expect(iso(window.end)).toBe('2026-09-11T11:49:00.000Z');
  });

  it('disagrees with the clock-aligned block, which is the whole point', () => {
    // A clock-aligned implementation returns 05:00-10:00 here and sweeps in
    // 1h49m of the previous window. If these ever agree again, the fix has
    // been reverted.
    const block = windowBounds('session', AT_0817);
    const window = activityAnchoredWindow(MORNING, AT_0817);

    expect(iso(block.start)).toBe('2026-09-11T05:00:00.000Z');
    if (!window.live) throw new Error('unreachable: the morning chain is live');
    expect(iso(window.start)).not.toBe(iso(block.start));
    expect(iso(window.end)).not.toBe(iso(block.end));
  });

  it("excludes the previous window's usage, which a clock block counts", () => {
    // The measured numbers: 500,000 + 141,223 tokens before the anchor and
    // 709,837 after it. The clock block reports their sum, 1,351,060 - which
    // is what the widget showed the user, against a true 709,837.
    const events = [
      event('2026-09-11T01:49:00.000Z', { id: 'prev-open', tokens: { input: 1_000 } }),
      event('2026-09-11T05:10:00.000Z', { id: 'prev-a', tokens: { input: 500_000 } }),
      event('2026-09-11T06:30:00.000Z', { id: 'prev-b', tokens: { input: 141_223 } }),
      event('2026-09-11T06:49:00.000Z', { id: 'anchor', tokens: { input: 200_000 } }),
      event('2026-09-11T07:30:00.000Z', { id: 'mid', tokens: { input: 300_000 } }),
      event('2026-09-11T08:00:00.000Z', { id: 'last', tokens: { input: 209_837 } }),
    ];

    const window = activityAnchoredWindow(
      events.map((e) => e.at),
      AT_0817,
    );
    if (!window.live) throw new Error('unreachable: the morning chain is live');

    const anchored = sumTokens(eventsInWindow(events, window.start, window.end)).input;
    const block = windowBounds('session', AT_0817);
    const clock = sumTokens(eventsInWindow(events, block.start, block.end)).input;

    expect(anchored).toBe(709_837);
    expect(clock).toBe(1_351_060);
  });

  it('reports no window rather than inventing one when there are no events', () => {
    const window = activityAnchoredWindow([], AT_0817);

    expect(window.live).toBe(false);
    if (window.live) throw new Error('unreachable: asserted not live above');
    expect(window.reason).toBe('no-events');
    expect(window.start).toBeNull();
    expect(window.end).toBeNull();
    expect(window.lastEnd).toBeNull();
  });

  it('reports no window when every event is older than one window', () => {
    const window = activityAnchoredWindow([utc('2026-09-11T01:00:00.000Z')], AT_0817);

    expect(window.live).toBe(false);
    if (window.live) throw new Error('unreachable: asserted not live above');
    expect(window.reason).toBe('expired');
    expect(window.start).toBeNull();
    expect(window.end).toBeNull();
    expect(window.lastEnd).not.toBeNull();
    expect(iso(window.lastEnd ?? AT_0817)).toBe('2026-09-11T06:00:00.000Z');
  });

  it('reports the end of the last window in the CHAIN, not of the last event', () => {
    const window = activityAnchoredWindow(
      [utc('2026-09-10T20:00:00.000Z'), utc('2026-09-11T02:00:00.000Z')],
      AT_0817,
    );

    if (window.live) throw new Error('unreachable: both windows had lapsed by 08:17');
    // 20:00 -> 01:00 lapses; 02:00 opens 02:00 -> 07:00, which lapsed too.
    expect(iso(window.lastEnd ?? AT_0817)).toBe('2026-09-11T07:00:00.000Z');
  });

  it('opens a window on a single event and keeps it for exactly five hours', () => {
    const only = [utc('2026-09-11T06:49:00.000Z')];

    const live = activityAnchoredWindow(only, utc('2026-09-11T11:48:59.999Z'));
    expect(live.live).toBe(true);
    if (!live.live) throw new Error('unreachable: asserted live above');
    expect(iso(live.start)).toBe('2026-09-11T06:49:00.000Z');
    expect(iso(live.end)).toBe('2026-09-11T11:49:00.000Z');

    // Half-open: at the end instant the window is over, not still running.
    const over = activityAnchoredWindow(only, utc('2026-09-11T11:49:00.000Z'));
    expect(over.live).toBe(false);
  });

  it('treats an event exactly on a window end as opening the next window', () => {
    const window = activityAnchoredWindow(
      [utc('2026-09-11T01:49:00.000Z'), utc('2026-09-11T06:49:00.000Z')],
      utc('2026-09-11T07:00:00.000Z'),
    );

    if (!window.live) throw new Error('unreachable: 06:49 opened a window at 07:00');
    expect(iso(window.start)).toBe('2026-09-11T06:49:00.000Z');
    expect(iso(window.end)).toBe('2026-09-11T11:49:00.000Z');
  });

  it('treats an event one millisecond before the end as inside the old window', () => {
    const window = activityAnchoredWindow(
      [utc('2026-09-11T01:49:00.000Z'), utc('2026-09-11T06:48:59.999Z')],
      utc('2026-09-11T06:48:59.999Z'),
    );

    if (!window.live) throw new Error('unreachable: the 01:49 window runs to 06:49');
    expect(iso(window.start)).toBe('2026-09-11T01:49:00.000Z');
    expect(iso(window.end)).toBe('2026-09-11T06:49:00.000Z');
  });

  it('is live when now is exactly the anchoring event', () => {
    const at = utc('2026-09-11T06:49:00.000Z');
    const window = activityAnchoredWindow([at], at);

    if (!window.live) throw new Error('unreachable: the window opens at that instant');
    expect(iso(window.start)).toBe('2026-09-11T06:49:00.000Z');
    expect(iso(window.end)).toBe('2026-09-11T11:49:00.000Z');
  });

  it('honours a custom window length', () => {
    const window = activityAnchoredWindow([utc('2026-09-11T08:00:00.000Z')], AT_0817, {
      hours: 0.5,
    });

    if (!window.live) throw new Error('unreachable: 08:00 + 30m is open at 08:17');
    expect(iso(window.end)).toBe('2026-09-11T08:30:00.000Z');
  });

  it('falls back to the default length when hours is undefined', () => {
    const only = [utc('2026-09-11T06:49:00.000Z')];
    const explicit = activityAnchoredWindow(only, AT_0817, { hours: undefined });
    const implicit = activityAnchoredWindow(only, AT_0817);

    expect(explicit).toEqual(implicit);
    if (!implicit.live) throw new Error('unreachable: asserted live above');
    expect(implicit.end.getTime() - implicit.start.getTime()).toBe(
      DEFAULT_SESSION_HOURS * 3_600_000,
    );
  });

  it('does not trust the input order, and never mutates it', () => {
    const shuffled = [
      utc('2026-09-11T07:30:00.000Z'),
      utc('2026-09-11T01:49:00.000Z'),
      utc('2026-09-11T06:49:00.000Z'),
      utc('2026-09-11T05:10:00.000Z'),
    ];
    const before = shuffled.map(iso);

    const window = activityAnchoredWindow(shuffled, AT_0817);

    if (!window.live) throw new Error('unreachable: the morning chain is live');
    expect(iso(window.start)).toBe('2026-09-11T06:49:00.000Z');
    expect(shuffled.map(iso)).toEqual(before);
  });

  it('skips entries that are not usable dates', () => {
    const stamps = [
      new Date('not a date'),
      utc('2026-09-11T06:49:00.000Z'),
      null,
      undefined,
      '2026-09-11T07:00:00.000Z',
    ] as unknown as Date[];

    const window = activityAnchoredWindow(stamps, AT_0817);

    if (!window.live) throw new Error('unreachable: one good stamp anchors a window');
    expect(iso(window.start)).toBe('2026-09-11T06:49:00.000Z');
  });

  it('ignores a timestamp in the future, which cannot have opened a window', () => {
    const window = activityAnchoredWindow(
      [utc('2026-09-11T23:00:00.000Z'), utc('2026-09-11T01:00:00.000Z')],
      AT_0817,
    );

    if (window.live) throw new Error('unreachable: the only past window lapsed at 06:00');
    expect(window.reason).toBe('expired');
    expect(iso(window.lastEnd ?? AT_0817)).toBe('2026-09-11T06:00:00.000Z');
  });

  it('survives a non-array where timestamps were expected', () => {
    const window = activityAnchoredWindow(undefined as unknown as Date[], AT_0817);
    expect(window.live).toBe(false);
  });

  it('throws for an invalid now', () => {
    expect(() => activityAnchoredWindow([], new Date('not a date'))).toThrow(/valid Date/);
  });

  it('throws for an out-of-range window length', () => {
    expect(() => activityAnchoredWindow([], AT_0817, { hours: 0 })).toThrow(/hours/);
    expect(() => activityAnchoredWindow([], AT_0817, { hours: -1 })).toThrow(/hours/);
    expect(() => activityAnchoredWindow([], AT_0817, { hours: Number.NaN })).toThrow(/hours/);
    expect(() => activityAnchoredWindow([], AT_0817, { hours: Number.POSITIVE_INFINITY })).toThrow(
      /hours/,
    );
    expect(() => activityAnchoredWindow([], AT_0817, { hours: 24 * 32 })).toThrow(/hours/);
  });

  it('restarts the chain after a long idle gap rather than tiling it', () => {
    // Three months of silence, then one message. A tiling implementation would
    // have marched hundreds of windows forward; only one is ever open.
    const window = activityAnchoredWindow(
      [utc('2026-06-01T00:00:00.000Z'), utc('2026-09-11T08:00:00.000Z')],
      AT_0817,
    );

    if (!window.live) throw new Error('unreachable: 08:00 is inside the window');
    expect(iso(window.start)).toBe('2026-09-11T08:00:00.000Z');
  });
});

describe('eventsInWindow', () => {
  const start = utc('2024-03-10T05:00:00.000Z');
  const end = utc('2024-03-10T10:00:00.000Z');

  it('includes an event exactly on the start boundary', () => {
    const onStart = event('2024-03-10T05:00:00.000Z', { id: 'on-start' });
    expect(eventsInWindow([onStart], start, end)).toEqual([onStart]);
  });

  it('excludes an event exactly on the end boundary', () => {
    const onEnd = event('2024-03-10T10:00:00.000Z', { id: 'on-end' });
    expect(eventsInWindow([onEnd], start, end)).toEqual([]);
  });

  it('keeps only the events inside the half-open interval, in order', () => {
    const events = [
      event('2024-03-10T04:59:59.999Z', { id: 'before' }),
      event('2024-03-10T05:00:00.000Z', { id: 'on-start' }),
      event('2024-03-10T07:30:00.000Z', { id: 'middle' }),
      event('2024-03-10T09:59:59.999Z', { id: 'last-ms' }),
      event('2024-03-10T10:00:00.000Z', { id: 'on-end' }),
      event('2024-03-10T18:00:00.000Z', { id: 'after' }),
    ];
    const kept = eventsInWindow(events, start, end);
    expect(kept.map((e) => e.sessionId)).toEqual(['on-start', 'middle', 'last-ms']);
  });

  it('returns the original event objects rather than copies', () => {
    const inside = event('2024-03-10T06:00:00.000Z', { id: 'inside' });
    const kept = eventsInWindow([inside], start, end);
    expect(kept[0]).toBe(inside);
  });

  it('does not mutate or reorder the input array', () => {
    const events = [
      event('2024-03-10T18:00:00.000Z', { id: 'after' }),
      event('2024-03-10T06:00:00.000Z', { id: 'inside' }),
    ];
    const snapshot = [...events];
    eventsInWindow(events, start, end);
    expect(events).toEqual(snapshot);
    expect(events).toHaveLength(2);
  });

  it('returns an empty array for no events', () => {
    expect(eventsInWindow([], start, end)).toEqual([]);
  });

  it('returns nothing for an empty or inverted interval', () => {
    const inside = event('2024-03-10T06:00:00.000Z', { id: 'inside' });
    expect(eventsInWindow([inside], start, start)).toEqual([]);
    expect(eventsInWindow([inside], end, start)).toEqual([]);
  });

  it('skips a record with an unparseable timestamp instead of throwing', () => {
    const broken: UsageEvent = { ...event('2024-03-10T06:00:00.000Z'), at: new Date('garbage') };
    const good = event('2024-03-10T06:00:00.000Z', { id: 'good' });
    const kept = eventsInWindow([broken, good], start, end);
    expect(kept.map((e) => e.sessionId)).toEqual(['good']);
  });

  it('skips a null entry instead of throwing', () => {
    const good = event('2024-03-10T06:00:00.000Z', { id: 'good' });
    const events = [null, good, undefined] as unknown as UsageEvent[];
    expect(eventsInWindow(events, start, end)).toEqual([good]);
  });

  it('throws when a bound is not a valid Date', () => {
    expect(() => eventsInWindow([], new Date('nope'), end)).toThrow(/start must be a valid Date/);
    expect(() => eventsInWindow([], start, new Date('nope'))).toThrow(/end must be a valid Date/);
  });

  it('composes with windowBounds over a day of events', () => {
    const events = [
      event('2024-03-09T23:59:59.999Z', { id: 'yesterday' }),
      event('2024-03-10T00:00:00.000Z', { id: 'midnight' }),
      event('2024-03-10T12:00:00.000Z', { id: 'noon' }),
      event('2024-03-11T00:00:00.000Z', { id: 'tomorrow' }),
    ];
    const day = windowBounds('daily', utc('2024-03-10T12:00:00.000Z'));
    const kept = eventsInWindow(events, day.start, day.end);
    expect(kept.map((e) => e.sessionId)).toEqual(['midnight', 'noon']);
  });
});

describe('sumTokens', () => {
  it('returns all zeros for no events', () => {
    expect(sumTokens([])).toEqual({
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      thinking: 0,
    });
  });

  it('returns a fresh object and never mutates ZERO_TOKENS', () => {
    const first = sumTokens([event('2024-03-10T06:00:00.000Z', { tokens: { input: 7 } })]);
    expect(first.input).toBe(7);
    expect(ZERO_TOKENS).toEqual({
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      thinking: 0,
    });
    expect(sumTokens([]).input).toBe(0);
    expect(first).not.toBe(ZERO_TOKENS);
  });

  it('sums each token class independently', () => {
    // Shapes taken from real assistant records: cache reads dominate by an
    // order of magnitude, which is exactly why there is no grand total here.
    const events = [
      event('2024-03-10T06:00:00.000Z', {
        tokens: { input: 2, output: 178, cacheCreation: 24_408, cacheRead: 30_207, thinking: 0 },
      }),
      event('2024-03-10T06:05:00.000Z', {
        tokens: { input: 5, output: 940, cacheCreation: 1_024, cacheRead: 55_120, thinking: 620 },
      }),
      event('2024-03-10T06:09:00.000Z', {
        tokens: { input: 1, output: 12, cacheCreation: 0, cacheRead: 55_120, thinking: 0 },
      }),
    ];
    expect(sumTokens(events)).toEqual({
      input: 8,
      output: 1_130,
      cacheCreation: 25_432,
      cacheRead: 140_447,
      thinking: 620,
    });
  });

  it('does not mutate the events it sums', () => {
    const one = event('2024-03-10T06:00:00.000Z', { tokens: { input: 3, output: 4 } });
    const snapshot = { ...one.tokens };
    sumTokens([one, one]);
    expect(one.tokens).toEqual(snapshot);
  });

  it('counts the same event twice when it appears twice', () => {
    const one = event('2024-03-10T06:00:00.000Z', { tokens: { input: 3 } });
    expect(sumTokens([one, one]).input).toBe(6);
  });

  it('treats non-finite and negative fields as zero', () => {
    const broken = {
      ...event('2024-03-10T06:00:00.000Z'),
      tokens: {
        input: Number.NaN,
        output: Number.POSITIVE_INFINITY,
        cacheCreation: -50,
        cacheRead: 100,
        thinking: 0,
      },
    } as UsageEvent;
    expect(sumTokens([broken])).toEqual({
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 100,
      thinking: 0,
    });
  });

  it('skips a record whose tokens object is missing or the wrong shape', () => {
    const noTokens = { ...event('2024-03-10T06:00:00.000Z'), tokens: undefined } as unknown as UsageEvent;
    const stringTokens = {
      ...event('2024-03-10T06:00:00.000Z'),
      tokens: 'nope',
    } as unknown as UsageEvent;
    const partial = {
      ...event('2024-03-10T06:00:00.000Z'),
      tokens: { input: 11 },
    } as unknown as UsageEvent;
    const good = event('2024-03-10T06:00:00.000Z', { tokens: { output: 9 } });
    expect(sumTokens([noTokens, stringTokens, partial, good])).toEqual({
      input: 11,
      output: 9,
      cacheCreation: 0,
      cacheRead: 0,
      thinking: 0,
    });
  });

  it('skips null entries', () => {
    const good = event('2024-03-10T06:00:00.000Z', { tokens: { input: 4 } });
    const events = [null, good] as unknown as UsageEvent[];
    expect(sumTokens(events).input).toBe(4);
  });

  it('sums only what eventsInWindow kept', () => {
    const events = [
      event('2024-03-10T04:00:00.000Z', { tokens: { input: 1_000 } }),
      event('2024-03-10T06:00:00.000Z', { tokens: { input: 10 } }),
      event('2024-03-10T09:00:00.000Z', { tokens: { input: 5 } }),
      event('2024-03-10T10:00:00.000Z', { tokens: { input: 1_000 } }),
    ];
    const block = windowBounds('session', utc('2024-03-10T07:00:00.000Z'));
    expect(iso(block.start)).toBe('2024-03-10T05:00:00.000Z');
    expect(sumTokens(eventsInWindow(events, block.start, block.end)).input).toBe(15);
  });
});
