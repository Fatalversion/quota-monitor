import { describe, it, expect } from 'vitest';

import type { UsageEvent } from '../../core/types.js';
import { ZERO_TOKENS } from '../../core/types.js';
import {
  MAX_TOKENS_PER_CALL,
  coerceTokens,
  dedupeEvents,
  parseLine,
  usageEventKey,
} from './parse.js';

/**
 * A real assistant record, copied from a transcript on disk. The `usage` object
 * is verbatim; the surrounding fields are the ones such a record actually
 * carries. String.raw keeps the JSON escaping (`\\`) intact so the parsed cwd
 * is a genuine Windows path.
 */
const VERBATIM_LINE = String.raw`{"type":"assistant","timestamp":"2026-09-11T01:30:26.137Z","model":"claude-opus-5","sessionId":"0ad77082-7c17-4558-8c3d-2cfd7cdd4cc1","cwd":"l:\\Open Source\\quota-monitor","gitBranch":"main","version":"2.0.14","requestId":"req_011CTv9k2p","uuid":"4f0a1f2c-6d55-4a1e-9f2b-1c0d8e7a5b31","service_tier":"standard","effort":"high","stop_reason":"end_turn","apiBlockIndex":3,"usage":{"input_tokens":2,"cache_creation_input_tokens":24408,"cache_read_input_tokens":30207,"output_tokens":178,"output_tokens_details":{"thinking_tokens":0}}}`;

const EXPECTED_CWD = String.raw`l:\Open Source\quota-monitor`;

/** Parse or fail the test, so assertions below need no null juggling. */
function mustParse(line: string): UsageEvent {
  const event = parseLine(line);
  if (event === null) throw new Error(`expected a UsageEvent, got null for: ${line.slice(0, 120)}`);
  return event;
}

describe('coerceTokens', () => {
  it('maps every field of the verbatim usage object', () => {
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 24408,
      cache_read_input_tokens: 30207,
      output_tokens: 178,
      output_tokens_details: { thinking_tokens: 0 },
    };

    expect(coerceTokens(usage)).toEqual({
      input: 2,
      output: 178,
      cacheCreation: 24408,
      cacheRead: 30207,
      thinking: 0,
    });
  });

  it('reads thinking tokens from the nested details object', () => {
    const usage = { output_tokens: 900, output_tokens_details: { thinking_tokens: 512 } };

    expect(coerceTokens(usage)).toEqual({
      input: 0,
      output: 900,
      cacheCreation: 0,
      cacheRead: 0,
      thinking: 512,
    });
  });

  it('falls back to a root-level thinking_tokens when details are absent', () => {
    expect(coerceTokens({ thinking_tokens: 64 }).thinking).toBe(64);
  });

  it('ignores a malformed details field', () => {
    expect(coerceTokens({ output_tokens_details: 'nope' }).thinking).toBe(0);
    expect(coerceTokens({ output_tokens_details: null }).thinking).toBe(0);
    expect(coerceTokens({ output_tokens_details: [1, 2] }).thinking).toBe(0);
    expect(coerceTokens({ output_tokens_details: { thinking_tokens: 'lots' } }).thinking).toBe(0);
  });

  it('treats missing fields as zero', () => {
    expect(coerceTokens({})).toEqual(ZERO_TOKENS);
    expect(coerceTokens({ input_tokens: 5 })).toEqual({
      input: 5,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      thinking: 0,
    });
  });

  it('treats non-numeric field values as zero', () => {
    const usage = {
      input_tokens: '2',
      output_tokens: null,
      cache_creation_input_tokens: true,
      cache_read_input_tokens: { n: 5 },
      output_tokens_details: { thinking_tokens: [] },
    };

    expect(coerceTokens(usage)).toEqual(ZERO_TOKENS);
  });

  it('treats NaN and Infinity as zero', () => {
    const usage = { input_tokens: Number.NaN, output_tokens: Number.POSITIVE_INFINITY };
    expect(coerceTokens(usage)).toEqual(ZERO_TOKENS);
  });

  it('clamps negative counts to zero', () => {
    const usage = {
      input_tokens: -1,
      output_tokens: -0.5,
      cache_creation_input_tokens: -24408,
      cache_read_input_tokens: 30207,
      output_tokens_details: { thinking_tokens: -7 },
    };

    expect(coerceTokens(usage)).toEqual({
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 30207,
      thinking: 0,
    });
  });

  it('returns all zeros for anything that is not an object', () => {
    const inputs: unknown[] = [undefined, null, 'usage', 42, true, [1, 2, 3], () => 1];
    for (const input of inputs) {
      expect(coerceTokens(input)).toEqual(ZERO_TOKENS);
    }
  });

  it('returns a fresh mutable object rather than sharing ZERO_TOKENS', () => {
    const a = coerceTokens(undefined);
    const b = coerceTokens(undefined);
    expect(a).not.toBe(b);
    expect(a).not.toBe(ZERO_TOKENS);
    a.input = 99;
    expect(ZERO_TOKENS.input).toBe(0);
    expect(b.input).toBe(0);
  });
});

describe('parseLine', () => {
  it('parses the verbatim assistant record from disk', () => {
    const event = mustParse(VERBATIM_LINE);

    expect(event.provider).toBe('claude-code');
    expect(event.model).toBe('claude-opus-5');
    expect(event.at.toISOString()).toBe('2026-09-11T01:30:26.137Z');
    expect(event.project).toBe(EXPECTED_CWD);
    expect(event.sessionId).toBe('0ad77082-7c17-4558-8c3d-2cfd7cdd4cc1');
    expect(event.tokens).toEqual({
      input: 2,
      output: 178,
      cacheCreation: 24408,
      cacheRead: 30207,
      thinking: 0,
    });
  });

  it('keeps cheap cache reads out of the input count', () => {
    const event = mustParse(VERBATIM_LINE);
    expect(event.tokens.input).toBe(2);
    expect(event.tokens.cacheRead).toBe(30207);
  });

  it('tolerates surrounding whitespace and a CRLF line ending', () => {
    const event = mustParse(`  ${VERBATIM_LINE}\r\n`);
    expect(event.at.toISOString()).toBe('2026-09-11T01:30:26.137Z');
    expect(event.tokens.output).toBe(178);
  });

  it('reads usage and model nested under .message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-10T22:15:00.000Z',
      sessionId: 'sess-nested',
      cwd: '/home/dev/api',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 11,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 250000,
          output_tokens: 640,
          output_tokens_details: { thinking_tokens: 128 },
        },
      },
    });

    const event = mustParse(line);
    expect(event.model).toBe('claude-sonnet-4-5');
    expect(event.project).toBe('/home/dev/api');
    expect(event.sessionId).toBe('sess-nested');
    expect(event.at.toISOString()).toBe('2026-09-10T22:15:00.000Z');
    expect(event.tokens).toEqual({
      input: 11,
      output: 640,
      cacheCreation: 1000,
      cacheRead: 250000,
      thinking: 128,
    });
  });

  it('accepts a record whose only assistant marker is the message role', () => {
    const line = JSON.stringify({
      timestamp: '2026-09-10T22:16:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', usage: { output_tokens: 3 } },
    });

    const event = mustParse(line);
    expect(event.model).toBe('claude-opus-5');
    expect(event.tokens.output).toBe(3);
  });

  it('prefers a root usage object over the nested one', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-10T22:17:00.000Z',
      model: 'claude-opus-5',
      usage: { output_tokens: 7 },
      message: { role: 'assistant', usage: { output_tokens: 9999 } },
    });

    expect(mustParse(line).tokens.output).toBe(7);
  });

  it('returns null for blank input', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('\n')).toBeNull();
    expect(parseLine('\r\n')).toBeNull();
    expect(parseLine('\t  \t')).toBeNull();
  });

  it('returns null for JSON truncated mid-line', () => {
    const truncated = VERBATIM_LINE.slice(0, 240);
    expect(truncated.length).toBeGreaterThan(0);
    expect(truncated.endsWith('}')).toBe(false);
    expect(parseLine(truncated)).toBeNull();
    expect(parseLine('{"type":"assistant","usage":{"input_tok')).toBeNull();
    expect(parseLine('{"type":"assistant",')).toBeNull();
  });

  it('returns null for a user-type record', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-09-11T01:30:00.000Z',
      sessionId: '0ad77082-7c17-4558-8c3d-2cfd7cdd4cc1',
      cwd: '/home/dev/api',
      message: { role: 'user', content: 'summarize the diff' },
    });

    expect(parseLine(line)).toBeNull();
  });

  it('returns null for a user record that somehow carries usage', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-09-11T01:30:00.000Z',
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    expect(parseLine(line)).toBeNull();
  });

  it('returns null for non-assistant record types', () => {
    for (const type of ['summary', 'system', 'file-history-snapshot', 'progress']) {
      const line = JSON.stringify({
        type,
        timestamp: '2026-09-11T01:30:00.000Z',
        usage: { output_tokens: 5 },
      });
      expect(parseLine(line)).toBeNull();
    }
  });

  it('returns null for an assistant record with no usage object', () => {
    const withoutUsage = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-11T01:30:26.137Z',
      model: 'claude-opus-5',
      message: { role: 'assistant', content: [] },
    });
    expect(parseLine(withoutUsage)).toBeNull();

    const badUsages: unknown[] = [null, 'usage', 42, [1, 2, 3], true];
    for (const usage of badUsages) {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-11T01:30:26.137Z',
        usage,
      });
      expect(parseLine(line)).toBeNull();
    }
  });

  it('returns an all-zero event for an empty but present usage object', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-11T01:30:26.137Z',
      model: 'claude-opus-5',
      usage: {},
    });

    expect(mustParse(line).tokens).toEqual(ZERO_TOKENS);
  });

  it('returns null when a usage-bearing record has no timestamp', () => {
    const line = JSON.stringify({
      type: 'assistant',
      model: 'claude-opus-5',
      sessionId: 'sess-1',
      usage: { input_tokens: 2, output_tokens: 178 },
    });

    expect(parseLine(line)).toBeNull();
  });

  it('returns null rather than inventing a date for an unparseable timestamp', () => {
    const stamps: unknown[] = ['', 'yesterday', 'not-a-date', '2026-13-45T99:99:99Z', 1757554226137, null];
    for (const timestamp of stamps) {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp,
        model: 'claude-opus-5',
        usage: { output_tokens: 178 },
      });
      expect(parseLine(line)).toBeNull();
    }
  });

  it('zeroes negative and string-typed token values but keeps the event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-11T01:30:26.137Z',
      model: 'claude-opus-5',
      sessionId: 'sess-weird',
      cwd: '/home/dev/api',
      usage: {
        input_tokens: '2',
        cache_creation_input_tokens: -24408,
        cache_read_input_tokens: '30207',
        output_tokens: -178,
        output_tokens_details: { thinking_tokens: '0' },
      },
    });

    const event = mustParse(line);
    expect(event.tokens).toEqual(ZERO_TOKENS);
    expect(event.model).toBe('claude-opus-5');
    expect(event.at.toISOString()).toBe('2026-09-11T01:30:26.137Z');
  });

  it('falls back to "unknown" when no model name is recorded', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-11T01:30:26.137Z',
      usage: { output_tokens: 12 },
    });

    expect(mustParse(line).model).toBe('unknown');
  });

  it('omits project and sessionId when the record does not carry them', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-11T01:30:26.137Z',
      model: 'claude-opus-5',
      cwd: '',
      usage: { output_tokens: 12 },
    });

    const event = mustParse(line);
    expect('project' in event).toBe(false);
    expect('sessionId' in event).toBe(false);
  });

  it('accepts a snake_case session_id', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-11T01:30:26.137Z',
      model: 'claude-opus-5',
      session_id: 'sess-snake',
      usage: { output_tokens: 12 },
    });

    expect(mustParse(line).sessionId).toBe('sess-snake');
  });

  it('returns null for completely unexpected shapes', () => {
    const shapes = [
      '{"foo":"bar"}',
      '{}',
      '[1,2,3]',
      '[{"type":"assistant","usage":{"input_tokens":1}}]',
      '"just a string"',
      'null',
      'true',
      '42',
      'undefined',
      '<html><body>nope</body></html>',
      '\u0000\u0001\u0002',
      '{"type":{"nested":"object"},"usage":{"input_tokens":1},"timestamp":"2026-09-11T01:30:26.137Z"}',
    ];

    for (const shape of shapes) {
      expect(parseLine(shape)).toBeNull();
    }
  });

  it('never throws, whatever the line contains', () => {
    const corpus: unknown[] = [
      '',
      '{',
      '}',
      '[',
      VERBATIM_LINE,
      `${VERBATIM_LINE}${VERBATIM_LINE}`,
      'x'.repeat(10000),
      '{"timestamp":"2026-09-11T01:30:26.137Z","message":null,"usage":{}}',
      '{"type":"assistant","timestamp":"2026-09-11T01:30:26.137Z","usage":{"input_tokens":1e400}}',
      null,
      undefined,
      42,
      { type: 'assistant' },
    ];

    // Every prefix of a real line, i.e. every way a torn write can look.
    for (let i = 0; i <= VERBATIM_LINE.length; i += 7) {
      corpus.push(VERBATIM_LINE.slice(0, i));
    }

    for (const input of corpus) {
      expect(() => parseLine(input as string)).not.toThrow();
      const result = parseLine(input as string);
      expect(result === null || result.provider === 'claude-code').toBe(true);
    }
  });

  it('is deterministic: the same line always yields the same event', () => {
    const first = mustParse(VERBATIM_LINE);
    const second = mustParse(VERBATIM_LINE);
    expect(first).toEqual(second);
    expect(first.at.getTime()).toBe(second.at.getTime());
  });
});

/* -------------------------------------------------------------------------- */
/* regressions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Records 29-31 of
 * ~/.claude/projects/l--Open-Source-quota-monitor/0ad77082-...jsonl, verbatim
 * apart from the content blocks, which are elided because the parser never
 * looks at them. One API call, three records: Claude Code writes one assistant
 * record per content block - thinking, then text, then tool_use - with
 * distinct uuids and timestamps and the SAME cumulative usage object on each.
 * Summing the three reports 3 x (2 + 2087) = 6,267 tokens for a call that used
 * 2,089, and 163,845 cache-read tokens for one that read 54,615.
 */
const DUPLICATE_BLOCK_LINES: readonly string[] = [
  '{"type":"assistant","timestamp":"2026-09-11T01:30:59.817Z","uuid":"3914b341-6bc2-4448-84ce-59125e059066","requestId":"req_011CevncBsRU8McX6gpT5Hiw","sessionId":"0ad77082-7c17-4558-8c3d-2cfd7cdd4cc1","message":{"id":"msg_011CevncCPS9Vpk3sF8XKQSv","role":"assistant","model":"claude-opus-5","content":[{"type":"thinking"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":427,"cache_read_input_tokens":54615,"output_tokens":2087,"output_tokens_details":{"thinking_tokens":1916}}}}',
  '{"type":"assistant","timestamp":"2026-09-11T01:31:00.639Z","uuid":"ddc06309-2133-44d8-a78e-4d56ac0b89e1","requestId":"req_011CevncBsRU8McX6gpT5Hiw","sessionId":"0ad77082-7c17-4558-8c3d-2cfd7cdd4cc1","message":{"id":"msg_011CevncCPS9Vpk3sF8XKQSv","role":"assistant","model":"claude-opus-5","content":[{"type":"text"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":427,"cache_read_input_tokens":54615,"output_tokens":2087,"output_tokens_details":{"thinking_tokens":1916}}}}',
  '{"type":"assistant","timestamp":"2026-09-11T01:31:01.592Z","uuid":"dd708e61-238b-40db-8eda-11bd0bba3387","requestId":"req_011CevncBsRU8McX6gpT5Hiw","sessionId":"0ad77082-7c17-4558-8c3d-2cfd7cdd4cc1","message":{"id":"msg_011CevncCPS9Vpk3sF8XKQSv","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":427,"cache_read_input_tokens":54615,"output_tokens":2087,"output_tokens_details":{"thinking_tokens":1916}}}}',
];

describe('call identity (regression: three records, one API call)', () => {
  it('surfaces requestId and message.id so a caller has a dedup key', () => {
    for (const line of DUPLICATE_BLOCK_LINES) {
      const event = mustParse(line);
      expect(event.requestId).toBe('req_011CevncBsRU8McX6gpT5Hiw');
      expect(event.messageId).toBe('msg_011CevncCPS9Vpk3sF8XKQSv');
    }
  });

  it('gives the three records of one call the same key', () => {
    const keys = DUPLICATE_BLOCK_LINES.map((line) => usageEventKey(mustParse(line)));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toBeNull();
  });

  it('collapses them to one event carrying the call usage, not three times it', () => {
    const events = DUPLICATE_BLOCK_LINES.map(mustParse);
    const deduped = dedupeEvents(events);

    expect(events).toHaveLength(3);
    expect(deduped).toHaveLength(1);

    const only = deduped[0];
    if (only === undefined) throw new Error('expected one event');
    expect(only.tokens).toEqual({
      input: 2,
      output: 2087,
      cacheCreation: 427,
      cacheRead: 54615,
      thinking: 1916,
    });

    // The numbers the bug produced, spelled out so a regression is unmissable.
    const inputPlusOutput = deduped.reduce((n, e) => n + e.tokens.input + e.tokens.output, 0);
    const cacheRead = deduped.reduce((n, e) => n + e.tokens.cacheRead, 0);
    expect(inputPlusOutput).toBe(2089);
    expect(inputPlusOutput).not.toBe(6267);
    expect(cacheRead).toBe(54615);
    expect(cacheRead).not.toBe(163845);
  });

  it('keeps the LAST record, because the usage object is still growing', () => {
    // Both lines are one call in a real subagent transcript:
    // projects/l--Open-Source-frameforge/82087e29-.../subagents/workflows/
    //   wf_0a765196-414/agent-a20beb8bee51569a8.jsonl
    // The first is written before the response finished, the second after.
    const first =
      '{"type":"assistant","timestamp":"2026-09-01T04:39:16.736Z","uuid":"fed43427-407b-45f2-90ac-a9ef1e02c124","requestId":"req_011Cec6nH7EgqNfUpiWiCEWJ","message":{"id":"msg_011Cec6nJP8pWzbyrnrv9Fde","role":"assistant","model":"claude-opus-5","usage":{"input_tokens":2,"cache_creation_input_tokens":247711,"cache_read_input_tokens":0,"output_tokens":3}}}';
    const last =
      '{"type":"assistant","timestamp":"2026-09-01T04:43:17.337Z","uuid":"3e806a43-2e65-4105-8bcf-0f731d3e9d3a","requestId":"req_011Cec6nH7EgqNfUpiWiCEWJ","message":{"id":"msg_011Cec6nJP8pWzbyrnrv9Fde","role":"assistant","model":"claude-opus-5","usage":{"input_tokens":2,"cache_creation_input_tokens":247711,"cache_read_input_tokens":0,"output_tokens":26069,"output_tokens_details":{"thinking_tokens":6966}}}}';

    const deduped = dedupeEvents([mustParse(first), mustParse(last)]);
    expect(deduped).toHaveLength(1);
    const only = deduped[0];
    if (only === undefined) throw new Error('expected one event');
    // First-wins would report 3 and lose 26,066 real output tokens.
    expect(only.tokens.output).toBe(26069);
    expect(only.tokens.thinking).toBe(6966);
    expect(only.at.toISOString()).toBe('2026-09-01T04:43:17.337Z');
  });

  it('never merges records that name no message id', () => {
    // Two genuinely different calls that happen to share a requestId must both
    // survive: merging on a partial identity would be an undercount, which is
    // a worse failure than the overcount being fixed here.
    const line = (at: string, out: number): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: at,
        model: 'claude-opus-5',
        requestId: 'req_1',
        usage: { output_tokens: out },
      });

    const events = [
      mustParse(line('2026-09-11T01:00:00.000Z', 5)),
      mustParse(line('2026-09-11T01:00:01.000Z', 7)),
    ];
    for (const event of events) expect(usageEventKey(event)).toBeNull();
    expect(dedupeEvents(events)).toHaveLength(2);
  });

  it('keeps distinct calls distinct and preserves first-appearance order', () => {
    const lines = [
      ...DUPLICATE_BLOCK_LINES,
      '{"type":"assistant","timestamp":"2026-09-11T01:32:00.000Z","requestId":"req_other","message":{"id":"msg_other","role":"assistant","model":"claude-opus-5","usage":{"output_tokens":11}}}',
    ];
    const deduped = dedupeEvents(lines.map(mustParse));

    expect(deduped.map((e) => e.messageId)).toEqual([
      'msg_011CevncCPS9Vpk3sF8XKQSv',
      'msg_other',
    ]);
  });

  it('does not mutate its input', () => {
    const events = DUPLICATE_BLOCK_LINES.map(mustParse);
    const before = events.map((e) => e.tokens.output);
    dedupeEvents(events);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.tokens.output)).toEqual(before);
  });
});

describe('implausible token magnitudes (regression: a 100% bar from garbage)', () => {
  const HUGE_LINE =
    '{"type":"assistant","model":"m","timestamp":"2026-09-11T01:30:26.137Z","usage":{"output_tokens":1e308,"input_tokens":1e308}}';

  it('refuses 1e308 rather than reporting it as a token count', () => {
    expect(coerceTokens({ input_tokens: 1e308, output_tokens: 1e308 })).toEqual(ZERO_TOKENS);

    const event = mustParse(HUGE_LINE);
    expect(event.tokens.input).toBe(0);
    expect(event.tokens.output).toBe(0);
  });

  it('two such records sum to a finite total instead of Infinity', () => {
    const events = [mustParse(HUGE_LINE), mustParse(HUGE_LINE)];
    const total = events.reduce((n, e) => n + e.tokens.input + e.tokens.output, 0);

    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBe(0);
    // The bug: Infinity / limit * 100 clamps to exactly 100, a full red bar
    // telling the user their quota is gone.
    expect(Math.min(100, (total / 220_000) * 100)).not.toBe(100);
  });

  it('refuses a garbled digit run that JSON reads as 1e+23', () => {
    const line =
      '{"type":"assistant","model":"m","timestamp":"2026-09-11T01:30:26.137Z","usage":{"output_tokens":99999999999999999999999}}';
    expect(mustParse(line).tokens.output).toBe(0);
  });

  it('keeps every magnitude a real call can have, and refuses the rest', () => {
    // The largest count measured anywhere on disk is 999,146.
    expect(coerceTokens({ input_tokens: 999_146 }).input).toBe(999_146);
    expect(coerceTokens({ input_tokens: MAX_TOKENS_PER_CALL }).input).toBe(MAX_TOKENS_PER_CALL);
    expect(coerceTokens({ input_tokens: MAX_TOKENS_PER_CALL + 1 }).input).toBe(0);
    expect(coerceTokens({ input_tokens: Number.MAX_SAFE_INTEGER }).input).toBe(0);
    // A token count is a whole number of tokens.
    expect(coerceTokens({ input_tokens: 2.5 }).input).toBe(0);
  });
});

describe('timestamps without a zone (regression: an invented UTC instant)', () => {
  const stamped = (timestamp: string): string =>
    JSON.stringify({
      type: 'assistant',
      model: 'claude-opus-5',
      timestamp,
      usage: { output_tokens: 1 },
    });

  it('refuses an ISO timestamp that has lost its zone designator', () => {
    // On a UTC+8 machine new Date() reads this as 2026-09-10T17:30:26.137Z: a
    // valid Date, an eight hour shift, and a different answer per machine.
    expect(Number.isNaN(new Date('2026-09-11T01:30:26.137').getTime())).toBe(false);
    expect(parseLine(stamped('2026-09-11T01:30:26.137'))).toBeNull();
  });

  it('refuses the other shapes V8 accepts through its lenient fallback', () => {
    for (const timestamp of [
      '2026-09-11 01:30:26',
      'Sep 11 2026 01:30:26',
      '2026-09-11T01:30:26',
      '2026-09-11T01:30',
    ]) {
      expect(Number.isNaN(new Date(timestamp).getTime())).toBe(false);
      expect(parseLine(stamped(timestamp))).toBeNull();
    }
  });

  it('accepts a trailing Z and an explicit offset, and reads both as one instant', () => {
    expect(mustParse(stamped('2026-09-11T01:30:26.137Z')).at.toISOString()).toBe(
      '2026-09-11T01:30:26.137Z',
    );
    expect(mustParse(stamped('2026-09-11T09:30:26.137+08:00')).at.toISOString()).toBe(
      '2026-09-11T01:30:26.137Z',
    );
    expect(mustParse(stamped('2026-09-10T21:30:26.137-04:00')).at.toISOString()).toBe(
      '2026-09-11T01:30:26.137Z',
    );
    expect(mustParse(stamped('2026-09-11T01:30:26Z')).at.toISOString()).toBe(
      '2026-09-11T01:30:26.000Z',
    );
  });

  it('reads a zone-stamped record identically whatever the host offset is', () => {
    // The event must land in the same five-hour UTC session block on every
    // machine that opens the transcript.
    const previous = process.env['TZ'];
    const readIn = (tz: string): string => {
      process.env['TZ'] = tz;
      return mustParse(stamped('2026-09-11T01:30:26.137Z')).at.toISOString();
    };
    try {
      expect(readIn('Asia/Taipei')).toBe('2026-09-11T01:30:26.137Z');
      expect(readIn('America/New_York')).toBe('2026-09-11T01:30:26.137Z');
      expect(readIn('UTC')).toBe('2026-09-11T01:30:26.137Z');
    } finally {
      if (previous === undefined) delete process.env['TZ'];
      else process.env['TZ'] = previous;
    }
  });
});
