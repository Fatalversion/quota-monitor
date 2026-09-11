/**
 * Work out which Claude plan the user is on, without asking them.
 *
 * Claude Code writes account metadata to `~/.claude.json` in plain text. Two
 * fields are relevant, and they are NOT interchangeable:
 *
 *   organizationRateLimitTier  "default_claude_max_20x"   <- carries the multiplier
 *   organizationType           "claude_max"               <- family only, no multiplier
 *
 * Max 5x and Max 20x have very different caps, so the family alone cannot pick
 * a denominator. We read the rate-limit tier first, fall back to the type as a
 * coarse hint, and fall back again to `unknown`, which makes the CLI show raw
 * usage with no percentage rather than a fabricated one.
 *
 * READ-ONLY AND CREDENTIAL-FREE. `~/.claude.json` is ordinary configuration and
 * holds no token. The adjacent `~/.claude/.credentials.json` DOES hold an OAuth
 * token, and this module must never open it. Reading another tool's stored
 * credential is off limits for this project even though it is local, easy, and
 * would remove the last bit of setup. That line is deliberate. Do not move it.
 *
 * The shape below is undocumented and can change without notice, so every read
 * is defensive and any failure degrades to `unknown` rather than throwing.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PlanId } from './plans.js';

/** Filename we read. Sibling of the credentials file we deliberately do not. */
export const ACCOUNT_FILE = '.claude.json';

/** Never open a path matching this, whatever else changes. */
const FORBIDDEN = /(^|[\\/])\.credentials\.json$|\.key$/i;

export interface DetectedPlan {
  plan: PlanId;
  /** Which field produced the answer, for the --verbose explanation. */
  source: 'rate-limit-tier' | 'organization-type' | 'none';
  /** Raw value we matched on, so a mismatch is diagnosable from a bug report. */
  raw: string | null;
}

export const UNDETECTED: Readonly<DetectedPlan> = Object.freeze({
  plan: 'unknown' as PlanId,
  source: 'none' as const,
  raw: null,
});

/**
 * Map a rate-limit tier string onto a PlanId.
 *
 * Matching is substring-based on purpose: the observed value is
 * `default_claude_max_20x`, but the `default_` prefix is clearly a variant
 * marker and we should not break the moment a different prefix appears. Order
 * matters, 20x must be tested before 5x before the bare family.
 */
export function planFromRateLimitTier(tier: string): PlanId | null {
  const t = tier.toLowerCase();
  if (!t.includes('claude')) return null;
  if (t.includes('max_20x') || t.includes('max-20x')) return 'max-20x';
  if (t.includes('max_5x') || t.includes('max-5x')) return 'max-5x';
  if (t.includes('team')) return 'team';
  if (t.includes('pro')) return 'pro';
  return null;
}

/**
 * Coarse fallback. `claude_max` with no multiplier is genuinely ambiguous, so
 * we return null rather than guessing 5x or 20x and being wrong half the time.
 */
export function planFromOrganizationType(type: string): PlanId | null {
  const t = type.toLowerCase();
  if (t === 'claude_pro') return 'pro';
  if (t === 'claude_team') return 'team';
  if (t === 'claude_enterprise') return 'team';
  if (t === 'api') return 'api';
  return null;
}

/** Pull a string field out of an unknown object without trusting anything. */
function str(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Parse already-loaded JSON text. Split out so tests need no filesystem. */
export function detectPlanFromJson(raw: string): DetectedPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNDETECTED;
  }

  const account =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['oauthAccount']
      : null;

  const tier = str(account, 'organizationRateLimitTier');
  if (tier !== null) {
    const plan = planFromRateLimitTier(tier);
    if (plan !== null) return { plan, source: 'rate-limit-tier', raw: tier };
  }

  const type = str(account, 'organizationType');
  if (type !== null) {
    const plan = planFromOrganizationType(type);
    if (plan !== null) return { plan, source: 'organization-type', raw: type };
    // A known family with an unknown multiplier. Better to admit it.
    if (type.startsWith('claude_')) {
      return { plan: 'unknown', source: 'organization-type', raw: type };
    }
  }

  return UNDETECTED;
}

/**
 * Read `~/.claude.json` and work out the plan. Never throws: a missing file,
 * a permission error, or an unrecognised shape all yield `unknown`.
 */
export async function detectPlan(homeDir: string): Promise<DetectedPlan> {
  const file = join(homeDir, ACCOUNT_FILE);
  if (FORBIDDEN.test(file)) return UNDETECTED;

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return UNDETECTED;
  }
  return detectPlanFromJson(raw);
}
