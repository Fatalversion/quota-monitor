/**
 * The contract every provider adapter implements.
 *
 * Design note on `confidence`: local log files tell us what was *spent*. They
 * almost never tell us the *cap*. Any reading whose denominator came from
 * configuration, a published price sheet, or our own arithmetic is `derived`
 * and must say so. Only a figure the provider itself reports as a percentage
 * or remaining balance is `reported`.
 */

/** Token counts as coding agents record them per API call. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  thinking: number;
}

export const ZERO_TOKENS: Readonly<TokenCounts> = Object.freeze({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
  thinking: 0,
});

/**
 * A single normalized API call, whatever tool produced it.
 *
 * `requestId` and `messageId` exist so a caller can tell two records of the
 * SAME call apart from two different calls. Coding agents routinely write one
 * log record per content block of a single response, repeating the whole
 * cumulative `usage` object on each, so a consumer that sums records rather
 * than calls overcounts by however many blocks the response happened to have.
 * See `dedupeEvents` in the Claude Code adapter for the de-duplication these
 * two fields make possible.
 */
export interface UsageEvent {
  provider: string;
  /** When the call completed. */
  at: Date;
  model: string;
  tokens: TokenCounts;
  /** Absolute path of the working directory, when the source records one. */
  project?: string;
  sessionId?: string;
  /** Transport-level id of the API request, when the source records one. */
  requestId?: string;
  /** Id the API assigned the assistant message. Unique per API call. */
  messageId?: string;
}

export type QuotaWindow = 'session' | 'daily' | 'weekly' | 'monthly' | 'balance';

/**
 * `percent` is the case where the provider already did the division for us.
 * Such a reading carries used = the reported percentage and limit = 100, so
 * `percentUsed` keeps working unchanged. It is the only unit that can honestly
 * pair with confidence 'reported', because every other unit needs a cap that
 * we, not the provider, supplied.
 *
 * A percent reading may still be `derived`, and one case produces it: a
 * reported figure that has since been topped up with local usage the provider
 * had not seen when it spoke. The anchor is theirs, the addition is ours, and
 * the whole reading is therefore an estimate. See `topUpFor` in the Claude
 * Code adapter.
 */
export type QuotaUnit = 'requests' | 'tokens' | 'credits' | 'usd' | 'percent';

/**
 * `reported` - the provider stated this figure.
 * `derived`  - we computed it. Treat as an estimate and render it as one.
 */
export type Confidence = 'reported' | 'derived';

export interface QuotaReading {
  /** Adapter id, e.g. "claude-code". */
  provider: string;
  /** Human label for the plan or scope, e.g. "Max 20x". */
  label: string;
  window: QuotaWindow;
  used: number;
  /** null when the plan has no published cap for this window. */
  limit: number | null;
  unit: QuotaUnit;
  /** Start of the window this reading covers, ISO 8601. */
  windowStart: string | null;
  /** When the window rolls over, ISO 8601. null when not discoverable. */
  resetsAt: string | null;
  estimatedCostUsd?: number;
  /**
   * When the provider's figure was observed, ISO 8601. Absent when the reading
   * is derived from local files, which are as current as the read itself.
   *
   * A reported percentage is a photograph: Anthropic's arrives when a status
   * line or a `/usage` probe catches it, OpenAI's when Codex last wrote a
   * rollout log. Without this a surface can only say when it last LOOKED, which
   * is the question nobody is asking - "83%, as of nine hours ago" and "83%,
   * just now" are different facts and were rendered identically.
   */
  observedAt?: string;
  confidence: Confidence;
  /** Shown in verbose output. Use it to explain a derived denominator. */
  note?: string;
}

/** Where secrets live. v0.1 needs none; API adapters in v0.2 will. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Everything an adapter is allowed to touch. Passing the clock in keeps
 * window arithmetic deterministic under test.
 */
export interface AdapterContext {
  now(): Date;
  homeDir: string;
  /** This adapter's slice of the config file, already validated. */
  options: Record<string, unknown>;
  secrets: SecretStore;
  debug(message: string): void;
  /**
   * A person asked for this read, rather than a timer.
   *
   * An adapter may spend something on a refresh it would not spend on a poll -
   * running the provider's own CLI to ask for a figure, say. Absent means the
   * ordinary case: read what is already on disk and nothing more.
   */
  refresh?: boolean;
}

export interface QuotaAdapter {
  readonly id: string;
  readonly displayName: string;
  /** False when the tool is absent or unconfigured. Never throw here. */
  detect(ctx: AdapterContext): Promise<boolean>;
  /** Must not throw for a recoverable parse problem. Skip the record instead. */
  read(ctx: AdapterContext): Promise<QuotaReading[]>;
}

/** Result wrapper so one failing adapter never takes down a refresh. */
export type AdapterResult =
  | { ok: true; id: string; readings: QuotaReading[] }
  | { ok: false; id: string; error: string };

export function percentUsed(reading: QuotaReading): number | null {
  if (reading.limit === null || reading.limit <= 0) return null;
  return Math.min(100, (reading.used / reading.limit) * 100);
}
