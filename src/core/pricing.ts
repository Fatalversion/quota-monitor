/**
 * Cost estimation from token counts.
 *
 * Every dollar figure this module produces is an *estimate*. The token
 * numerator comes from a tool's own local logs; the price denominator comes
 * from the table below, which we typed in by hand. Any `QuotaReading` whose
 * `estimatedCostUsd` was filled in from here is therefore `confidence:
 * 'derived'` and must be rendered as an estimate.
 */

import type { TokenCounts } from './types.js';

/** USD per one million tokens, split by how the API bills each token class. */
export interface ModelPrice {
  /** Fresh, uncached input tokens. */
  inputPerMTok: number;
  /** Generated output tokens. Thinking tokens are already inside this count. */
  outputPerMTok: number;
  /** Tokens written into the prompt cache. Assumes the default 5-minute TTL. */
  cacheWritePerMTok: number;
  /** Tokens served from the prompt cache. Cheapest class by a wide margin. */
  cacheReadPerMTok: number;
}

/**
 * LIST PRICES. THESE DRIFT.
 *
 * This table is the single source of every 'derived' cost figure in
 * quota-monitor. It is a hand-maintained snapshot of Anthropic's first-party
 * API list prices, last checked 2026-09-11. Vendors change prices, add tiers,
 * and retire models without warning, and partner-operated platforms (Amazon
 * Bedrock, Google Vertex AI) bill at their own separate rates that are NOT
 * reflected here.
 *
 * MAINTAINER: this table, in this file (src/core/pricing.ts), is the only
 * place to update. Check https://www.anthropic.com/pricing (or the Anthropic
 * API pricing docs) and edit the entries below. Do not scatter prices into
 * adapters, and do not invent an entry for a model you have not looked up -
 * `priceFor` returning undefined is the correct, honest answer for a model we
 * do not have a verified price for.
 *
 * Conventions used when filling in the two cache columns:
 *   - cache write is 1.25x the input rate (default 5-minute TTL; a 1-hour TTL
 *     costs 2x input and we do not model it, so long-TTL usage is UNDER-priced)
 *   - cache read is 0.1x the input rate, EXCEPT claude-fable-5-1, which
 *     Anthropic prices at a flat $0.25/MTok. That row is deliberately not
 *     0.1x - please do not "correct" it.
 *
 * Keys must be the canonical, undated model id. Dated and versioned ids
 * (e.g. "claude-opus-5-20260101") resolve to their base entry via the
 * longest-prefix match in `priceFor`, so they do not need their own rows.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Claude 5 family
  'claude-opus-5': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
  },
  'claude-sonnet-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheWritePerMTok: 2.5,
    cacheReadPerMTok: 0.2,
  },
  'claude-fable-5-1': {
    inputPerMTok: 10.0,
    outputPerMTok: 50.0,
    cacheWritePerMTok: 12.5,
    // Flat rate, not 0.1x input. See the note above.
    cacheReadPerMTok: 0.25,
  },

  // Previous generation, still widely used for cheap/background work.
  'claude-haiku-4-5': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
};

/**
 * Look up a price by model id.
 *
 * Handles versioned and dated ids by longest-prefix match, so both
 * "claude-opus-5" and "claude-opus-5-20260101" resolve to the same entry. The
 * prefix must end on a '-' segment boundary, so "claude-opus-50" - a different
 * model that merely starts with the same characters - does NOT match.
 *
 * Returns undefined for anything we do not have a verified price for. Never
 * guesses: a wrong price is worse than no price, because the caller can render
 * "cost unknown" but cannot un-mislead someone who saw a fabricated number.
 */
export function priceFor(model: string): ModelPrice | undefined {
  const id = model.trim().toLowerCase();
  if (id.length === 0) return undefined;

  const exact = MODEL_PRICES[id];
  if (exact !== undefined) return exact;

  let bestKeyLength = 0;
  let best: ModelPrice | undefined;

  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (key.length <= bestKeyLength) continue;
    if (!id.startsWith(key)) continue;
    // id is strictly longer than key here (the exact hit was handled above),
    // so charAt is in range. Require a segment boundary.
    if (id.charAt(key.length) !== '-') continue;
    bestKeyLength = key.length;
    best = price;
  }

  return best;
}

/**
 * Clamp a token count to something billable.
 *
 * Fail soft: a malformed log record that yielded NaN, Infinity, or a negative
 * count must not poison the whole estimate with NaN. It contributes zero.
 */
function billable(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count;
}

/** Divisor for "per million tokens" rates. */
const PER_MILLION = 1_000_000;

/**
 * Estimate the USD cost of one call's token usage.
 *
 * Returns null when the model is unknown - the caller should show "cost
 * unknown" rather than zero, because zero reads as "this was free".
 *
 * NOTE ON THINKING TOKENS: `tokens.thinking` is deliberately NOT billed here.
 * The providers already count thinking tokens inside `output_tokens` (Claude
 * Code records them as `usage.output_tokens_details.thinking_tokens`, a
 * breakdown *of* `output_tokens`, not an addition to it). Billing them again
 * would double-charge every reasoning turn. The field is carried on
 * TokenCounts for display and analysis only.
 */
export function estimateCostUsd(model: string, tokens: TokenCounts): number | null {
  const price = priceFor(model);
  if (price === undefined) return null;

  // Sum in "USD per million tokens" units, then divide once at the end.
  const usdPerMillion =
    billable(tokens.input) * price.inputPerMTok +
    billable(tokens.output) * price.outputPerMTok +
    billable(tokens.cacheCreation) * price.cacheWritePerMTok +
    billable(tokens.cacheRead) * price.cacheReadPerMTok;

  return usdPerMillion / PER_MILLION;
}
