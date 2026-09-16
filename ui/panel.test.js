import { describe, expect, it } from 'vitest';

import { COMPACT_AT, collapsedMode, windowsFor } from './panel.js';

/**
 * The collapsed layouts are chosen by how many providers there are, and that
 * decision is the one thing in this file worth pinning: everything else it does
 * needs a DOM, but which SHAPE to draw is arithmetic, and getting it wrong is
 * how a four-provider dock ends up wider than the screen.
 */
describe('choosing a collapsed layout', () => {
  it('gives one provider the detailed shape', () => {
    // Nothing to compare against, so the room buys both windows instead.
    expect(collapsedMode(1)).toBe('single');
    // Zero never reaches it - the renderers draw a placeholder first - but it
    // must not fall through to the compact branch if it ever does.
    expect(collapsedMode(0)).toBe('single');
  });

  it('gives two providers a bar each', () => {
    expect(collapsedMode(2)).toBe('bars');
  });

  it('goes compact at three, and stays there', () => {
    expect(collapsedMode(COMPACT_AT)).toBe('compact');
    for (const count of [3, 4, 5, 9]) expect(collapsedMode(count)).toBe('compact');
  });

  it('switches exactly once, at the documented count', () => {
    // A threshold that drifts from the comment is how two views stop agreeing.
    expect(COMPACT_AT).toBe(3);
    expect(collapsedMode(COMPACT_AT - 1)).not.toBe('compact');
  });
});

const reading = (window, used, extra = {}) => ({
  provider: 'claude-code',
  label: 'Max 20x',
  window,
  used,
  limit: 100,
  unit: 'percent',
  windowStart: null,
  resetsAt: null,
  confidence: 'reported',
  ...extra,
});

describe('which windows a single provider shows', () => {
  const result = {
    ok: true,
    id: 'claude-code',
    readings: [reading('weekly', 85), reading('session', 7)],
  };

  it('puts the shortest window first, whatever order they arrive in', () => {
    // The session is the one that moves fastest and the one a reader checks
    // first; the array is whatever the adapter happened to emit.
    expect(windowsFor(result).map((w) => w.window)).toEqual(['session', 'weekly']);
  });

  it('labels them short enough for a 72px rail', () => {
    expect(windowsFor(result).map((w) => w.short)).toEqual(['5h', '7d']);
  });

  it('carries the status each window earns', () => {
    expect(windowsFor(result).map((w) => w.status)).toEqual(['ok', 'warn']);
  });

  it('leaves out a per-model limit', () => {
    // A scoped reading is a real number but not one of the plan's own windows.
    // Two rows labelled "7d" that disagree is the confusion `scope` prevents.
    const scoped = {
      ok: true,
      id: 'claude-code',
      readings: [reading('session', 7), reading('weekly', 85), reading('weekly', 76, { scope: 'Fable' })],
    };
    expect(windowsFor(scoped)).toHaveLength(2);
    expect(windowsFor(scoped).every((w) => w.pct !== 76)).toBe(true);
  });

  it('skips a reading with no honest percentage', () => {
    const noCap = {
      ok: true,
      id: 'claude-code',
      readings: [reading('session', 500_000, { limit: null, unit: 'tokens' }), reading('weekly', 85)],
    };
    expect(windowsFor(noCap).map((w) => w.window)).toEqual(['weekly']);
  });

  it('takes at most two, because that is what the room holds', () => {
    const many = {
      ok: true,
      id: 'x',
      readings: [reading('session', 1), reading('daily', 2), reading('weekly', 3), reading('monthly', 4)],
    };
    expect(windowsFor(many).map((w) => w.window)).toEqual(['session', 'daily']);
    expect(windowsFor(many, 3).map((w) => w.window)).toEqual(['session', 'daily', 'weekly']);
  });

  it('answers with nothing for a provider that failed', () => {
    expect(windowsFor({ ok: false, id: 'x', error: 'boom' })).toEqual([]);
    expect(windowsFor(undefined)).toEqual([]);
  });
});
