/**
 * Line parser for Claude Code session transcripts.
 *
 * Source of truth on disk:
 *   ~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl
 * one JSON object per line. Records with `"type":"assistant"` carry a `usage`
 * object; everything else on the line is metadata.
 *
 * The upstream format is undocumented and unversioned, so every field here is
 * treated as optional and untrusted. The contract of this module is that it
 * never throws and never invents data: a record we cannot fully understand is
 * skipped by returning null, and the caller drops that one line rather than
 * failing the file. "Never invents" is meant literally, and it is why a
 * timestamp with no zone designator and a token count of implausible magnitude
 * are both refused - reading either would produce a number rather than a gap,
 * and a wrong number is the one output this tool must not produce.
 *
 * ONE RECORD IS NOT ONE API CALL. Claude Code writes a separate assistant
 * record for each content block of a response and repeats the same cumulative
 * `usage` object on every one of them. `parseLine` is per-record by design, so
 * it surfaces `requestId` and `messageId` and leaves the collapsing to
 * `dedupeEvents` at the bottom of this file. A caller that sums `parseLine`
 * output without de-duplicating overcounts by a factor of roughly 2.8.
 *
 * Nothing in this file reads the filesystem. It is pure so the streaming reader
 * can hand it lines from anywhere and so tests stay deterministic.
 */

import type { TokenCounts, UsageEvent } from '../../core/types.js';
import { ZERO_TOKENS } from '../../core/types.js';

/** Adapter id these events belong to. Matches the directory name. */
const PROVIDER_ID = 'claude-code';

/**
 * Used when a record carries usage but no model name. Better than dropping a
 * real token count, and visibly not a model id, so it cannot be mistaken for
 * one in a per-model breakdown.
 */
const UNKNOWN_MODEL = 'unknown';

type JsonRecord = Record<string, unknown>;

/**
 * ISO-8601 date-time with an EXPLICIT zone designator - a trailing `Z`, or a
 * `+HH:MM` / `-HHMM` offset. Nothing else is accepted as an instant.
 *
 * This is stricter than `new Date(string)` on purpose. V8 falls back to a
 * lenient parser for anything not in the ISO grammar and, worse, reads a
 * zone-less ISO date-time as LOCAL time: on a UTC+8 machine
 * `"2026-09-11T01:30:26.137"` becomes `2026-09-10T17:30:26.137Z`, an eight
 * hour shift, and `"2026-09-11 01:30:26"` and `"Sep 11 2026 01:30:26"` do the
 * same. `new Date()` returns a perfectly valid Date for all three, so a
 * `Number.isNaN(getTime())` guard never fires and the invented instant is
 * indistinguishable from a recorded one.
 *
 * That matters here more than it looks. Quota windows are UTC - the session
 * block is anchored to 00:00/05:00/10:00/15:00/20:00 UTC - so a displaced
 * event drops out of the current window entirely, and near a week boundary it
 * lands in the wrong week. It would also make the same transcript read
 * differently on two machines, which is not a number this tool may print.
 * Every one of the 100,577 assistant timestamps currently on disk ends in `Z`,
 * so nothing real is lost by refusing the rest.
 */
const INSTANT_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * The instant `raw` names, or null when it does not unambiguously name one.
 *
 * Never guesses a zone. See `INSTANT_WITH_ZONE` for why a zone-less string is
 * rejected rather than read as local time.
 */
function parseInstant(raw: string): Date | null {
  if (!INSTANT_WITH_ZONE.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** True for plain JSON objects only. Arrays and null are not records. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string at `key`, or null. Empty strings count as absent. */
function readString(source: JsonRecord | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Largest per-call token count this parser will believe: one billion.
 *
 * The biggest real count measured across every transcript on a heavy user's
 * machine is 999,146 - three orders of magnitude below this ceiling - and no
 * Anthropic context window is within two orders of magnitude of it. So a value
 * above this did not come from a model; it came from a garbled digit run, a
 * unit change we have not been told about, or a field that now means something
 * else. Any of those is a reason to report zero rather than a number.
 */
export const MAX_TOKENS_PER_CALL = 1_000_000_000;

/**
 * A usable token count at `key`, or null when the field is missing, is not a
 * number, or carries a magnitude no real call can have.
 *
 * Strings are rejected rather than coerced: if upstream ever starts sending
 * `"input_tokens": "2"` we would rather report zero than guess at a number
 * whose units we no longer understand. The same reasoning governs magnitude,
 * and it has to, because the alternative is worse than a missing number:
 * `1e308` is a finite number, so a `Number.isFinite` guard passes it through,
 * two of them sum to `Infinity`, and `Math.min(100, Infinity / limit * 100)`
 * renders as a confident, fully-red 100% bar. A garbled digit run
 * (`99999999999999999999999` -> `1e+23`) does the same thing more quietly.
 * `Number.isSafeInteger` therefore rejects non-integers, values beyond 2^53
 * and NaN/Infinity in one test, and `MAX_TOKENS_PER_CALL` rejects the rest of
 * the implausible range. Negative counts, which are never meaningful, clamp
 * to 0.
 */
function readCount(source: JsonRecord, key: string): number | null {
  const value = source[key];
  if (typeof value !== 'number') return null;
  if (!Number.isSafeInteger(value)) return null;
  if (value > MAX_TOKENS_PER_CALL) return null;
  return value < 0 ? 0 : value;
}

/**
 * Normalize a raw `usage` object into `TokenCounts`.
 *
 * Missing, non-numeric and non-finite fields become 0; negative values clamp to
 * 0. Anything that is not an object at all yields all zeros. Never throws.
 *
 * Field mapping (upstream -> ours):
 *   input_tokens                        -> input
 *   output_tokens                       -> output
 *   cache_creation_input_tokens         -> cacheCreation
 *   cache_read_input_tokens             -> cacheRead
 *   output_tokens_details.thinking_tokens -> thinking
 *
 * `cacheRead` is deliberately kept separate: it is billed at a small fraction
 * of `input` and is usually the largest number by an order of magnitude, so
 * summing these five into a single "tokens used" figure would be dishonest.
 */
export function coerceTokens(usage: unknown): TokenCounts {
  if (!isRecord(usage)) return { ...ZERO_TOKENS };

  const details = usage['output_tokens_details'];
  const nestedThinking = isRecord(details) ? readCount(details, 'thinking_tokens') : null;

  return {
    input: readCount(usage, 'input_tokens') ?? 0,
    output: readCount(usage, 'output_tokens') ?? 0,
    cacheCreation: readCount(usage, 'cache_creation_input_tokens') ?? 0,
    cacheRead: readCount(usage, 'cache_read_input_tokens') ?? 0,
    // Older and newer shapes have carried thinking at the usage root; prefer
    // the documented nested location and fall back to it.
    thinking: nestedThinking ?? readCount(usage, 'thinking_tokens') ?? 0,
  };
}

/**
 * Turn one raw JSONL line into a `UsageEvent`.
 *
 * Returns null - never throws - for a blank line, invalid or truncated JSON, a
 * record that is not an assistant message, a record with no usage object, and a
 * record whose timestamp is missing or unparseable. A timestamp is never
 * invented: an event with no defensible `at` cannot be placed in a quota window
 * and so is not an event we can use.
 *
 * The usage object is read from the record root, then from `.message.usage`.
 * The model name is read from the record root, then from `.message.model`.
 */
export function parseLine(line: string): UsageEvent | null {
  try {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;

    const message = isRecord(parsed['message']) ? parsed['message'] : null;

    // `type` decides when present; otherwise fall back to the message role, so
    // a record that only carries the API response shape still parses.
    const type = readString(parsed, 'type');
    const role = readString(message, 'role');
    if (type !== null ? type !== 'assistant' : role !== 'assistant') return null;

    const rootUsage = parsed['usage'];
    const nestedUsage = message === null ? undefined : message['usage'];
    const usage = isRecord(rootUsage) ? rootUsage : isRecord(nestedUsage) ? nestedUsage : null;
    if (usage === null) return null;

    const timestamp = readString(parsed, 'timestamp') ?? readString(message, 'timestamp');
    if (timestamp === null) return null;
    const at = parseInstant(timestamp);
    if (at === null) return null;

    const event: UsageEvent = {
      provider: PROVIDER_ID,
      at,
      model: readString(parsed, 'model') ?? readString(message, 'model') ?? UNKNOWN_MODEL,
      tokens: coerceTokens(usage),
    };

    // Optional properties are only set when we actually have a value:
    // exactOptionalPropertyTypes forbids assigning undefined to them.
    const project = readString(parsed, 'cwd');
    if (project !== null) event.project = project;

    const sessionId = readString(parsed, 'sessionId') ?? readString(parsed, 'session_id');
    if (sessionId !== null) event.sessionId = sessionId;

    // Call identity. Claude Code writes one record per content block of a
    // single response and repeats the same cumulative usage object on each, so
    // without these two fields no caller can tell three records of one call
    // from three calls. See `dedupeEvents`.
    const requestId = readString(parsed, 'requestId') ?? readString(parsed, 'request_id');
    if (requestId !== null) event.requestId = requestId;

    const messageId = readString(message, 'id') ?? readString(parsed, 'message_id');
    if (messageId !== null) event.messageId = messageId;

    return event;
  } catch {
    // Belt and braces: a caller streaming 876 MB of undocumented JSONL must
    // never see this function throw, whatever ends up on the line.
    return null;
  }
}

/**
 * The identity of the API call an event describes, or null when the record
 * does not name one.
 *
 * Claude Code emits one `type: "assistant"` record per content block of a
 * single response - thinking, then text, then each tool_use - and repeats the
 * SAME cumulative `usage` object on every one of them. Three such records are
 * one API call, one bill, and one entry in a quota window; summing them
 * triples the numerator. Measured over a real transcript, the naive sum is
 * 150,612 input+output tokens against a true 54,289.
 *
 * The key requires `message.id`, the id the API assigned the response, because
 * that is the field that actually identifies a call: it is present on every
 * duplicate observed on disk (27,460 of 27,468 assistant records; the other 8
 * carry it without a requestId, and none carry a requestId without it) and is
 * never shared by two distinct responses. `requestId` is folded in when
 * present, so two calls could only collide by sharing both, but it is not
 * sufficient on its own - it is a transport identifier, and treating a reused
 * one as a duplicate would silently merge real calls, an undercount, which is
 * a worse failure than the overcount we are fixing.
 */
export function usageEventKey(event: UsageEvent): string | null {
  const messageId = event.messageId;
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  const requestId = typeof event.requestId === 'string' ? event.requestId : '';
  return `${requestId}\u0000${messageId}`;
}

/**
 * Collapse the repeated records of one API call down to one event.
 *
 * LAST WINS, and that is not arbitrary: the repeated usage object is
 * cumulative and sometimes still growing when the earlier records are written.
 * A real subagent transcript records `output_tokens: 3` and then
 * `output_tokens: 26069` for the same `(requestId, message.id)` pair four
 * minutes apart; keeping the first would undercount that call by 26,066
 * tokens. The surviving event therefore also carries the LATEST timestamp for
 * the call, which is the one that reflects when it completed.
 *
 * Events with no `usageEventKey` - a shape that records no message id - are
 * passed through untouched rather than merged, because merging on a partial
 * identity risks discarding real calls.
 *
 * Order is preserved by first appearance, so a caller that relies on the
 * events arriving roughly in file order still gets that. Input is never
 * mutated.
 */
export function dedupeEvents(events: Iterable<UsageEvent>): UsageEvent[] {
  const out: UsageEvent[] = [];
  const slotOf = new Map<string, number>();

  for (const event of events) {
    if (event === null || event === undefined) continue;
    const key = usageEventKey(event);
    if (key === null) {
      out.push(event);
      continue;
    }
    const slot = slotOf.get(key);
    if (slot === undefined) {
      slotOf.set(key, out.length);
      out.push(event);
    } else {
      out[slot] = event;
    }
  }

  return out;
}
