import { describe, it, expect } from 'vitest';

import { MODEL_PRICES, estimateCostUsd, priceFor } from './pricing.js';
import { ZERO_TOKENS } from './types.js';
import type { TokenCounts } from './types.js';

/** Build a TokenCounts without repeating every zero field. */
function tokens(partial: Partial<TokenCounts>): TokenCounts {
  return { ...ZERO_TOKENS, ...partial };
}

describe('priceFor', () => {
  it('resolves a known model exactly', () => {
    const price = priceFor('claude-opus-5');
    expect(price).toBeDefined();
    expect(price?.inputPerMTok).toBe(5.0);
    expect(price?.outputPerMTok).toBe(25.0);
    expect(price?.cacheWritePerMTok).toBe(6.25);
    expect(price?.cacheReadPerMTok).toBe(0.5);
  });

  it('resolves a dated id to its base entry by longest-prefix match', () => {
    expect(priceFor('claude-opus-5-20260101')).toBe(MODEL_PRICES['claude-opus-5']);
    expect(priceFor('claude-sonnet-5-20260214')).toBe(MODEL_PRICES['claude-sonnet-5']);
    expect(priceFor('claude-haiku-4-5-20251001')).toBe(MODEL_PRICES['claude-haiku-4-5']);
  });

  it('matches the longest key and does not fall back to a shorter family name', () => {
    // 'claude-fable-5-1' is a table key; a dated variant of it must land there.
    expect(priceFor('claude-fable-5-1-20260301')).toBe(MODEL_PRICES['claude-fable-5-1']);
    // 'claude-fable-5' is a *different*, unpriced model. It must not borrow
    // the 5.1 price just because 5.1's key starts with those characters.
    expect(priceFor('claude-fable-5')).toBeUndefined();
  });

  it('only matches on a segment boundary, never mid-token', () => {
    expect(priceFor('claude-opus-50')).toBeUndefined();
    expect(priceFor('claude-opus-5x')).toBeUndefined();
    expect(priceFor('claude-sonnet-55-20260101')).toBeUndefined();
  });

  it('normalizes surrounding whitespace and case', () => {
    expect(priceFor('  Claude-Opus-5  ')).toBe(MODEL_PRICES['claude-opus-5']);
  });

  it('returns undefined for an unknown model rather than guessing', () => {
    expect(priceFor('gpt-5-codex')).toBeUndefined();
    expect(priceFor('some-model-we-never-heard-of')).toBeUndefined();
    expect(priceFor('')).toBeUndefined();
    expect(priceFor('   ')).toBeUndefined();
  });

  it('prices every table entry with finite, sanely ordered rates', () => {
    for (const [id, price] of Object.entries(MODEL_PRICES)) {
      expect(Number.isFinite(price.inputPerMTok), id).toBe(true);
      expect(price.inputPerMTok, id).toBeGreaterThan(0);
      // Output always costs more than input; cache read always costs least.
      expect(price.outputPerMTok, id).toBeGreaterThan(price.inputPerMTok);
      expect(price.cacheWritePerMTok, id).toBeGreaterThan(price.inputPerMTok);
      expect(price.cacheReadPerMTok, id).toBeLessThan(price.inputPerMTok);
      expect(price.cacheReadPerMTok, id).toBeGreaterThan(0);
    }
  });
});

describe('estimateCostUsd', () => {
  it('returns null for an unknown model', () => {
    expect(estimateCostUsd('gpt-5-codex', tokens({ input: 1000, output: 1000 }))).toBeNull();
    expect(estimateCostUsd('', ZERO_TOKENS)).toBeNull();
  });

  it('returns 0 - not null - for zero tokens on a known model', () => {
    const cost = estimateCostUsd('claude-opus-5', ZERO_TOKENS);
    expect(cost).toBe(0);
  });

  it('matches a hand-computed figure for a realistic Claude Code call', () => {
    // Verbatim usage object from a real ~/.claude session transcript:
    //   input_tokens: 2, cache_creation_input_tokens: 24408,
    //   cache_read_input_tokens: 30207, output_tokens: 178
    //
    // Hand arithmetic against the claude-opus-5 row, in USD-per-million units:
    //         2 tokens x  $5.00 =        10
    //       178 tokens x $25.00 =      4450
    //     24408 tokens x  $6.25 =    152550
    //     30207 tokens x  $0.50 =     15103.5
    //                     total =    172113.5  ->  / 1e6  =  $0.1721135
    const cost = estimateCostUsd(
      'claude-opus-5',
      tokens({ input: 2, output: 178, cacheCreation: 24408, cacheRead: 30207 }),
    );
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(0.1721135, 10);
  });

  it('applies the dated-id prefix match when costing', () => {
    const usage = tokens({ input: 2, output: 178, cacheCreation: 24408, cacheRead: 30207 });
    expect(estimateCostUsd('claude-opus-5-20260101', usage)).toBe(
      estimateCostUsd('claude-opus-5', usage),
    );
  });

  it('does not bill thinking tokens a second time', () => {
    // Thinking tokens are a breakdown of output_tokens upstream, so adding
    // them must not change the cost by one cent.
    const withoutThinking = tokens({ input: 100, output: 5000 });
    const withThinking = tokens({ input: 100, output: 5000, thinking: 4200 });
    expect(estimateCostUsd('claude-opus-5', withThinking)).toBe(
      estimateCostUsd('claude-opus-5', withoutThinking),
    );
  });

  it('prices each token class at its own rate', () => {
    // 1M cache-read tokens on opus-5 is $0.50; 1M fresh input tokens is $5.00.
    expect(estimateCostUsd('claude-opus-5', tokens({ cacheRead: 1_000_000 }))).toBeCloseTo(0.5, 12);
    expect(estimateCostUsd('claude-opus-5', tokens({ input: 1_000_000 }))).toBeCloseTo(5.0, 12);
    expect(estimateCostUsd('claude-opus-5', tokens({ output: 1_000_000 }))).toBeCloseTo(25.0, 12);
    expect(estimateCostUsd('claude-opus-5', tokens({ cacheCreation: 1_000_000 }))).toBeCloseTo(
      6.25,
      12,
    );
  });

  it('costs the cheaper models proportionally lower', () => {
    const usage = tokens({ input: 1_000_000, output: 1_000_000 });
    const opus = estimateCostUsd('claude-opus-5', usage);
    const sonnet = estimateCostUsd('claude-sonnet-5', usage);
    const haiku = estimateCostUsd('claude-haiku-4-5', usage);
    const fable = estimateCostUsd('claude-fable-5-1', usage);
    expect(opus).toBe(30);
    expect(sonnet).toBe(12);
    expect(haiku).toBe(6);
    expect(fable).toBe(60);
  });

  it('fails soft on malformed token counts instead of returning NaN', () => {
    const malformed: TokenCounts = {
      input: Number.NaN,
      output: 178,
      cacheCreation: Number.POSITIVE_INFINITY,
      cacheRead: -5,
      thinking: Number.NaN,
    };
    const cost = estimateCostUsd('claude-opus-5', malformed);
    expect(cost).not.toBeNull();
    expect(Number.isFinite(cost as number)).toBe(true);
    // Only the one well-formed field survives: 178 x $25.00 / 1e6.
    expect(cost).toBeCloseTo(0.00445, 12);
  });
});
