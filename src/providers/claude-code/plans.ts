/**
 * Claude Code plan caps - the honest denominator.
 *
 * ==========================================================================
 *  EVERY NUMBER IN THIS TABLE IS A COMMUNITY ESTIMATE.
 * ==========================================================================
 *
 *  Anthropic does not publish token caps for Claude Code subscriptions.
 *  Nothing in ~/.claude records a rate limit, a plan cap, a quota percentage,
 *  or a window reset time - we looked. The real limits also vary by model
 *  (Opus burns a plan far faster than Sonnet) and by account, and they have
 *  changed without notice. So the figures below are not facts. They are the
 *  numbers the community's usage monitors converged on, rounded, and they
 *  are wrong for somebody.
 *
 *  THIS TABLE IS THE SINGLE REASON EVERY claude-code READING IS `derived`.
 *  The numerator - tokens actually spent - is read straight out of the
 *  session transcripts and is real. The denominator comes from here, which
 *  is why no reading this provider emits may ever claim confidence
 *  `reported`. If some future version learns a cap from the provider itself,
 *  that reading stops consulting this table, and only then may it be
 *  `reported`.
 *
 *  EVERY TOKEN CAP IN THIS TABLE IS null, ON PURPOSE. We know of no honest
 *  figure to put in them, so we ship none, and the CLI shows raw spend with
 *  no percentage. A cap you measured on your own account beats a cap we
 *  guessed, every time - set sessionLimit and weeklyLimit in config.
 *
 *  The per-row comment on the consumer plans records what the estimates were,
 *  how badly they missed against real usage, and why removing them was the
 *  fix rather than tuning them.
 *
 *  null means we genuinely cannot estimate. The CLI must then show raw usage
 *  with no percentage rather than invent one.
 *
 *  The table and its rows are frozen. A config override builds a new
 *  PlanCaps; it never mutates this one.
 */

export type PlanId = 'pro' | 'max-5x' | 'max-20x' | 'team' | 'api' | 'unknown';

export interface PlanCaps {
  id: PlanId;
  /** Human label for a reading, e.g. "Max 20x". */
  label: string;
  /** Estimated token ceiling for one rolling session window. null = unknown. */
  sessionTokens: number | null;
  /** Estimated token ceiling for one rolling week. null = unknown. */
  weeklyTokens: number | null;
  /** Length of Claude Code's rolling session window, in hours. */
  sessionHours: number;
}

const ALL_PLAN_IDS = [
  'pro',
  'max-5x',
  'max-20x',
  'team',
  'api',
  'unknown',
] as const satisfies readonly PlanId[];

/** Compile-time proof that ALL_PLAN_IDS covers every PlanId. */
type EveryPlanIdListed =
  Exclude<PlanId, (typeof ALL_PLAN_IDS)[number]> extends never ? true : never;
const everyPlanIdListed: EveryPlanIdListed = true;
void everyPlanIdListed;

export const PLAN_IDS: readonly PlanId[] = ALL_PLAN_IDS;

/**
 * The usage window is a property of the tool, not of the plan: five hours on
 * every consumer tier. We keep it at five for `api` and `unknown` too, so a
 * "last 5 hours" reading still means something even where we have no
 * denominator to divide it by.
 */
const SESSION_HOURS = 5;

function row(caps: PlanCaps): PlanCaps {
  return Object.freeze(caps);
}

export const PLANS: Record<PlanId, PlanCaps> = Object.freeze({
  // WHY THESE ARE ALL null, AND WHY THAT IS THE POINT
  // -------------------------------------------------
  // They used to hold community estimates: pro 19K/300K, max-5x 88K/1.4M,
  // max-20x 220K/3.5M session/weekly tokens. Measured against a real Max 20x
  // account those figures were wrong by roughly 7x on the session window
  // (1.6M actually spent inside one five-hour block against a 220K "cap"), so
  // the CLI rendered a confident full bar at 100% while the account was
  // nowhere near its limit.
  //
  // A wrong percentage is worse than no percentage. It looks authoritative,
  // it is the single number a user acts on, and being told you are out of
  // quota when you are not is the exact failure this tool exists to prevent.
  //
  // Anthropic publishes no token cap, states weekly limits in hours of model
  // time rather than tokens, and varies the real ceiling by model and account.
  // There is no honest constant to put here. So we put nothing, and the CLI
  // shows raw spend with no bar.
  //
  // Two routes out, neither of which is guessing:
  //   1. Config. Watch for the window where Claude Code actually refuses,
  //      read the token total off `quota --json`, set sessionLimit/weeklyLimit.
  //   2. Calibration, not yet built. Record the high-water mark at the moment
  //      a refusal is observed and learn the ceiling from the account itself.
  //
  // Compare the Codex adapter, which needs none of this: OpenAI writes the
  // real used_percent to disk, so those readings are `reported`, not derived.
  pro: row({
    id: 'pro',
    label: 'Pro',
    sessionTokens: null,
    weeklyTokens: null,
    sessionHours: SESSION_HOURS,
  }),
  'max-5x': row({
    id: 'max-5x',
    label: 'Max 5x',
    sessionTokens: null,
    weeklyTokens: null,
    sessionHours: SESSION_HOURS,
  }),
  'max-20x': row({
    id: 'max-20x',
    label: 'Max 20x',
    sessionTokens: null,
    weeklyTokens: null,
    sessionHours: SESSION_HOURS,
  }),
  team: row({
    // Team seats are provisioned per workspace and an admin can change the
    // Claude Code allowance. No community figure is worth copying here, so
    // we decline to guess: raw usage, no percentage.
    id: 'team',
    label: 'Team',
    sessionTokens: null,
    weeklyTokens: null,
    sessionHours: SESSION_HOURS,
  }),
  api: row({
    // Pay-as-you-go has no subscription cap at all - spend is bounded by
    // billing, not by a token window. Any percentage here would be fiction.
    id: 'api',
    label: 'API (pay as you go)',
    sessionTokens: null,
    weeklyTokens: null,
    sessionHours: SESSION_HOURS,
  }),
  unknown: row({
    // The deliberate all-null row. When we do not know the plan we show what
    // was spent and nothing else. Never give this one estimates.
    id: 'unknown',
    label: 'Unknown plan',
    sessionTokens: null,
    weeklyTokens: null,
    sessionHours: SESSION_HOURS,
  }),
});

/**
 * Spellings we accept for each plan, already normalized (lowercased, with
 * every non-alphanumeric character removed). Deliberately absent: a bare
 * "max". It could mean either Max tier, and picking one would either
 * overstate or understate the user's burn - so it falls through to
 * `unknown`, which shows raw usage instead of a confident wrong number.
 */
const ALIASES: ReadonlyMap<string, PlanId> = new Map<string, PlanId>([
  ['pro', 'pro'],
  ['claudepro', 'pro'],
  ['proplan', 'pro'],

  ['max5x', 'max-5x'],
  ['max5', 'max-5x'],
  ['5x', 'max-5x'],
  ['maxfivex', 'max-5x'],

  ['max20x', 'max-20x'],
  ['max20', 'max-20x'],
  ['20x', 'max-20x'],
  ['maxtwentyx', 'max-20x'],

  ['team', 'team'],
  ['teams', 'team'],
  ['teamplan', 'team'],
  ['teampremium', 'team'],

  ['api', 'api'],
  ['apikey', 'api'],
  ['console', 'api'],
  ['payg', 'api'],
  ['payasyougo', 'api'],

  ['unknown', 'unknown'],
  ['none', 'unknown'],
]);

function normalize(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Look up a plan by whatever the user wrote in config. Tolerant about case,
 * spaces, underscores and hyphens; never throws. Anything we do not
 * recognize - including undefined, an empty string, or an ambiguous "max" -
 * returns the all-null `unknown` row, so the CLI reports raw usage rather
 * than a fabricated percentage.
 */
export function planFor(id: string | undefined): PlanCaps {
  if (id === undefined) return PLANS.unknown;
  const key = normalize(id);
  if (key === '') return PLANS.unknown;
  const resolved = ALIASES.get(key);
  return resolved === undefined ? PLANS.unknown : PLANS[resolved];
}

function isTokenCap(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

/**
 * Runtime guard over the shipped table. Cheap enough for a test to call; it
 * exists so a careless edit to the numbers above cannot ship a table that
 * would make the CLI lie - a fabricated cap on `unknown`, a weekly cap
 * smaller than a session cap, a bigger plan with a smaller ceiling.
 *
 * Throws an Error listing every problem found. Returns void when the table
 * is sound.
 */
export function assertPlanTableShape(): void {
  const problems: string[] = [];

  const tableKeys = Object.keys(PLANS).sort();
  const expectedKeys = [...PLAN_IDS].sort();
  if (tableKeys.join(',') !== expectedKeys.join(',')) {
    problems.push(
      `PLANS keys [${tableKeys.join(', ')}] do not match PLAN_IDS [${expectedKeys.join(', ')}]`,
    );
  }

  if (!Object.isFrozen(PLANS)) {
    problems.push('PLANS is not frozen; a config override could mutate it');
  }

  for (const id of PLAN_IDS) {
    const caps = PLANS[id];
    const where = `PLANS.${id}`;

    if (caps.id !== id) {
      problems.push(`${where}.id is "${caps.id}" but its key is "${id}"`);
    }
    if (typeof caps.label !== 'string' || caps.label.trim() === '') {
      problems.push(`${where}.label must be a non-empty string`);
    }
    if (!Object.isFrozen(caps)) {
      problems.push(`${where} is not frozen`);
    }
    if (!isTokenCap(caps.sessionTokens)) {
      problems.push(
        `${where}.sessionTokens must be null or a positive safe integer, got ${String(caps.sessionTokens)}`,
      );
    }
    if (!isTokenCap(caps.weeklyTokens)) {
      problems.push(
        `${where}.weeklyTokens must be null or a positive safe integer, got ${String(caps.weeklyTokens)}`,
      );
    }
    if (
      caps.sessionTokens !== null &&
      caps.weeklyTokens !== null &&
      caps.weeklyTokens < caps.sessionTokens
    ) {
      problems.push(
        `${where}.weeklyTokens (${caps.weeklyTokens}) is below its own sessionTokens (${caps.sessionTokens})`,
      );
    }
    if (
      !Number.isFinite(caps.sessionHours) ||
      caps.sessionHours <= 0 ||
      caps.sessionHours > 24
    ) {
      problems.push(
        `${where}.sessionHours must be a finite number in (0, 24], got ${String(caps.sessionHours)}`,
      );
    }
  }

  const unknown = PLANS.unknown;
  if (unknown.sessionTokens !== null || unknown.weeklyTokens !== null) {
    problems.push(
      'PLANS.unknown must have all-null caps so an unrecognized plan shows raw usage, never an invented percentage',
    );
  }

  // Bigger plan, bigger ceiling. A regression here would silently mis-scale
  // every percentage we print.
  const ladder: readonly PlanId[] = ['pro', 'max-5x', 'max-20x'];
  for (let i = 1; i < ladder.length; i += 1) {
    const lowerId = ladder[i - 1];
    const higherId = ladder[i];
    if (lowerId === undefined || higherId === undefined) continue;
    const lower = PLANS[lowerId];
    const higher = PLANS[higherId];
    if (
      lower.sessionTokens !== null &&
      higher.sessionTokens !== null &&
      higher.sessionTokens <= lower.sessionTokens
    ) {
      problems.push(
        `PLANS.${higherId}.sessionTokens (${higher.sessionTokens}) must exceed PLANS.${lowerId}.sessionTokens (${lower.sessionTokens})`,
      );
    }
    if (
      lower.weeklyTokens !== null &&
      higher.weeklyTokens !== null &&
      higher.weeklyTokens <= lower.weeklyTokens
    ) {
      problems.push(
        `PLANS.${higherId}.weeklyTokens (${higher.weeklyTokens}) must exceed PLANS.${lowerId}.weeklyTokens (${lower.weeklyTokens})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Claude Code plan table is malformed:\n- ${problems.join('\n- ')}`);
  }
}
