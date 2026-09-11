/**
 * Line parser for Codex rollout files - the rate-limit snapshot only.
 *
 * Source of truth on disk:
 *   $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<UTC-timestamp>-<uuid>.jsonl
 * (CODEX_HOME defaults to ~/.codex), one JSON object per line. The line we
 * want looks like this, verbatim from a real file and wrapped here for
 * reading only - on disk it is a single line:
 *
 *   {"timestamp":"2026-09-07T08:32:02.043Z","type":"event_msg","payload":{
 *     "type":"token_count",
 *     "info":{...token counts we deliberately ignore...},
 *     "rate_limits":{
 *       "limit_id":"codex","limit_name":null,
 *       "primary":{"used_percent":0.0,"window_minutes":300,"resets_at":1788787915},
 *       "secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1789374715},
 *       "credits":{"has_credits":false,"unlimited":false,"balance":"0"},
 *       "plan_type":"plus", ...}}}
 *
 * ==========================================================================
 *  PRIVACY. READ THIS BEFORE EDITING ANYTHING BELOW.
 * ==========================================================================
 *  A rollout file is a full transcript: the user's prompts, the model's
 *  replies, tool output and absolute paths, all in cleartext. This module
 *  therefore reads exactly one thing out of a line - the `rate_limits`
 *  object - and copies nothing else, not even into an error path:
 *
 *    - only lines with payload.type === "token_count" are looked at at all;
 *    - a line we cannot use returns null, with no diagnostic derived from it;
 *    - no raw line, no fragment of one, and no unrecognized field ever
 *      reaches a return value, a thrown message, a note or a debug string.
 *      A caller that wants to report a bad line may report its NUMBER.
 *
 *  `~/.codex/auth.json` holds OAuth tokens and is never opened by this
 *  package. The plan tier we need is already in the rollout files (see
 *  `planLabel`), so there is no reason to go near it. Do not add one.
 *
 * ==========================================================================
 *  WHY THIS PARSER MATTERS: IT IS OUR FIRST `reported` SOURCE.
 * ==========================================================================
 *  Claude Code publishes no cap, so that adapter has to supply a denominator
 *  and every reading it emits is `derived` - and when our guessed caps turned
 *  out to be wrong by roughly 7x we had to null every one of them out. Codex
 *  hands us OpenAI's own verdict, `used_percent`, so readings built from this
 *  snapshot are the honest kind: unit 'percent', used = usedPercent,
 *  limit = 100, confidence 'reported'.
 *
 *  Never recompute a percentage from the token counts in `info`. OpenAI
 *  publishes no cap, so any denominator we invented would repeat exactly the
 *  mistake we just spent a day undoing. That is why this module does not even
 *  read `info`.
 *
 * SCOPE. Nothing here touches the filesystem; it is pure so tests stay
 * deterministic and so the streaming reader can hand it lines from anywhere.
 * Codex compresses rollouts older than seven days to `.jsonl.zst`, and we add
 * no zstd dependency, so skipping those files - and counting them, so the gap
 * is visible rather than silent - belongs to the reader, not here.
 *
 * Like every parser in this project, this one never throws. The upstream
 * format is undocumented and unversioned, so every field is optional and
 * untrusted, and anything we cannot fully understand is refused rather than
 * guessed at.
 */

/** One rate-limit window exactly as OpenAI reported it. */
export interface RateWindow {
  /**
   * OpenAI's own percentage, 0-100. This is the number we show; it is never
   * recomputed from local token counts.
   */
  usedPercent: number;
  /** Length of the window. 300 is the five-hour window, 10080 the week. */
  windowMinutes: number;
  /** When the window rolls over. Converted from UNIX SECONDS. */
  resetsAt: Date;
  /**
   * Present, and always `true`, only when `used_percent` fell outside 0-100
   * and we clamped it. Absent on every honest reading, so a caller can say
   * "OpenAI reported 150%, shown as 100%" instead of quietly presenting the
   * clamped figure as the reported one.
   */
  clamped?: true;
}

/** The whole rate-limit picture from one `token_count` line. */
export interface RateSnapshot {
  /** The line's own timestamp: when this snapshot was true. */
  at: Date;
  /** Raw plan tier, e.g. "plus". Pass through `planLabel` to display it. */
  planType: string | null;
  /** Which limit family the numbers belong to, e.g. "codex". */
  limitId: string | null;
  /** The short rolling window - `window_minutes` under a day. */
  session: RateWindow | null;
  /** The long rolling window - `window_minutes` of a day or more. */
  weekly: RateWindow | null;
  /**
   * Credit balance, when the line carries one. `balance` is a STRING
   * upstream ("0"), and we keep it a string rather than parsing it into a
   * number whose units and precision we would then be guessing at.
   */
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
}

/**
 * Keys under `rate_limits` that can hold a window, in the order we trust them.
 *
 * The ORDER here decides nothing about which window is which - see
 * `classifyWindow` - it only breaks ties when two entries land in the same
 * bucket. "primary" first means the earlier key wins and the later one is
 * ignored, never overwriting a window we already accepted.
 */
const WINDOW_KEYS = ['primary', 'secondary'] as const;

/**
 * A window of a full day or longer is the weekly window; anything shorter is
 * the session window.
 *
 * Observed values are 300 (five hours) and 10080 (seven days), and the
 * threshold sits in the enormous empty gap between them so an unannounced
 * change - a six-hour session window, a fortnightly cap - still lands in the
 * right bucket.
 *
 * We classify on this number and NEVER on whether the key was called
 * "primary" or "secondary". Nothing we have verified promises that ordering,
 * and getting it backwards would report a nearly-exhausted week as a
 * comfortable five-hour window, which is the exact class of confident wrong
 * number this tool exists to avoid.
 */
const WEEKLY_MINUTES_THRESHOLD = 1440;

/** Shown for a plan tier we do not recognize, and for no other reason. */
const UNKNOWN_PLAN_LABEL = 'Unknown plan';

type JsonRecord = Record<string, unknown>;

/**
 * ISO-8601 date-time with an EXPLICIT zone designator - a trailing `Z`, or a
 * `+HH:MM` / `-HHMM` offset.
 *
 * Stricter than `new Date(string)` on purpose. V8 reads a zone-less ISO
 * date-time as LOCAL time, so on a UTC+8 machine `"2026-09-07T08:32:02.043"`
 * silently becomes `2026-09-07T00:32:02.043Z` while `getTime()` stays a
 * perfectly valid number, meaning a NaN guard never fires. An eight-hour
 * shift decides whether one snapshot looks newer than another, i.e. which
 * percentage we print, and it would make the same rollout file read
 * differently on two machines. Every timestamp observed in these files ends
 * in `Z`, so refusing the rest costs nothing real.
 */
const INSTANT_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/** True for plain JSON objects only. Arrays and null are not records. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string at `key`, or null. Empty strings count as absent. */
function readString(source: JsonRecord, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A boolean at `key`. Anything else - missing, "true", 1 - reads as false. */
function readBoolean(source: JsonRecord, key: string): boolean {
  return source[key] === true;
}

/**
 * The instant `raw` names, or null when it does not unambiguously name one.
 * Never guesses a zone; see `INSTANT_WITH_ZONE`.
 */
function parseInstant(raw: string): Date | null {
  if (!INSTANT_WITH_ZONE.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * `resets_at` as a Date, or null when the field cannot be one.
 *
 * The value is UNIX SECONDS, not milliseconds - 1788787915 is 2026-09-07
 * 13:31:55Z, while the same number read as milliseconds would be an afternoon
 * in January 1970. Only a finite number strictly greater than zero is
 * accepted: 0 is upstream's "no reset recorded" and a negative reset is
 * meaningless, and neither may become a date the UI then counts down to.
 * Strings are refused rather than coerced, and a magnitude that overflows the
 * Date range is caught by the NaN check.
 */
function readResetsAt(source: JsonRecord): Date | null {
  const value = source['resets_at'];
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  const at = new Date(value * 1000);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * `used_percent` clamped into 0-100, plus whether clamping actually happened,
 * or null when the field is not a finite number.
 *
 * NaN and Infinity are REFUSED, not clamped. `Math.min(100, Infinity)` is
 * 100, and we have already shipped that bug once: a garbage numerator became
 * a confident, fully-red "100% used" bar that a user would act on. A missing
 * window is honest; a fabricated exhausted one is not. `1e999` in a JSON file
 * parses to `Infinity`, so this is a live path and not a theoretical one.
 */
function readUsedPercent(source: JsonRecord): { value: number; clamped: boolean } | null {
  const value = source['used_percent'];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return { value: 0, clamped: true };
  if (value > 100) return { value: 100, clamped: true };
  return { value, clamped: false };
}

/**
 * One window object -> `RateWindow`, or null when any of its three
 * load-bearing fields is unusable. All three are required: a percentage with
 * no window length cannot be labelled, and one with no reset time cannot be
 * counted down. Partial windows are dropped rather than half-reported.
 */
function readWindow(value: unknown): RateWindow | null {
  if (!isRecord(value)) return null;

  const percent = readUsedPercent(value);
  if (percent === null) return null;

  const minutes = value['window_minutes'];
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return null;

  const resetsAt = readResetsAt(value);
  if (resetsAt === null) return null;

  const window: RateWindow = { usedPercent: percent.value, windowMinutes: minutes, resetsAt };
  // exactOptionalPropertyTypes: set the flag only when it is true, never to
  // undefined, so `'clamped' in window` means what it says.
  if (percent.clamped) window.clamped = true;
  return window;
}

/** 'session' for a sub-day window, 'weekly' for a day or longer. */
function classifyWindow(window: RateWindow): 'session' | 'weekly' {
  return window.windowMinutes < WEEKLY_MINUTES_THRESHOLD ? 'session' : 'weekly';
}

/**
 * The `credits` object, or null when the line does not carry a usable one.
 *
 * `balance` stays a string because that is what upstream sends ("0"). A
 * number there would be a shape we have not seen, so it reads as null rather
 * than being coerced into one we would have to explain.
 */
function readCredits(value: unknown): RateSnapshot['credits'] {
  if (!isRecord(value)) return null;
  return {
    hasCredits: readBoolean(value, 'has_credits'),
    unlimited: readBoolean(value, 'unlimited'),
    balance: readString(value, 'balance'),
  };
}

/**
 * Turn one raw rollout line into a `RateSnapshot`.
 *
 * Returns null - never throws - for a blank line, invalid or truncated JSON,
 * any record that is not `type: "event_msg"`, any event whose `payload.type`
 * is not `"token_count"`, a `token_count` whose `rate_limits` is null or
 * otherwise not an object, and a line with no unambiguous timestamp. Nothing
 * from the line appears in the null case; a caller that needs to report the
 * failure should report the line NUMBER.
 *
 * A snapshot IS returned when `rate_limits` is present but its windows are
 * unusable - `session` and `weekly` are then null. That distinction matters
 * to the caller: "OpenAI told us nothing usable about the windows" is a
 * different fact from "this line was not about rate limits at all".
 *
 * The timestamp is required because a snapshot with no instant cannot be
 * ordered against another one, and picking the newest snapshot is the whole
 * job of the reader above this. We would rather skip a line than invent the
 * instant that decides which percentage the user sees.
 */
export function parseRateLimitLine(line: string): RateSnapshot | null {
  try {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Truncated or corrupt line. The exception's message quotes part of the
      // line, which is exactly what must not escape this module, so it is
      // swallowed here rather than rethrown, wrapped or logged.
      return null;
    }
    if (!isRecord(parsed)) return null;
    if (readString(parsed, 'type') !== 'event_msg') return null;

    const payload = parsed['payload'];
    if (!isRecord(payload)) return null;
    if (readString(payload, 'type') !== 'token_count') return null;

    // Everything from here reads `rate_limits` and nothing else. `payload.info`
    // holds token counts we must not turn into a percentage, and the rest of
    // the file holds the user's prompts.
    const rateLimits = payload['rate_limits'];
    if (!isRecord(rateLimits)) return null;

    const timestamp = readString(parsed, 'timestamp') ?? readString(payload, 'timestamp');
    if (timestamp === null) return null;
    const at = parseInstant(timestamp);
    if (at === null) return null;

    let session: RateWindow | null = null;
    let weekly: RateWindow | null = null;
    for (const key of WINDOW_KEYS) {
      const window = readWindow(rateLimits[key]);
      if (window === null) continue;
      if (classifyWindow(window) === 'session') {
        // First one into a bucket keeps it. Overwriting would let the last
        // key silently decide the number we print.
        if (session === null) session = window;
      } else if (weekly === null) {
        weekly = window;
      }
    }

    return {
      at,
      planType: readString(rateLimits, 'plan_type'),
      limitId: readString(rateLimits, 'limit_id'),
      session,
      weekly,
      credits: readCredits(rateLimits['credits']),
    };
  } catch {
    // Belt and braces. A reader streaming undocumented JSONL must never see
    // this function throw, whatever ends up on the line - and an escaping
    // exception would carry line content in its message.
    return null;
  }
}

/**
 * Display labels for the plan tiers `plan_type` can carry.
 *
 * "plus" and "prolite" are the two observed on real machines; the rest come
 * from the upstream enum. Keys are already normalized - lowercased with every
 * non-alphanumeric character removed - so "pro_lite", "Pro-Lite" and
 * "prolite" all land on the same row.
 */
const PLAN_LABELS: ReadonlyMap<string, string> = new Map<string, string>([
  ['free', 'Free'],
  ['go', 'Go'],
  ['plus', 'Plus'],
  ['pro', 'Pro'],
  ['prolite', 'Pro Lite'],
  ['team', 'Team'],
  ['business', 'Business'],
  ['enterprise', 'Enterprise'],
  ['edu', 'Education'],
  ['education', 'Education'],
  ['unknown', UNKNOWN_PLAN_LABEL],
]);

/**
 * Substring fallbacks for tier spellings we have not seen literally -
 * "enterprise_seat", "edu_teacher", "business_v2" and whatever comes next.
 *
 * ORDER IS LOAD-BEARING and the list is checked top to bottom: "prolite"
 * contains "pro", so the specific row has to win first.
 */
const PLAN_LABEL_PATTERNS: ReadonlyArray<readonly [needle: string, label: string]> = [
  ['prolite', 'Pro Lite'],
  ['enterprise', 'Enterprise'],
  ['education', 'Education'],
  ['business', 'Business'],
  ['team', 'Team'],
  ['plus', 'Plus'],
  ['pro', 'Pro'],
  ['free', 'Free'],
];

/**
 * A human label for a raw `plan_type`.
 *
 * Never throws and never fails on an unseen value: anything unrecognized -
 * including null, an empty string, and a tier OpenAI ships tomorrow - returns
 * "Unknown plan", which is a label rather than an error. The tier only
 * decorates a reading and is never a denominator, so being wrong here costs a
 * word in the UI, not a wrong percentage.
 */
export function planLabel(planType: string | null): string {
  if (typeof planType !== 'string') return UNKNOWN_PLAN_LABEL;

  const key = planType.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key === '') return UNKNOWN_PLAN_LABEL;

  const exact = PLAN_LABELS.get(key);
  if (exact !== undefined) return exact;

  // "edu" as a prefix only: as a substring it turns up inside ordinary words
  // ("scheduled") and would mislabel a tier we should be honest about.
  if (key.startsWith('edu')) return 'Education';

  for (const [needle, label] of PLAN_LABEL_PATTERNS) {
    if (key.includes(needle)) return label;
  }

  return UNKNOWN_PLAN_LABEL;
}
