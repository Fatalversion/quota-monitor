/**
 * quota-monitor's public API.
 *
 * One widget for every AI subscription you are burning through. Everything
 * here is local-first and read-only: this package opens other tools' log
 * files, never their credentials, and makes no network call of any kind.
 *
 * ```ts
 * import {
 *   claudeCodeAdapter, codexAdapter, collect, createRegistry, loadConfig,
 *   defaultSecretStore, renderAll,
 * } from 'quota-monitor';
 *
 * const { config } = await loadConfig(homedir());
 * const registry = createRegistry([claudeCodeAdapter, codexAdapter]);
 * const now = new Date();
 *
 * const results = await collect(registry.enabled(config.providers), (adapter) => ({
 *   now: () => now,
 *   homeDir: homedir(),
 *   options: config.providers[adapter.id] ?? { enabled: true },
 *   secrets: defaultSecretStore(),
 *   debug: () => {},
 * }));
 *
 * console.log(renderAll(results, now));
 * ```
 *
 * THE HONESTY RULE, restated here because it is the point of the library:
 * a `QuotaReading` whose denominator we supplied is `confidence: 'derived'`,
 * and the renderer marks those percentages with a leading `~`. Nothing in
 * `~/.claude` records a plan cap, so every Claude Code percentage is derived.
 * Codex is the other case: OpenAI writes its own `used_percent` into the
 * rollout logs, so those readings are `unit: 'percent'`, `limit: 100` and
 * `confidence: 'reported'`, and they must render without the `~`. Consumers
 * building their own UI must preserve that distinction in both directions.
 *
 * The re-exports below are explicit rather than `export *` so this file is the
 * readable definition of the supported surface. Anything reachable only by a
 * deep import is internal and may change without a major version.
 */

/* -------------------------------------------------------------------------- */
/* core contract                                                              */
/* -------------------------------------------------------------------------- */

export { ZERO_TOKENS, percentUsed } from './core/types.js';
export type {
  AdapterContext,
  AdapterResult,
  Confidence,
  QuotaAdapter,
  QuotaReading,
  QuotaUnit,
  QuotaWindow,
  SecretStore,
  TokenCounts,
  UsageEvent,
} from './core/types.js';

/* -------------------------------------------------------------------------- */
/* window arithmetic                                                          */
/* -------------------------------------------------------------------------- */

export {
  DEFAULT_SESSION_HOURS,
  DEFAULT_WEEK_STARTS_ON,
  activityAnchoredWindow,
  eventsInWindow,
  sumTokens,
  windowBounds,
} from './core/window.js';
export type {
  AnchoredWindow,
  AnchoredWindowOptions,
  WindowBoundsOptions,
  WindowRange,
  WindowSpec,
} from './core/window.js';

/* -------------------------------------------------------------------------- */
/* pricing                                                                    */
/* -------------------------------------------------------------------------- */

export { MODEL_PRICES, estimateCostUsd, priceFor } from './core/pricing.js';
export type { ModelPrice } from './core/pricing.js';

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

export { CONFIG_ENV_VAR, DEFAULT_CONFIG, configPath, loadConfig, parseConfig } from './core/config.js';
export type {
  AlertThresholds,
  LoadedConfig,
  ProviderOptions,
  QuotaConfig,
  WidgetConfig,
} from './core/config.js';

/* -------------------------------------------------------------------------- */
/* secrets                                                                    */
/* -------------------------------------------------------------------------- */

export {
  MemorySecretStore,
  NullSecretStore,
  OsKeychainSecretStore,
  defaultSecretStore,
} from './core/secrets.js';
export type { KeychainBackend } from './core/secrets.js';

/* -------------------------------------------------------------------------- */
/* registry and fan-out                                                       */
/* -------------------------------------------------------------------------- */

export { AdapterRegistry, collect, createRegistry } from './core/registry.js';
export type { AdapterContextFactory } from './core/registry.js';

/* -------------------------------------------------------------------------- */
/* rendering                                                                  */
/* -------------------------------------------------------------------------- */

export {
  DEFAULT_BAR_WIDTH,
  bar,
  formatCountdown,
  formatPercent,
  formatTokens,
  formatUsd,
  renderAll,
  renderReading,
} from './cli/render.js';
export type { RenderOptions } from './cli/render.js';

/* -------------------------------------------------------------------------- */
/* providers                                                                  */
/* -------------------------------------------------------------------------- */

export {
  DISPLAY_NAME as CLAUDE_CODE_DISPLAY_NAME,
  MAX_TRANSCRIPT_FILES,
  PROVIDER_ID as CLAUDE_CODE_PROVIDER_ID,
  claudeCodeAdapter,
} from './providers/claude-code/index.js';
export type { ClaudeCodeOptions } from './providers/claude-code/index.js';

export { PLANS, PLAN_IDS, assertPlanTableShape, planFor } from './providers/claude-code/plans.js';
export type { PlanCaps, PlanId } from './providers/claude-code/plans.js';

export { coerceTokens, parseLine } from './providers/claude-code/parse.js';
export {
  CLAUDE_CONFIG_DIR_ENV,
  claudeHomeDir,
  decodeProjectDir,
  listTranscripts,
  streamLines,
} from './providers/claude-code/transcripts.js';
export type { ListTranscriptsOptions } from './providers/claude-code/transcripts.js';

/**
 * Codex - the first adapter whose percentages are `reported` rather than
 * `derived`, because OpenAI writes `used_percent` into the rollout logs itself.
 *
 * `rollouts.ts` also exports a `streamLines`, deliberately not re-exported
 * here: one barrel cannot carry two functions of that name, and silently
 * picking a winner would be worse than making the deep import explicit for the
 * handful of callers who want to stream a rollout themselves.
 */
export {
  DISPLAY_NAME as CODEX_DISPLAY_NAME,
  MAX_ROLLOUT_FILES,
  PERCENT_LIMIT as CODEX_PERCENT_LIMIT,
  PROVIDER_ID as CODEX_PROVIDER_ID,
  codexAdapter,
} from './providers/codex/index.js';
export type { CodexOptions } from './providers/codex/index.js';

export { parseRateLimitLine, planLabel } from './providers/codex/parse.js';
export type { RateSnapshot, RateWindow } from './providers/codex/parse.js';

export {
  CODEX_HOME_ENV,
  DEFAULT_ROLLOUT_LIMIT,
  codexHomeDir,
  listRollouts,
} from './providers/codex/rollouts.js';
export type {
  ListRolloutsOptions,
  RolloutEntry,
  RolloutSelection,
} from './providers/codex/rollouts.js';
