import { describe, it, expect } from 'vitest';
import { percentUsed } from '../../core/types.js';
import type { QuotaReading } from '../../core/types.js';
import {
  PLANS,
  PLAN_IDS,
  assertPlanTableShape,
  planFor,
} from './plans.js';
import type { PlanCaps, PlanId } from './plans.js';

describe('the plan table', () => {
  it('passes its own shape guard', () => {
    expect(() => assertPlanTableShape()).not.toThrow();
  });

  it('lists every plan id exactly once', () => {
    expect([...PLAN_IDS].sort()).toEqual([
      'api',
      'max-20x',
      'max-5x',
      'pro',
      'team',
      'unknown',
    ]);
    expect(new Set(PLAN_IDS).size).toBe(PLAN_IDS.length);
    expect(Object.keys(PLANS).sort()).toEqual([...PLAN_IDS].sort());
  });

  it('keys every row by its own id and gives it a label', () => {
    for (const id of PLAN_IDS) {
      const caps: PlanCaps = PLANS[id];
      expect(caps.id).toBe(id);
      expect(caps.label.trim()).not.toBe('');
    }
  });

  it('uses a five hour session window on every plan', () => {
    for (const id of PLAN_IDS) {
      expect(PLANS[id].sessionHours).toBe(5);
    }
  });

  it('is frozen, so a config override cannot mutate the shipped numbers', () => {
    expect(Object.isFrozen(PLANS)).toBe(true);
    for (const id of PLAN_IDS) {
      expect(Object.isFrozen(PLANS[id])).toBe(true);
    }
  });

  it('ships no token cap for any plan at all', () => {
    // This replaced a monotonicity check over community estimates. Those
    // estimates were measured against a real Max 20x account and missed by
    // roughly 7x on the session window, which made the CLI show a confident
    // 100% bar on an account nowhere near its limit. Shipping nothing is the
    // fix; tuning the numbers was not, because no honest constant exists.
    for (const id of PLAN_IDS) {
      expect(PLANS[id].sessionTokens).toBeNull();
      expect(PLANS[id].weeklyTokens).toBeNull();
    }
  });

  it('never estimates a weekly cap below its own session cap', () => {
    for (const id of PLAN_IDS) {
      const { sessionTokens, weeklyTokens } = PLANS[id];
      if (sessionTokens === null || weeklyTokens === null) continue;
      expect(weeklyTokens).toBeGreaterThanOrEqual(sessionTokens);
    }
  });
});

describe('honesty invariants', () => {
  it('leaves "unknown" with no caps at all', () => {
    expect(PLANS.unknown.sessionTokens).toBeNull();
    expect(PLANS.unknown.weeklyTokens).toBeNull();
  });

  it('declines to guess a cap for team seats or pay-as-you-go', () => {
    for (const id of ['team', 'api'] as const) {
      expect(PLANS[id].sessionTokens).toBeNull();
      expect(PLANS[id].weeklyTokens).toBeNull();
    }
  });

  it('yields no percentage when the plan has no cap', () => {
    const caps = planFor('team');
    const reading: QuotaReading = {
      provider: 'claude-code',
      label: caps.label,
      window: 'session',
      used: 412_000,
      limit: caps.sessionTokens,
      unit: 'tokens',
      windowStart: '2026-09-11T00:00:00.000Z',
      resetsAt: null,
      confidence: 'derived',
    };
    expect(percentUsed(reading)).toBeNull();
  });

  it('offers no denominator of its own, so a table-only reading has no percentage', () => {
    const caps = planFor('max-5x');
    expect(caps.sessionTokens).toBeNull();

    const reading: QuotaReading = {
      provider: 'claude-code',
      label: caps.label,
      window: 'session',
      used: 44_000,
      limit: caps.sessionTokens,
      unit: 'tokens',
      windowStart: '2026-09-11T00:00:00.000Z',
      resetsAt: '2026-09-11T05:00:00.000Z',
      confidence: 'derived',
      note: 'No published cap. Set sessionLimit in config to get a percentage.',
    };
    expect(percentUsed(reading)).toBeNull();
  });

  it('yields a percentage only from a cap the user supplied, still marked derived', () => {
    const caps = planFor('max-5x');
    // 88_000 is a figure the user measured on their own account and wrote to
    // config. It is not ours, and it is why the reading can show a bar.
    const measuredByUser = 88_000;
    const reading: QuotaReading = {
      provider: 'claude-code',
      label: caps.label,
      window: 'session',
      used: 44_000,
      limit: measuredByUser,
      unit: 'tokens',
      windowStart: '2026-09-11T00:00:00.000Z',
      resetsAt: '2026-09-11T05:00:00.000Z',
      confidence: 'derived',
      note: 'Cap supplied in config by the user, not published by Anthropic.',
    };
    // Still derived: a user-measured ceiling is not a provider-reported one.
    expect(reading.confidence).toBe('derived');
    expect(percentUsed(reading)).toBeCloseTo(50, 5);
  });
});

describe('planFor', () => {
  it('resolves the canonical ids', () => {
    for (const id of PLAN_IDS) {
      expect(planFor(id)).toBe(PLANS[id]);
    }
  });

  it('ignores case, spaces, underscores and hyphens', () => {
    const spellings: ReadonlyArray<readonly [string, PlanId]> = [
      ['Pro', 'pro'],
      ['  PRO  ', 'pro'],
      ['Max 5x', 'max-5x'],
      ['max_5x', 'max-5x'],
      ['MAX5', 'max-5x'],
      ['5x', 'max-5x'],
      ['Max 20x', 'max-20x'],
      ['max_20', 'max-20x'],
      ['  MAX-20X ', 'max-20x'],
      ['Team', 'team'],
      ['teams', 'team'],
      ['API', 'api'],
      ['pay-as-you-go', 'api'],
    ];
    for (const [input, expected] of spellings) {
      expect(planFor(input).id).toBe(expected);
    }
  });

  it('falls back to "unknown" rather than throwing or guessing', () => {
    for (const input of [undefined, '', '   ', '!!!', 'enterprise', 'max-100x', 'sonnet']) {
      expect(planFor(input)).toBe(PLANS.unknown);
    }
  });

  it('treats a bare "max" as ambiguous, not as a tier', () => {
    // Choosing a tier here would either overstate or understate the burn.
    expect(planFor('max').id).toBe('unknown');
    expect(planFor('Max').sessionTokens).toBeNull();
  });
});
