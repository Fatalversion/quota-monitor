/**
 * The Claude Code quota adapter.
 *
 * This is the module that turns "876 MB of undocumented JSONL" into two
 * honest rows: how much of the current session window and of the current week
 * has been burned.
 *
 * WHY EVERY READING IS `derived`, WITHOUT EXCEPTION
 * -------------------------------------------------
 * The numerator is real. It is summed from `usage` objects Claude Code wrote
 * into its own session transcripts, and nothing here invents a token.
 *
 * The denominator is not. Nothing anywhere under ~/.claude records a rate
 * limit, a plan cap, a quota percentage or a window reset time - we searched.
 * So every limit printed by this adapter comes either from the user's config
 * or from the community-estimate table in `./plans.ts`, and the reading says
 * so in its `note`. `confidence` is hard-coded to 'derived' below; there is no
 * code path that produces 'reported'.
 *
 * WHAT `used` COUNTS
 * ------------------
 * Fresh input + output tokens, and by default NOT cache reads or cache writes.
 * That is a deliberate, documented choice, for two reasons:
 *
 *   1. `cache_read_input_tokens` is routinely an order of magnitude larger
 *      than every other field and is billed at a small fraction of the input
 *      rate. Folding it into one "tokens used" figure produces a number that
 *      looks alarming and means nothing.
 *   2. The per-window ceilings in `./plans.ts` are community figures stated in
 *      those same terms. Dividing a cache-inflated numerator by them would
 *      report 900% usage to somebody who has barely started.
 *
 * The excluded cache totals are never hidden: they are printed in the note,
 * they are fully priced into `estimatedCostUsd`, and `countCache: true` in
 * config folds them into `used` for anyone who wants that.
 *
 * WHICH FIVE HOURS
 * ----------------
 * Anthropic's session limit is a ROLLING window: it opens on your first
 * message and runs five hours from that instant, and once it lapses the next
 * message opens a fresh one. It is not a clock block. This adapter used to ask
 * `windowBounds('session', ...)` for the 00:00/05:00/10:00/15:00/20:00 UTC
 * block containing `now`, which is a different window and usually the wrong
 * one: on 2026-09-11 the 05:00Z block swept in 1h49m belonging to the previous
 * window and reported 1,351,060 tokens where the truth, anchored at the 06:49Z
 * first message, was 709,837. Claude Code's own /usage panel said 13%; we said
 * 48%.
 *
 * So the session window is now derived with `activityAnchoredWindow` from the
 * events themselves, which creates an ordering problem: the window used to
 * decide which transcripts to open, and now it depends on what is inside them.
 * It is resolved by a WIDENING search rather than by reading the whole
 * directory - see `SESSION_ANCHOR_LOOKBACK_LADDER_HOURS` and `findAnchorGap`.
 * The scan starts at a day of history and steps outwards only while the anchor
 * is still unproven, reusing every transcript it has already opened, and stops
 * the instant an idle gap of one session window proves the chain. Only when
 * the ceiling is reached with no such gap anywhere does the reading say
 * ANCHOR UNCERTAIN - which is what makes that warning worth reading, instead
 * of the permanent complaint a fixed lookback produced for anybody who uses
 * Claude Code daily.
 *
 * The weekly window is untouched. It is calendar-anchored, it was measured
 * against the same transcripts, and it was already right.
 *
 * SAFETY
 * ------
 * Read-only, and narrow. Every file this adapter opens comes from
 * `listTranscripts`, whose allowlist is `projects/<dir>/<name>.jsonl`. It
 * never reads `.credentials.json`, never reads a `*.key`, never writes
 * anything, and makes no network call.
 */

import { stat } from 'node:fs/promises';

import { estimateCostUsd } from '../../core/pricing.js';
import { ZERO_TOKENS } from '../../core/types.js';
import {
  activityAnchoredWindow,
  eventsInWindow,
  sumTokens,
  windowBounds,
} from '../../core/window.js';
import { UNDETECTED, detectPlan } from './detect-plan.js';
import { parseLine, usageEventKey } from './parse.js';
import { planFor } from './plans.js';
import {
  MAX_LINE_LENGTH,
  claudeHomeDir,
  listTranscripts,
  newStreamStatus,
  streamLines,
} from './transcripts.js';

import type {
  AdapterContext,
  QuotaAdapter,
  QuotaReading,
  QuotaWindow,
  TokenCounts,
  UsageEvent,
} from '../../core/types.js';
import type { AnchoredWindow } from '../../core/window.js';
import type { DetectedPlan } from './detect-plan.js';
import type { PlanCaps } from './plans.js';

/** Adapter id. Matches the directory name and the config key. */
export const PROVIDER_ID = 'claude-code';

export const DISPLAY_NAME = 'Claude Code';

/**
 * Hard ceiling on transcripts opened in one read.
 *
 * A heavy user's `projects/` directory holds tens of thousands of files. Even
 * with the mtime filter, a wide window can match more than we should stream
 * inside a widget refresh. When the cap bites we take the NEWEST files, which
 * are the ones inside the current windows, and every affected reading says in
 * its note that it is an undercount. A silent truncation would turn this tool
 * into a liar.
 */
export const MAX_TRANSCRIPT_FILES = 500;

/** Upper bound a user may raise `maxFiles` to. Keeps one refresh bounded. */
const MAX_TRANSCRIPT_FILES_CEILING = 20_000;

/**
 * De-duplicated events held before they are folded into the window
 * accumulators.
 *
 * Streaming exists so a 100 MB transcript never lands in memory; buffering the
 * whole week's events would give that memory straight back. The buffer is
 * flushed at every file boundary, so this cap only bites inside a single
 * enormous transcript, and 65,536 events is a few MB.
 *
 * The cap is the one place de-duplication is approximate: two records of the
 * same API call separated by more than this many distinct in-range calls
 * WITHIN ONE FILE would land in different batches and be counted twice. The
 * largest such separation measured across all 1,882 transcripts on disk is
 * 2,204 records, so the margin is a factor of thirty. Duplicates never span
 * files - 0 collisions across those 1,882 - which is why the file-boundary
 * flush is exact.
 */
const MAX_PENDING_EVENTS = 65_536;

/**
 * Where the search for the session anchor starts, in hours.
 *
 * The session window opens on a message, so it cannot be known until the
 * events are in hand - but the events are chosen by window. The knot is cut by
 * scanning a lookback: every transcript touched in the last 24 hours, chained
 * into windows, gives the one that is open now.
 *
 * Twenty-four hours is the first rung because it is nearly five session
 * windows, so it usually already contains the idle gap that pins the chain,
 * and because the weekly window forces a scan back to the start of the week
 * anyway - which means on every day but the first of a week this rung is free.
 */
export const SESSION_ANCHOR_LOOKBACK_HOURS = 24;

/**
 * The widening ladder, in hours: 24h, 3d, 7d, 30d.
 *
 * A fixed lookback can only PROVE the anchor if an idle gap of one whole
 * session window falls inside it (see `findAnchorGap`). For anybody who uses
 * Claude Code daily, activity runs right up to the edge of a 24-hour lookback
 * often enough that the fixed version disclosed ANCHOR UNCERTAIN on nearly
 * every read - and a warning that is always on is a warning nobody reads.
 * Measured on the machine this was written on, the note fired while the anchor
 * was in fact correct: chains from 24 hours, 14 days and the full 2.5-month
 * history all agreed on 2026-09-11T06:49:39.207Z.
 *
 * So the search widens instead. Each rung extends the floor of the searched
 * range, opens only the transcripts the previous rung had not already opened,
 * and stops the moment a qualifying gap appears. The rungs grow fast because
 * needing a later one at all means the user went N days without a five-hour
 * break, which gets less plausible with every step; 30 days is the ceiling,
 * and reaching it is the one case that still earns the warning.
 */
export const SESSION_ANCHOR_LOOKBACK_LADDER_HOURS: readonly number[] = [24, 72, 24 * 7, 24 * 30];

/**
 * Extra transcripts one refresh may open purely to prove the anchor.
 *
 * The ladder's ceiling is a span, not a file count, and those are not the same
 * budget: on the machine this was measured on, 30 days of history is 1,336
 * transcripts against 190 for a day. This cap is what stops a pathological
 * account turning one widget refresh into a read of the whole directory. It is
 * separate from `maxFiles` on purpose - `maxFiles` bounds the files the
 * NUMBERS come from, and exceeding it is an undercount, whereas exceeding this
 * one costs nothing but the ANCHOR UNCERTAIN disclosure. A step that would
 * cross it is not started at all: a half-read step could invent an idle gap
 * that is not there, which is worse than admitting the doubt.
 */
export const MAX_ANCHOR_WIDENING_FILES = 400;

const MS_PER_HOUR = 3_600_000;

/**
 * Config keys this adapter understands, under `providers.claude-code` in
 * `~/.config/quota-monitor/config.yaml`. Every one is optional, and anything
 * unusable falls back to the documented default with a `debug()` line rather
 * than an error.
 *
 * ```yaml
 * providers:
 *   claude-code:
 *     plan: max-20x         # pro | max-5x | max-20x | team | api
 *     sessionLimit: 240000  # a cap you MEASURED beats one we guessed
 *     countCache: false
 * ```
 *
 * NAMING CONSTRAINT, and it is load-bearing: `src/core/config.ts` drops any
 * option whose key matches /token|key|secret|password/i, so a credential
 * pasted into the config file never reaches an adapter. That is the right
 * default and it is not being relaxed - which is why the two ceilings are
 * called `sessionLimit` and `weeklyLimit` rather than the more obvious
 * `sessionTokens`. A key named `...Tokens` would be silently stripped before
 * this adapter ever ran. The "every documented option survives parseConfig"
 * test in `index.test.ts` guards the whole set against that regression.
 */
export interface ClaudeCodeOptions {
  /** Plan id, passed through `planFor`. Unrecognised values mean "unknown". */
  plan?: string;
  /** Override the Claude home directory. Also honours $CLAUDE_CONFIG_DIR. */
  dir?: string;
  /** Length of one session window in hours. Default 5. */
  sessionHours?: number;
  /** Day the weekly window opens: 0 = Sunday .. 6 = Saturday. Default 1. */
  weekStartsOn?: number;
  /** Measured session ceiling in tokens. `null` or 'none' means "no cap". */
  sessionLimit?: number | null | string;
  /** Measured weekly ceiling in tokens. `null` or 'none' means "no cap". */
  weeklyLimit?: number | null | string;
  /** Fold cache reads and cache writes into `used`. Default false. */
  countCache?: boolean;
  /** Transcripts opened in one read. Default 500. */
  maxFiles?: number;
}

/** Where a printed denominator actually came from. */
type LimitSource = 'config' | 'plan-table' | 'none';

interface ResolvedLimit {
  value: number | null;
  source: LimitSource;
  /** Config key that supplied or could supply this cap. */
  key: string;
}

interface ResolvedOptions {
  plan: PlanCaps;
  claudeDir: string;
  sessionHours: number;
  weekStartsOn: number;
  session: ResolvedLimit;
  weekly: ResolvedLimit;
  countCache: boolean;
  maxFiles: number;
}

/** One window's running totals, kept per model so pricing stays correct. */
interface WindowAccumulator {
  window: QuotaWindow;
  /**
   * null only for an anchored window that is not open: no activity in the
   * lookback, or the last window lapsed. There is no interval to report then,
   * and inventing one would put a countdown on a limit that is not running.
   */
  start: Date | null;
  end: Date | null;
  limit: ResolvedLimit;
  /** API calls counted into this window. */
  calls: number;
  byModel: Map<string, TokenCounts>;
}

/* -------------------------------------------------------------------------- */
/* option reading - tolerant, never throws                                    */
/* -------------------------------------------------------------------------- */

function optString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optBoolean(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** A finite number, written as a number or as a numeric string. */
function optNumber(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * A user-supplied token ceiling.
 *
 * Returns `undefined` when the key is absent (fall back to the plan table),
 * `null` when the user explicitly asked for no cap, and a positive integer
 * otherwise. A zero or negative cap is rejected: it would render every reading
 * as instantly maxed out.
 */
function optTokenCap(
  options: Record<string, unknown>,
  key: string,
  ctx: AdapterContext,
): number | null | undefined {
  const raw = options[key];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === 'string' && ['none', 'null', 'unknown', ''].includes(raw.trim().toLowerCase())) {
    return null;
  }
  const value = optNumber(options, key);
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    ctx.debug(
      `${PROVIDER_ID}: ignoring ${key}, expected a positive number of tokens or "none"`,
    );
    return undefined;
  }
  return Math.floor(value);
}

/** The Claude home directory, resolved identically for `detect` and `read`. */
function resolveClaudeDir(ctx: AdapterContext): string {
  const override = optString(ctx.options, 'dir') ?? optString(ctx.options, 'claudeDir');
  return claudeHomeDir(ctx.homeDir, override);
}

function resolveOptions(ctx: AdapterContext, detected: DetectedPlan): ResolvedOptions {
  const options = ctx.options;

  // Configuration wins. Auto-detection only fills the gap, so a user who
  // overrides the plan is never silently overruled by a file on disk.
  const configured = optString(options, 'plan');
  const plan = planFor(configured ?? detected.plan);
  if (configured === undefined && detected.source !== 'none') {
    ctx.debug(
      `${PROVIDER_ID}: plan auto-detected as "${plan.id}" from ${detected.source} ` +
        `(${detected.raw ?? 'no value'}) in ~/.claude.json`,
    );
  }

  let sessionHours = plan.sessionHours;
  const rawHours = optNumber(options, 'sessionHours');
  if (rawHours !== undefined) {
    if (rawHours > 0 && rawHours <= 24) sessionHours = rawHours;
    else ctx.debug(`${PROVIDER_ID}: ignoring sessionHours ${rawHours}, expected 0 < hours <= 24`);
  }

  let weekStartsOn = 1;
  const rawWeekStart = optNumber(options, 'weekStartsOn');
  if (rawWeekStart !== undefined) {
    if (Number.isInteger(rawWeekStart) && rawWeekStart >= 0 && rawWeekStart <= 6) {
      weekStartsOn = rawWeekStart;
    } else {
      ctx.debug(
        `${PROVIDER_ID}: ignoring weekStartsOn ${rawWeekStart}, expected an integer 0-6`,
      );
    }
  }

  let maxFiles = MAX_TRANSCRIPT_FILES;
  const rawMaxFiles = optNumber(options, 'maxFiles');
  if (rawMaxFiles !== undefined) {
    if (rawMaxFiles >= 1) maxFiles = Math.min(Math.floor(rawMaxFiles), MAX_TRANSCRIPT_FILES_CEILING);
    else ctx.debug(`${PROVIDER_ID}: ignoring maxFiles ${rawMaxFiles}, expected at least 1`);
  }

  return {
    plan,
    claudeDir: resolveClaudeDir(ctx),
    sessionHours,
    weekStartsOn,
    session: resolveLimit(options, 'sessionLimit', plan.sessionTokens, ctx),
    weekly: resolveLimit(options, 'weeklyLimit', plan.weeklyTokens, ctx),
    countCache: optBoolean(options, 'countCache') ?? false,
    maxFiles,
  };
}

function resolveLimit(
  options: Record<string, unknown>,
  key: string,
  fromTable: number | null,
  ctx: AdapterContext,
): ResolvedLimit {
  const override = optTokenCap(options, key, ctx);
  if (override !== undefined) {
    return { value: override, source: override === null ? 'none' : 'config', key };
  }
  return { value: fromTable, source: fromTable === null ? 'none' : 'plan-table', key };
}

/* -------------------------------------------------------------------------- */
/* token bookkeeping                                                          */
/* -------------------------------------------------------------------------- */

function addInto(target: TokenCounts, add: TokenCounts): void {
  target.input += add.input;
  target.output += add.output;
  target.cacheCreation += add.cacheCreation;
  target.cacheRead += add.cacheRead;
  target.thinking += add.thinking;
}

/**
 * The figure divided by the plan cap. See the header for why cache classes are
 * excluded by default.
 */
function usedTokens(tokens: TokenCounts, countCache: boolean): number {
  const base = tokens.input + tokens.output;
  return countCache ? base + tokens.cacheCreation + tokens.cacheRead : base;
}

interface WindowTotals {
  tokens: TokenCounts;
  /** null when billable tokens were counted but no model in them has a price. */
  costUsd: number | null;
  /** Models that contributed tokens we could not price. */
  unpriced: string[];
}

/** True when a model actually consumed something we would have to pay for. */
function hasBillableTokens(counts: TokenCounts): boolean {
  return (
    counts.input > 0 || counts.output > 0 || counts.cacheCreation > 0 || counts.cacheRead > 0
  );
}

function totalsOf(acc: WindowAccumulator): WindowTotals {
  const tokens: TokenCounts = { ...ZERO_TOKENS };
  const unpriced: string[] = [];
  let cost = 0;
  let priced = false;
  let billable = false;

  for (const [model, counts] of acc.byModel) {
    addInto(tokens, counts);

    // Claude Code writes assistant records for locally generated messages
    // under a placeholder model - "<synthetic>" - with an all-zero usage
    // object. Those cost nothing whatever price we cannot find for them, so
    // naming them as "unpriced" would be noise that hides a real gap.
    const contributes = hasBillableTokens(counts);
    if (contributes) billable = true;

    const estimate = estimateCostUsd(model, counts);
    if (estimate === null) {
      if (contributes) unpriced.push(model);
    } else {
      cost += estimate;
      priced = true;
    }
  }

  unpriced.sort();
  if (!billable) return { tokens, costUsd: 0, unpriced };
  return { tokens, costUsd: priced ? cost : null, unpriced };
}

/* -------------------------------------------------------------------------- */
/* formatting for notes (local, so providers never import the CLI layer)      */
/* -------------------------------------------------------------------------- */

/** 220000 -> "220,000". Notes are read by humans, not parsed. */
function group(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 1234567 -> "1.2M". Keeps the cache aside short. */
function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 999.95e6) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 999.95e3) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 999.5) return (n / 1e3).toFixed(1) + 'K';
  return group(n);
}

function plural(n: number, one: string, many: string = one + 's'): string {
  return n === 1 ? one : many;
}

/* -------------------------------------------------------------------------- */
/* transcript selection                                                       */
/* -------------------------------------------------------------------------- */

interface FileSelection {
  files: string[];
  /** Set when the cap bit, so the note can admit the undercount. */
  truncatedFrom: number | null;
}

/**
 * What the scan actually managed to read. Every field here exists so a note
 * can admit an undercount instead of presenting a partial count as a total.
 */
interface ScanSummary {
  /** Transcripts opened. */
  scanned: number;
  /** Of those, how many did not reach end of file, or dropped a huge line. */
  incomplete: number;
  /** Transcripts that matched the window but were dropped by `maxFiles`. */
  truncatedFrom: number | null;
}

/**
 * Concurrent `stat` calls in flight at once.
 *
 * This path only runs when the file count is already large, so an unbounded
 * `Promise.all` over the whole list would queue tens of thousands of requests
 * on libuv's threadpool at the worst possible moment. Batching keeps the peak
 * flat and costs nothing measurable in wall time.
 */
const STAT_CONCURRENCY = 64;

/** A transcript path and when it was last written to. */
interface StampedFile {
  file: string;
  mtimeMs: number;
}

/**
 * `stat` every path, in bounded batches.
 *
 * A file we cannot stat gets `-Infinity`, which sorts it oldest: if a caller
 * must drop something, it should drop the one we know least about, and a
 * widening step must not claim to have covered a file it never saw.
 */
async function statFiles(files: readonly string[]): Promise<StampedFile[]> {
  const stamped: StampedFile[] = [];

  for (let i = 0; i < files.length; i += STAT_CONCURRENCY) {
    const batch = await Promise.all(
      files.slice(i, i + STAT_CONCURRENCY).map(async (file) => {
        try {
          const info = await stat(file);
          return { file, mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : -Infinity };
        } catch {
          return { file, mtimeMs: -Infinity };
        }
      }),
    );
    for (const entry of batch) stamped.push(entry);
  }

  return stamped;
}

/**
 * Keep the newest `max` transcripts.
 *
 * `listTranscripts` returns paths sorted lexically, which is stable but says
 * nothing about recency, so this stats the candidates and sorts by mtime. A
 * file we cannot stat sorts last: if we must drop something, drop the one we
 * know least about. The kept set is re-sorted by path so a run is reproducible.
 */
async function newestFiles(files: string[], max: number): Promise<string[]> {
  const stamped = await statFiles(files);

  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const kept = stamped.slice(0, max).map((entry) => entry.file);
  kept.sort();
  return kept;
}

async function selectTranscripts(
  claudeDir: string,
  since: Date,
  max: number,
): Promise<FileSelection> {
  const matched = await listTranscripts(claudeDir, { since });
  if (matched.length <= max) return { files: matched, truncatedFrom: null };
  return { files: await newestFiles(matched, max), truncatedFrom: matched.length };
}

/* -------------------------------------------------------------------------- */
/* streaming                                                                  */
/* -------------------------------------------------------------------------- */

interface ScanRequest {
  files: readonly string[];
  /** Events stamped outside `[fromMs, toMs)` are dropped as they are parsed. */
  fromMs: number;
  toMs: number;
  ctx: AdapterContext;
  /**
   * Called with each de-duplicated batch of in-range events, at every file
   * boundary and whenever the pending buffer fills. Batches never overlap.
   */
  onBatch: (batch: UsageEvent[]) => void;
}

/**
 * Stream a list of transcripts, de-duplicate their usage records, and hand the
 * caller the events in batches.
 *
 * Fail-soft: an unreadable transcript is skipped and counted in `incomplete`,
 * a malformed line is skipped, and one bad file never costs the whole reading.
 *
 * The de-duplication is the load-bearing part. Claude Code writes one
 * assistant record per content block of a response and repeats the same
 * CUMULATIVE usage object on each. Three records for one call is the common
 * case, and summing them straight would treble the numerator: measured over a
 * real transcript, 85 records describe 36 API calls, and the naive sum reports
 * 150,612 input+output tokens against a true 54,289 - 2.77x. Keying by
 * `usageEventKey` and letting a LATER record replace an earlier one is what
 * makes `used` a count of calls rather than of log lines; last-wins matters
 * because the repeated object is sometimes still growing (one real subagent
 * call records `output_tokens: 3` and then `output_tokens: 26069` under the
 * same id).
 *
 * The buffer is flushed at every file boundary, so de-duplication is exact
 * across files - duplicates never span them, 0 collisions across the 1,882
 * transcripts this was measured on - and memory stays flat in the number of
 * files.
 */
async function scanTranscripts(req: ScanRequest): Promise<{ scanned: number; incomplete: number }> {
  const { ctx, fromMs, toMs, onBatch } = req;

  /** In-window events awaiting a flush, keyed by API call. */
  const pending = new Map<string, UsageEvent>();
  /**
   * Events that name no API call. Kept apart from `pending` and never merged:
   * a record with no message id cannot be shown to be a duplicate, and merging
   * on a partial identity would discard real calls.
   */
  const unkeyed: UsageEvent[] = [];

  const flush = (): void => {
    if (pending.size === 0 && unkeyed.length === 0) return;
    const batch = [...pending.values(), ...unkeyed];
    pending.clear();
    unkeyed.length = 0;
    onBatch(batch);
  };

  let scanned = 0;
  let incomplete = 0;

  for (const file of req.files) {
    scanned += 1;
    const status = newStreamStatus();
    try {
      for await (const line of streamLines(file, status)) {
        const event = parseLine(line);
        if (event === null) continue;

        const at = event.at.getTime();
        if (!Number.isFinite(at) || at < fromMs || at >= toMs) continue;

        const key = usageEventKey(event);
        if (key === null) unkeyed.push(event);
        else pending.set(key, event);
        if (pending.size + unkeyed.length >= MAX_PENDING_EVENTS) flush();
      }
    } catch (error) {
      // One bad file must never cost us the whole reading.
      ctx.debug(`${PROVIDER_ID}: skipped ${file} (${messageOf(error)})`);
      status.complete = false;
      if (status.reason === null) status.reason = messageOf(error);
    }

    flush();

    if (!status.complete || status.oversizedLines > 0) {
      incomplete += 1;
      ctx.debug(
        `${PROVIDER_ID}: ${file} was not fully read ` +
          `(${status.reason ?? `${status.oversizedLines} oversized lines dropped`})`,
      );
    }
  }

  return { scanned, incomplete };
}

/* -------------------------------------------------------------------------- */
/* proving the session anchor                                                 */
/* -------------------------------------------------------------------------- */

/** The idle gap that pins the window chain, and where it sits. */
interface AnchorGap {
  /** Start of the idle stretch: the previous message, or the searched floor. */
  fromMs: number;
  /** Its length. Always at least one session window. */
  gapMs: number;
}

/**
 * The idle gap that PROVES the anchor within `[knownFromMs, nowMs]`, or null.
 *
 * The whole difficulty is that history is unbounded and a scan is not: a
 * message just before the floor of what we read might have opened the window
 * we are reporting. An idle gap of one whole session window is what closes
 * that hole, and it does so absolutely:
 *
 *   - Take two consecutive messages `a` and `b` with `b - a >= sessionMs`.
 *     Whatever window `a` belonged to opened at or before `a`, so it closed at
 *     or before `a + sessionMs <= b`. `b` therefore opens a fresh window no
 *     matter what happened before the floor, and the chain from `b` to now is
 *     fully determined by messages we have in hand.
 *   - The floor itself counts as such an `a`: if the oldest message we found
 *     is at least one window after the floor, nothing before the floor can
 *     still have been running when it arrived. This is the case the old fixed
 *     lookback tested, and it is the WEAKEST one - it needs the idle stretch
 *     to sit exactly at the edge of the scan, which is why it so rarely fired.
 *   - A trailing gap proves the negative just as firmly: if the last message
 *     is a whole window old, every window has closed and none is open now.
 *
 * `stamps` may be unordered and may contain values outside the range; a sorted
 * copy of the usable ones is taken and the caller's array is never mutated.
 * Requires that the range is COMPLETE - every message in it is in `stamps` -
 * which is why a truncated or half-read scan still adds a doubt above.
 */
function findAnchorGap(
  stamps: readonly number[],
  knownFromMs: number,
  sessionMs: number,
  nowMs: number,
): AnchorGap | null {
  const sorted = stamps
    .filter((ms) => Number.isFinite(ms) && ms >= knownFromMs && ms <= nowMs)
    .sort((a, b) => a - b);

  let prev = knownFromMs;
  for (const ms of sorted) {
    if (ms - prev >= sessionMs) return { fromMs: prev, gapMs: ms - prev };
    prev = ms;
  }

  // Nothing since `prev`, and that is itself a window ago: no window is open,
  // and no earlier history could change that.
  if (nowMs - prev >= sessionMs) return { fromMs: prev, gapMs: nowMs - prev };
  return null;
}

/**
 * The ladder as millisecond spans, strictly increasing.
 *
 * Every rung is at least two session windows long, so a user who has set a
 * long custom `sessionHours` still gets a first step that can hold an idle
 * gap, and rungs that collapse into each other under that floor are dropped.
 */
function anchorLadderMs(sessionMs: number): number[] {
  const shortest = Math.max(SESSION_ANCHOR_LOOKBACK_HOURS * MS_PER_HOUR, sessionMs * 2);
  const ladder: number[] = [];
  for (const rung of SESSION_ANCHOR_LOOKBACK_LADDER_HOURS) {
    const ms = Math.max(Math.round(rung * MS_PER_HOUR), shortest);
    const last = ladder[ladder.length - 1];
    if (last === undefined || ms > last) ladder.push(ms);
  }
  return ladder;
}

/* -------------------------------------------------------------------------- */
/* the adapter                                                                */
/* -------------------------------------------------------------------------- */

function makeAccumulator(
  window: QuotaWindow,
  range: { start: Date | null; end: Date | null },
  limit: ResolvedLimit,
): WindowAccumulator {
  return {
    window,
    start: range.start,
    end: range.end,
    limit,
    calls: 0,
    byModel: new Map<string, TokenCounts>(),
  };
}

/**
 * Fold every event of `batch` that falls inside `acc`'s interval into it.
 *
 * Grouped by model first: prices differ per model, so one blended sum would
 * mis-cost every mixed session. An anchored window that is not open has no
 * interval and therefore takes nothing - which is the correct answer, not a
 * skipped case.
 */
function foldEvents(acc: WindowAccumulator, batch: UsageEvent[]): void {
  if (acc.start === null || acc.end === null) return;

  const inWindow = eventsInWindow(batch, acc.start, acc.end);
  if (inWindow.length === 0) return;
  acc.calls += inWindow.length;

  const byModel = new Map<string, UsageEvent[]>();
  for (const event of inWindow) {
    const bucket = byModel.get(event.model);
    if (bucket === undefined) byModel.set(event.model, [event]);
    else bucket.push(event);
  }

  for (const [model, events] of byModel) {
    const summed = sumTokens(events);
    const existing = acc.byModel.get(model);
    if (existing === undefined) acc.byModel.set(model, summed);
    else addInto(existing, summed);
  }
}

/**
 * How the anchored session window was arrived at, and whether the lookback
 * was long enough to prove it. Only the session reading carries one; the
 * weekly window is clock-anchored and needs no such disclosure.
 */
interface AnchorReport {
  window: AnchoredWindow;
  /** How far back the widening search actually reached. */
  searchedMs: number;
  sessionHours: number;
  /** Empty when the anchor is certain. Each entry is one reason it is not. */
  doubts: string[];
}

/** 5 -> "5", 4.5 -> "4.5". Hours read badly as "5.0". */
function hours(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** A duration a human can hold: "18 hours", "4.35 days", "30 days". */
function span(ms: number): string {
  const h = ms / MS_PER_HOUR;
  if (h < 48) return `${hours(h)} ${plural(h, 'hour')}`;
  return `${hours(h / 24)} days`;
}

/**
 * Say where the session window came from.
 *
 * A user comparing this against Claude Code's own /usage panel needs to see
 * the two instants we are counting between, because if they disagree with the
 * panel then the anchor is what is wrong. When the lookback could not prove
 * the anchor, that is stated in the same breath - a window we are unsure of
 * must not read like one we measured.
 */
function anchorNoteParts(anchor: AnchorReport): string[] {
  const parts: string[] = [];
  const window = anchor.window;

  if (window.live) {
    parts.push(
      `this ${hours(anchor.sessionHours)}-hour window is ANCHORED TO YOUR ACTIVITY, not to the ` +
        `clock: it opened at ${window.start.toISOString()} with the first message after the ` +
        `previous window lapsed, and resets at ${window.end.toISOString()} - the provider's ` +
        `session limit runs from that message, so a 00:00/05:00/10:00 clock block would ` +
        `count usage from the window before it`,
    );
  } else if (window.reason === 'expired' && window.lastEnd !== null) {
    parts.push(
      `no session window is open: the last one closed at ${window.lastEnd.toISOString()} and ` +
        `the next opens with your next message, so this reads 0 of the cap rather than a ` +
        `stale total`,
    );
  } else {
    parts.push(
      `no session window is open: no usage recorded in the ${span(anchor.searchedMs)} ` +
        `searched, so the next message opens one`,
    );
  }

  if (anchor.doubts.length > 0) {
    parts.push(
      `ANCHOR UNCERTAIN: ${anchor.doubts.join('; and ')} - the window may really have opened ` +
        `earlier than shown, which would make this an undercount against a reset time that is ` +
        `too late`,
    );
  }

  return parts;
}

/**
 * Explain the reading. This is where a derived denominator justifies itself,
 * so it names the exact source of the number and the exact config key that
 * replaces it.
 */
function buildNote(
  acc: WindowAccumulator,
  totals: WindowTotals,
  opts: ResolvedOptions,
  scan: ScanSummary,
  anchor: AnchorReport | null,
): string {
  const parts: string[] = [];
  const configKey = `providers.${PROVIDER_ID}.${acc.limit.key}`;

  if (anchor !== null) parts.push(...anchorNoteParts(anchor));

  switch (acc.limit.source) {
    case 'config':
      parts.push(
        `limit ${group(acc.limit.value ?? 0)} tokens came from your config (${configKey})`,
      );
      break;
    case 'plan-table':
      parts.push(
        `limit ${group(acc.limit.value ?? 0)} tokens is a COMMUNITY ESTIMATE for ` +
          `"${opts.plan.label}" from the plan table in ` +
          `src/providers/${PROVIDER_ID}/plans.ts - Anthropic publishes no cap and ` +
          `nothing in ~/.claude records one, so this percentage is an estimate; ` +
          `measure your own and set ${configKey}`,
      );
      break;
    case 'none':
      parts.push(
        `no cap known for "${opts.plan.label}" (src/providers/${PROVIDER_ID}/plans.ts has ` +
          `no estimate for it), so no percentage is shown; set ${configKey} to get one`,
      );
      break;
  }

  const cache = totals.tokens.cacheRead + totals.tokens.cacheCreation;
  parts.push(
    opts.countCache
      ? `used counts input + output + cache (${compact(cache)} cache tokens included via countCache)`
      : `used counts input + output only; ${compact(totals.tokens.cacheRead)} cache-read and ` +
          `${compact(totals.tokens.cacheCreation)} cache-write tokens are excluded from the ` +
          `numerator but are priced into the cost estimate`,
  );

  parts.push(
    `${group(acc.calls)} ${plural(acc.calls, 'call')} across ` +
      `${group(scan.scanned)} ${plural(scan.scanned, 'transcript')}`,
  );

  if (scan.truncatedFrom !== null) {
    parts.push(
      `TRUNCATED: ${group(scan.truncatedFrom)} transcripts matched this window but only the ` +
        `newest ${group(opts.maxFiles)} were read, so this is an undercount ` +
        `(raise ${`providers.${PROVIDER_ID}.maxFiles`} to widen it)`,
    );
  }

  // A read that stopped early yields a valid prefix, so nothing downstream can
  // tell it from a whole file. Saying so is the only thing that keeps
  // "N calls across M transcripts" from being a false claim.
  if (scan.incomplete > 0) {
    parts.push(
      `INCOMPLETE: ${group(scan.incomplete)} of ${group(scan.scanned)} ` +
        `${plural(scan.scanned, 'transcript')} could not be read to the end (locked, ` +
        `removed mid-read, or holding a line above the ${group(MAX_LINE_LENGTH)}-character ` +
        `cap), so this is an undercount`,
    );
  }

  if (totals.unpriced.length > 0) {
    parts.push(
      `cost excludes ${plural(totals.unpriced.length, 'model')} with no entry in ` +
        `src/core/pricing.ts: ${totals.unpriced.join(', ')}`,
    );
  }

  return parts.join('; ');
}

function buildReading(
  acc: WindowAccumulator,
  opts: ResolvedOptions,
  scan: ScanSummary,
  anchor: AnchorReport | null = null,
): QuotaReading {
  const totals = totalsOf(acc);

  const reading: QuotaReading = {
    provider: PROVIDER_ID,
    label: opts.plan.label,
    window: acc.window,
    used: usedTokens(totals.tokens, opts.countCache),
    limit: acc.limit.value,
    unit: 'tokens',
    // Null when an anchored window is not open. `QuotaReading` allows it, and
    // it is the honest answer: there is no interval and no countdown.
    windowStart: acc.start === null ? null : acc.start.toISOString(),
    resetsAt: acc.end === null ? null : acc.end.toISOString(),
    // Not negotiable. The numerator is measured, the denominator is not, and
    // there is no branch here that can produce 'reported'.
    confidence: 'derived',
  };

  // exactOptionalPropertyTypes: assign the optional fields only when real.
  // A null cost means "we have tokens but no price" - omitting the field lets
  // the renderer stay silent instead of printing a $0.00 that reads as free.
  if (totals.costUsd !== null) reading.estimatedCostUsd = totals.costUsd;

  const note = buildNote(acc, totals, opts, scan, anchor);
  if (note !== '') reading.note = note;

  return reading;
}

export const claudeCodeAdapter: QuotaAdapter = {
  id: PROVIDER_ID,
  displayName: DISPLAY_NAME,

  /**
   * True when the Claude projects directory exists and holds at least one
   * transcript. Never throws: an unreadable or absent directory is simply
   * "Claude Code is not here".
   */
  async detect(ctx: AdapterContext): Promise<boolean> {
    try {
      const dir = resolveClaudeDir(ctx);
      const files = await listTranscripts(dir);
      if (files.length === 0) {
        ctx.debug(`${PROVIDER_ID}: no transcripts under ${dir}/projects`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Stream the transcripts that could touch the current session or weekly
   * window, and return one reading per window.
   *
   * Fail-soft throughout: an unreadable transcript is skipped, a malformed
   * line is skipped, and a model with no price contributes tokens but no cost.
   * The only way this rejects is a programming error.
   */
  async read(ctx: AdapterContext): Promise<QuotaReading[]> {
    // Read the plan off disk only when the user has not stated one. This keeps
    // first-run setup at zero: ~/.claude.json carries the rate-limit tier.
    const detected =
      optString(ctx.options, 'plan') === undefined
        ? await detectPlan(ctx.homeDir)
        : UNDETECTED;
    const opts = resolveOptions(ctx, detected);
    const now = ctx.now();
    const nowMs = now.getTime();

    // Weekly is a calendar quantity, so the clock still decides it.
    const weekly = windowBounds('weekly', now, { weekStartsOn: opts.weekStartsOn });

    // Session is not. Its bounds come out of the events, below, so only the
    // weekly accumulator can be filled while streaming.
    const streamed: WindowAccumulator[] = [makeAccumulator('weekly', weekly, opts.weekly)];

    const sessionMs = Math.round(opts.sessionHours * MS_PER_HOUR);
    const ladder = anchorLadderMs(sessionMs);
    // `anchorLadderMs` always returns at least one rung. The fallbacks keep
    // noUncheckedIndexedAccess satisfied without pretending it can be empty.
    const firstRungMs = ladder[0] ?? sessionMs * 2;
    const ceilingMs = ladder[ladder.length - 1] ?? firstRungMs;

    // Only files touched inside the widest span can hold an event we care
    // about, so nothing older is even stat-ed open. A transcript holding an
    // event after `scanFrom` cannot have an mtime before it - the line was
    // appended at that instant - so the mtime filter cannot hide one.
    //
    // The floor is the earlier of the week's start and the first rung, and
    // that is a coincidence worth spending: on every day but the first of a
    // week the weekly window has already paid for several days of transcripts,
    // so the anchor search begins with days of history in hand rather than
    // one, at no extra cost. On this machine that alone is what turns a note
    // that fired on every read into one that does not fire at all.
    const scanFromMs = Math.min(weekly.start.getTime(), nowMs - firstRungMs);
    const scanToMs = Math.max(weekly.end.getTime(), nowMs + sessionMs);
    const scanFrom = new Date(scanFromMs);

    const selection = await selectTranscripts(opts.claudeDir, scanFrom, opts.maxFiles);
    if (selection.truncatedFrom !== null) {
      ctx.debug(
        `${PROVIDER_ID}: ${selection.truncatedFrom} transcripts matched; reading the newest ` +
          `${opts.maxFiles}`,
      );
    }
    ctx.debug(
      `${PROVIDER_ID}: scanning ${selection.files.length} ${plural(selection.files.length, 'transcript')} ` +
        `modified since ${scanFrom.toISOString()}`,
    );

    /**
     * Every message timestamp the search has seen, in epoch milliseconds.
     *
     * Numbers, not events, because this is the only thing the anchor chain and
     * the gap proof need, and it is what makes widening affordable: the 14,210
     * events a real week holds cost 114 KB here instead of the megabytes their
     * objects would. Nothing about the streaming design changes - the events
     * themselves are still folded batch by batch and dropped.
     */
    const anchorStamps: number[] = [];
    /**
     * The only events kept whole: the ones that could still be inside the open
     * session window, which cannot be computed until every transcript is read.
     *
     * A live window contains `now` and is one session long, so it opened
     * strictly after `now - sessionMs`; nothing older can be in it. That bound
     * is what lets the widening search reach back thirty days while holding
     * five hours of events.
     */
    const sessionCandidates: UsageEvent[] = [];
    const liveFloorMs = nowMs - sessionMs;

    /*
     * Every pass keeps events back to the CEILING of the ladder, not back to
     * its own floor, and that is a correctness requirement rather than
     * generosity. A transcript is opened at most once; if a pass dropped the
     * records that sit below the floor it was working to, a later, wider pass
     * would never see them - it does not reopen the file - and their absence
     * would read as an idle gap that never happened. The first draft of this
     * did exactly that and invented a 16-hour gap in a month of unbroken
     * four-hourly activity.
     *
     * Nothing downstream is affected: each accumulator folds only the events
     * inside its own interval, so the extra records add no tokens to either
     * reading, and `sessionCandidates` keeps its own five-hour bound.
     */
    const anchorFloorMs = nowMs - ceilingMs;

    const base = await scanTranscripts({
      files: selection.files,
      fromMs: anchorFloorMs,
      toMs: scanToMs,
      ctx,
      onBatch: (batch) => {
        for (const acc of streamed) foldEvents(acc, batch);
        for (const event of batch) {
          const at = event.at.getTime();
          if (!Number.isFinite(at)) continue;
          anchorStamps.push(at);
          if (at >= liveFloorMs) sessionCandidates.push(event);
        }
      },
    });

    const scan: ScanSummary = {
      scanned: base.scanned,
      incomplete: base.incomplete,
      truncatedFrom: selection.truncatedFrom,
    };

    /*
     * The widening search.
     *
     * `knownFromMs` is the floor of the stretch of history we have COMPLETE
     * knowledge of, and `findAnchorGap` says whether that stretch contains an
     * idle gap long enough to pin the chain. While it does not, step out to
     * the next rung and open only the transcripts the previous rungs did not -
     * every step reuses everything already read, and the loop exits the moment
     * the anchor is proven, so the common case (a gap in the first stretch)
     * opens no extra file at all.
     */
    let knownFromMs = scanFromMs;
    let gap = findAnchorGap(anchorStamps, knownFromMs, sessionMs, nowMs);
    let widenedFiles = 0;
    let widenedIncomplete = 0;
    /** Extra transcripts the step that hit the file ceiling wanted to open. */
    let overBudget: number | null = null;

    if (gap === null && anchorFloorMs < knownFromMs) {
      // One directory walk and one stat pass serves every rung, and each rung
      // takes the slice it needs from it, so no transcript is ever listed,
      // stat-ed or opened twice however far the search widens.
      const candidates = await statFiles(
        await listTranscripts(opts.claudeDir, { since: new Date(anchorFloorMs) }),
      );
      const opened = new Set(selection.files);

      for (const rungMs of ladder) {
        const floorMs = nowMs - rungMs;
        // Already inside what we have read - nothing to widen to.
        if (floorMs >= knownFromMs) continue;

        const step: string[] = [];
        for (const candidate of candidates) {
          if (candidate.mtimeMs < floorMs) continue;
          if (opened.has(candidate.file)) continue;
          step.push(candidate.file);
        }
        step.sort();

        // A half-read step could invent an idle gap that is not there, so a
        // step that does not fit the budget is not started.
        if (widenedFiles + step.length > MAX_ANCHOR_WIDENING_FILES) {
          overBudget = widenedFiles + step.length;
          ctx.debug(
            `${PROVIDER_ID}: widening the anchor search to ${span(rungMs)} would open ` +
              `${overBudget} extra transcripts, past the ${MAX_ANCHOR_WIDENING_FILES}-file ` +
              `ceiling; stopping at ${span(nowMs - knownFromMs)}`,
          );
          break;
        }

        for (const file of step) opened.add(file);
        const widened = await scanTranscripts({
          files: step,
          fromMs: anchorFloorMs,
          toMs: scanToMs,
          ctx,
          // Timestamps only. Nothing has been appended to these transcripts
          // since `scanFrom`, so every event in them predates the weekly
          // window and predates any window that could still be open: they can
          // move the anchor, and they cannot add a token to either reading.
          // (The one exception is a transcript `maxFiles` dropped, which the
          // reading already discloses as an undercount either way.)
          onBatch: (batch) => {
            for (const event of batch) {
              const at = event.at.getTime();
              if (Number.isFinite(at)) anchorStamps.push(at);
            }
          },
        });

        widenedFiles += widened.scanned;
        widenedIncomplete += widened.incomplete;
        knownFromMs = floorMs;
        gap = findAnchorGap(anchorStamps, knownFromMs, sessionMs, nowMs);

        ctx.debug(
          `${PROVIDER_ID}: widened the anchor search to ${span(rungMs)} ` +
            `(+${widened.scanned} ${plural(widened.scanned, 'transcript')}, ` +
            `${widenedFiles} extra so far) - ` +
            (gap === null
              ? 'still no idle gap'
              : `idle gap of ${span(gap.gapMs)} found at ${new Date(gap.fromMs).toISOString()}`),
        );
        if (gap !== null) break;
      }
    }

    // Chain the windows over everything the search has complete knowledge of,
    // and keep the one that is open now.
    const sessionWindow = activityAnchoredWindow(
      anchorStamps.map((ms) => new Date(ms)),
      now,
      { hours: opts.sessionHours },
    );
    const sessionAcc = makeAccumulator(
      'session',
      sessionWindow.live
        ? { start: sessionWindow.start, end: sessionWindow.end }
        : { start: null, end: null },
      opts.session,
    );
    foldEvents(sessionAcc, sessionCandidates);

    /*
     * What is left to doubt?
     *
     * A gap found is a proof (see `findAnchorGap`), so the only remaining ways
     * to be unsure are: the search reached the end of the ladder or its file
     * ceiling without finding one, or the stretch it searched was not actually
     * complete because a transcript was dropped or could not be read.
     */
    const searchedMs = nowMs - knownFromMs;
    const doubts: string[] = [];
    if (gap === null) {
      const preamble =
        `no idle gap of ${hours(opts.sessionHours)} hours appears anywhere in the ` +
        `${span(searchedMs)} of history searched`;
      doubts.push(
        overBudget === null
          ? `${preamble}, which is as far back as the search goes, so a message before that ` +
              `may have opened this window`
          : `${preamble}, and widening it further would have opened ${group(overBudget)} more ` +
              `transcripts in one refresh, so a message before that may have opened this window`,
      );
    }
    if (selection.truncatedFrom !== null) {
      doubts.push(
        `the ${`providers.${PROVIDER_ID}.maxFiles`} cap dropped transcripts that could hold ` +
          `the message that opened the window`,
      );
    }
    if (base.incomplete + widenedIncomplete > 0) {
      doubts.push('a transcript could not be read to the end, so it may hide that message');
    }

    const anchor: AnchorReport = {
      window: sessionWindow,
      searchedMs,
      sessionHours: opts.sessionHours,
      doubts,
    };

    ctx.debug(
      sessionWindow.live
        ? `${PROVIDER_ID}: session window anchored to activity at ` +
            `${sessionWindow.start.toISOString()}, resets ${sessionWindow.end.toISOString()}` +
            `${doubts.length > 0 ? ' (anchor uncertain)' : ''}`
        : `${PROVIDER_ID}: no session window is open (${sessionWindow.reason})`,
    );

    return [
      buildReading(sessionAcc, opts, scan, anchor),
      ...streamed.map((acc) => buildReading(acc, opts, scan)),
    ];
  },
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
