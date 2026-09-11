import { describe, it, expect } from 'vitest';

import type { RateSnapshot, RateWindow } from './parse.js';
import { parseRateLimitLine, planLabel } from './parse.js';

/**
 * A real `token_count` line, copied from a rollout file on this machine.
 *
 * The `rate_limits` object is verbatim, which is the whole point of this
 * fixture: it is the shape every assertion in this file is defending. The
 * `info` block is the shape such a record carries (`last_token_usage` was
 * elided in the capture and is filled in here with the same numbers as
 * `total_token_usage`), and nothing in it is ever read by the parser.
 *
 * PRIVACY: this is the only real data in the file and it is all counters,
 * percentages and epochs. No fixture anywhere below contains prompt text,
 * model output, a real path or anything else a rollout file holds.
 */
const VERBATIM_LINE =
  '{"timestamp":"2026-09-07T08:32:02.043Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":18520,"cached_input_tokens":1408,"cache_write_input_tokens":0,"output_tokens":17,"reasoning_output_tokens":10,"total_tokens":18537},"last_token_usage":{"input_tokens":18520,"cached_input_tokens":1408,"cache_write_input_tokens":0,"output_tokens":17,"reasoning_output_tokens":10,"total_tokens":18537},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":0.0,"window_minutes":300,"resets_at":1788787915},"secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1789374715},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"plus","rate_limit_reached_type":null}}}';

/** The instant on the verbatim line. */
const AT_ISO = '2026-09-07T08:32:02.043Z';

/** `resets_at` values from the verbatim line, in UNIX SECONDS. */
const SESSION_RESETS_AT = 1788787915;
const WEEKLY_RESETS_AT = 1789374715;

/** The same two instants once multiplied by 1000. Five hours out, a week out. */
const SESSION_RESETS_ISO = '2026-09-07T13:31:55.000Z';
const WEEKLY_RESETS_ISO = '2026-09-14T08:31:55.000Z';

/**
 * Parse or fail the test.
 *
 * Deliberately does NOT put the line in the failure message: this suite feeds
 * the parser lines that stand in for a user's transcript, and a test helper
 * that echoes them would be the same leak the module refuses to make.
 */
function mustParse(line: string): RateSnapshot {
  const snapshot = parseRateLimitLine(line);
  if (snapshot === null) throw new Error('expected a RateSnapshot, got null');
  return snapshot;
}

/** Assert a window is present and hand it back, so assertions stay flat. */
function mustWindow(window: RateWindow | null, which: string): RateWindow {
  if (window === null) throw new Error(`expected a ${which} window, got null`);
  return window;
}

/** One raw window object. Fields are `unknown` so tests can pass nonsense. */
function windowJson(usedPercent: unknown, windowMinutes: unknown, resetsAt: unknown): unknown {
  return { used_percent: usedPercent, window_minutes: windowMinutes, resets_at: resetsAt };
}

/**
 * A synthetic `token_count` line wrapping whatever `rate_limits` a test needs.
 * `undefined` anywhere in here is dropped by JSON.stringify, which is exactly
 * how a missing field reaches the parser.
 */
function tokenCountLine(rateLimits: unknown, timestamp: unknown = AT_ISO): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { model_context_window: 258400 },
      rate_limits: rateLimits,
    },
  });
}

describe('parseRateLimitLine', () => {
  it('parses the verbatim token_count line from disk', () => {
    const snapshot = mustParse(VERBATIM_LINE);

    expect(snapshot.at.toISOString()).toBe(AT_ISO);
    expect(snapshot.planType).toBe('plus');
    expect(snapshot.limitId).toBe('codex');

    const session = mustWindow(snapshot.session, 'session');
    expect(session.usedPercent).toBe(0);
    expect(session.windowMinutes).toBe(300);
    expect(session.resetsAt.toISOString()).toBe(SESSION_RESETS_ISO);
    expect('clamped' in session).toBe(false);

    const weekly = mustWindow(snapshot.weekly, 'weekly');
    expect(weekly.usedPercent).toBe(0);
    expect(weekly.windowMinutes).toBe(10080);
    expect(weekly.resetsAt.toISOString()).toBe(WEEKLY_RESETS_ISO);
    expect('clamped' in weekly).toBe(false);

    expect(snapshot.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' });
  });

  it('reads resets_at as seconds, not milliseconds', () => {
    // The distinction is the difference between "resets this afternoon" and
    // "reset in January 1970", and only one of them is a countdown.
    const session = mustWindow(mustParse(VERBATIM_LINE).session, 'session');
    expect(session.resetsAt.getTime()).toBe(SESSION_RESETS_AT * 1000);
    expect(session.resetsAt.getTime()).not.toBe(SESSION_RESETS_AT);
  });

  it('reports the percentages OpenAI reported, untouched', () => {
    const snapshot = mustParse(
      tokenCountLine({
        plan_type: 'plus',
        primary: windowJson(37.5, 300, SESSION_RESETS_AT),
        secondary: windowJson(4.25, 10080, WEEKLY_RESETS_AT),
      }),
    );

    expect(mustWindow(snapshot.session, 'session').usedPercent).toBe(37.5);
    expect(mustWindow(snapshot.weekly, 'weekly').usedPercent).toBe(4.25);
  });

  it('classifies by window_minutes, not by the primary/secondary key name', () => {
    // Reversed: the weekly window arrives under "primary". Nothing we have
    // verified promises an ordering, so the minutes decide.
    const snapshot = mustParse(
      tokenCountLine({
        plan_type: 'prolite',
        primary: windowJson(63, 10080, WEEKLY_RESETS_AT),
        secondary: windowJson(12, 300, SESSION_RESETS_AT),
      }),
    );

    const session = mustWindow(snapshot.session, 'session');
    expect(session.windowMinutes).toBe(300);
    expect(session.usedPercent).toBe(12);
    expect(session.resetsAt.toISOString()).toBe(SESSION_RESETS_ISO);

    const weekly = mustWindow(snapshot.weekly, 'weekly');
    expect(weekly.windowMinutes).toBe(10080);
    expect(weekly.usedPercent).toBe(63);
    expect(weekly.resetsAt.toISOString()).toBe(WEEKLY_RESETS_ISO);
  });

  it('treats 1440 minutes as weekly and 1439 as session', () => {
    const snapshot = mustParse(
      tokenCountLine({
        primary: windowJson(1, 1439, SESSION_RESETS_AT),
        secondary: windowJson(2, 1440, WEEKLY_RESETS_AT),
      }),
    );

    expect(mustWindow(snapshot.session, 'session').windowMinutes).toBe(1439);
    expect(mustWindow(snapshot.weekly, 'weekly').windowMinutes).toBe(1440);
  });

  it('returns a session-only snapshot when secondary is missing', () => {
    const snapshot = mustParse(
      tokenCountLine({
        limit_id: 'codex',
        plan_type: 'plus',
        primary: windowJson(8.5, 300, SESSION_RESETS_AT),
      }),
    );

    expect(mustWindow(snapshot.session, 'session').usedPercent).toBe(8.5);
    expect(snapshot.weekly).toBeNull();
    expect(snapshot.planType).toBe('plus');
  });

  it('returns a weekly-only snapshot when primary is missing', () => {
    const snapshot = mustParse(
      tokenCountLine({ secondary: windowJson(71, 10080, WEEKLY_RESETS_AT) }),
    );

    expect(snapshot.session).toBeNull();
    expect(mustWindow(snapshot.weekly, 'weekly').usedPercent).toBe(71);
  });

  it('keeps the first window when both land in the same bucket', () => {
    const bothSession = mustParse(
      tokenCountLine({
        primary: windowJson(10, 300, SESSION_RESETS_AT),
        secondary: windowJson(90, 600, WEEKLY_RESETS_AT),
      }),
    );
    expect(mustWindow(bothSession.session, 'session').usedPercent).toBe(10);
    expect(mustWindow(bothSession.session, 'session').windowMinutes).toBe(300);
    expect(bothSession.weekly).toBeNull();

    const bothWeekly = mustParse(
      tokenCountLine({
        primary: windowJson(20, 10080, WEEKLY_RESETS_AT),
        secondary: windowJson(80, 43200, WEEKLY_RESETS_AT),
      }),
    );
    expect(mustWindow(bothWeekly.weekly, 'weekly').usedPercent).toBe(20);
    expect(mustWindow(bothWeekly.weekly, 'weekly').windowMinutes).toBe(10080);
    expect(bothWeekly.session).toBeNull();
  });

  it('clamps a negative used_percent to 0 and records the clamp', () => {
    const snapshot = mustParse(
      tokenCountLine({
        primary: windowJson(-5, 300, SESSION_RESETS_AT),
        secondary: windowJson(50, 10080, WEEKLY_RESETS_AT),
      }),
    );

    const session = mustWindow(snapshot.session, 'session');
    expect(session.usedPercent).toBe(0);
    expect(session.clamped).toBe(true);

    // The honest neighbour is untouched, and carries no clamp flag.
    const weekly = mustWindow(snapshot.weekly, 'weekly');
    expect(weekly.usedPercent).toBe(50);
    expect('clamped' in weekly).toBe(false);
  });

  it('clamps an over-100 used_percent to 100 and records the clamp', () => {
    const snapshot = mustParse(
      tokenCountLine({ primary: windowJson(150, 300, SESSION_RESETS_AT) }),
    );

    const session = mustWindow(snapshot.session, 'session');
    expect(session.usedPercent).toBe(100);
    expect(session.clamped).toBe(true);
  });

  it('does not flag the exact endpoints 0 and 100 as clamped', () => {
    const snapshot = mustParse(
      tokenCountLine({
        primary: windowJson(0, 300, SESSION_RESETS_AT),
        secondary: windowJson(100, 10080, WEEKLY_RESETS_AT),
      }),
    );

    expect('clamped' in mustWindow(snapshot.session, 'session')).toBe(false);
    expect(mustWindow(snapshot.weekly, 'weekly').usedPercent).toBe(100);
    expect('clamped' in mustWindow(snapshot.weekly, 'weekly')).toBe(false);
  });

  it('rejects a used_percent of Infinity instead of clamping it to a confident 100%', () => {
    // JSON has no Infinity literal, but `1e999` overflows to one on parse, so
    // this is the shape the bug actually arrives in. Written raw because
    // JSON.stringify would turn Infinity into null and test nothing.
    const line =
      '{"timestamp":"2026-09-07T08:32:02.043Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"plan_type":"plus","primary":{"used_percent":1e999,"window_minutes":300,"resets_at":1788787915},"secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1789374715}}}}';

    const reparsed = JSON.parse(line) as {
      payload: { rate_limits: { primary: { used_percent: number } } };
    };
    expect(reparsed.payload.rate_limits.primary.used_percent).toBe(Number.POSITIVE_INFINITY);

    const snapshot = mustParse(line);
    expect(snapshot.session).toBeNull();
    expect(mustWindow(snapshot.weekly, 'weekly').usedPercent).toBe(0);
  });

  it('rejects a used_percent of -Infinity', () => {
    const line =
      '{"timestamp":"2026-09-07T08:32:02.043Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":-1e999,"window_minutes":300,"resets_at":1788787915}}}}';

    const snapshot = mustParse(line);
    expect(snapshot.session).toBeNull();
    expect(snapshot.weekly).toBeNull();
  });

  it('returns null for a line whose used_percent is the literal NaN', () => {
    // NaN is not valid JSON, so a line carrying one is unparseable and the
    // whole line is refused. `Number.isFinite` in the parser covers the value
    // itself; this covers the only way it can reach us from a file.
    const line =
      '{"timestamp":"2026-09-07T08:32:02.043Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":NaN,"window_minutes":300,"resets_at":1788787915}}}}';

    expect(parseRateLimitLine(line)).toBeNull();
  });

  it('drops a window whose used_percent is not a number', () => {
    const values: unknown[] = ['12', null, true, {}, [], undefined];
    for (const used of values) {
      const snapshot = mustParse(
        tokenCountLine({ primary: windowJson(used, 300, SESSION_RESETS_AT) }),
      );
      expect(snapshot.session).toBeNull();
    }
  });

  it('drops a window whose resets_at is 0, negative, or a string', () => {
    const values: unknown[] = [0, -1, -1788787915, '1788787915', null, undefined, true, {}];
    for (const resetsAt of values) {
      const snapshot = mustParse(tokenCountLine({ primary: windowJson(42, 300, resetsAt) }));
      expect(snapshot.session).toBeNull();
    }
  });

  it('drops a window whose resets_at overflows the Date range', () => {
    // 1e15 seconds is 1e18 ms, well past the ±8.64e15 ms a Date can hold.
    const snapshot = mustParse(tokenCountLine({ primary: windowJson(42, 300, 1e15) }));
    expect(snapshot.session).toBeNull();
  });

  it('drops a window whose window_minutes is missing, zero, negative or not a number', () => {
    const values: unknown[] = [undefined, null, 0, -300, '300', {}, []];
    for (const minutes of values) {
      const snapshot = mustParse(
        tokenCountLine({ primary: windowJson(42, minutes, SESSION_RESETS_AT) }),
      );
      expect(snapshot.session).toBeNull();
      expect(snapshot.weekly).toBeNull();
    }
  });

  it('drops a window that is not an object at all', () => {
    const values: unknown[] = [null, 'primary', 42, true, [], undefined];
    for (const primary of values) {
      const snapshot = mustParse(
        tokenCountLine({ primary, secondary: windowJson(3, 10080, WEEKLY_RESETS_AT) }),
      );
      expect(snapshot.session).toBeNull();
      expect(mustWindow(snapshot.weekly, 'weekly').usedPercent).toBe(3);
    }
  });

  it('still returns a snapshot when rate_limits carries no usable window', () => {
    // "OpenAI told us nothing usable" is a different fact from "this line was
    // not about rate limits", and the caller needs to tell them apart.
    const snapshot = mustParse(tokenCountLine({}));

    expect(snapshot.at.toISOString()).toBe(AT_ISO);
    expect(snapshot.session).toBeNull();
    expect(snapshot.weekly).toBeNull();
    expect(snapshot.planType).toBeNull();
    expect(snapshot.limitId).toBeNull();
    expect(snapshot.credits).toBeNull();
  });

  it('returns null for a token_count whose rate_limits is null', () => {
    expect(parseRateLimitLine(tokenCountLine(null))).toBeNull();
  });

  it('returns null for a token_count whose rate_limits is not an object', () => {
    const values: unknown[] = [undefined, 'codex', 42, true, [], [{ primary: {} }]];
    for (const rateLimits of values) {
      expect(parseRateLimitLine(tokenCountLine(rateLimits))).toBeNull();
    }
  });

  it('returns null for an event_msg that is not a token_count', () => {
    // Including one that somehow carries rate_limits: the payload type is the
    // gate, because it is what tells us the line holds no transcript content.
    const types = ['agent_message', 'agent_reasoning_delta', 'exec_command_end', 'task_started'];
    for (const type of types) {
      const line = JSON.stringify({
        timestamp: AT_ISO,
        type: 'event_msg',
        payload: {
          type,
          rate_limits: {
            plan_type: 'plus',
            primary: windowJson(99, 300, SESSION_RESETS_AT),
          },
        },
      });
      expect(parseRateLimitLine(line)).toBeNull();
    }
  });

  it('returns null for a record whose type is not event_msg', () => {
    const types = ['session_meta', 'response_item', 'turn_context', 'compacted', ''];
    for (const type of types) {
      const line = JSON.stringify({
        timestamp: AT_ISO,
        type,
        payload: {
          type: 'token_count',
          rate_limits: { primary: windowJson(99, 300, SESSION_RESETS_AT) },
        },
      });
      expect(parseRateLimitLine(line)).toBeNull();
    }
  });

  it('returns null when the payload is missing or not an object', () => {
    const payloads: unknown[] = [undefined, null, 'token_count', 42, [], true];
    for (const payload of payloads) {
      expect(parseRateLimitLine(JSON.stringify({ timestamp: AT_ISO, type: 'event_msg', payload }))).toBeNull();
    }
  });

  it('returns null for JSON truncated mid-line', () => {
    const truncated = VERBATIM_LINE.slice(0, 200);
    expect(truncated.length).toBeGreaterThan(0);
    expect(truncated.endsWith('}')).toBe(false);
    expect(parseRateLimitLine(truncated)).toBeNull();

    expect(parseRateLimitLine('{"type":"event_msg","payload":{"type":"token_')).toBeNull();
    expect(parseRateLimitLine(VERBATIM_LINE.slice(0, VERBATIM_LINE.length - 1))).toBeNull();
    expect(parseRateLimitLine(VERBATIM_LINE.slice(40))).toBeNull();
  });

  it('returns null for blank input', () => {
    expect(parseRateLimitLine('')).toBeNull();
    expect(parseRateLimitLine('   ')).toBeNull();
    expect(parseRateLimitLine('\n')).toBeNull();
    expect(parseRateLimitLine('\r\n')).toBeNull();
    expect(parseRateLimitLine('\t  \t')).toBeNull();
  });

  it('tolerates surrounding whitespace and a CRLF line ending', () => {
    const snapshot = mustParse(`  ${VERBATIM_LINE}\r\n`);
    expect(snapshot.at.toISOString()).toBe(AT_ISO);
    expect(mustWindow(snapshot.session, 'session').windowMinutes).toBe(300);
  });

  it('returns null rather than inventing an instant for a missing or unusable timestamp', () => {
    const stamps: unknown[] = [
      undefined,
      null,
      '',
      1788769922,
      'yesterday',
      '2026-13-45T99:99:99Z',
      // No zone designator: V8 would read this as local time and shift the
      // snapshot by the machine's offset.
      '2026-09-07T08:32:02.043',
      '2026-09-07 08:32:02',
    ];
    for (const timestamp of stamps) {
      // Built inline rather than through the helper: a `undefined` default
      // would put the good timestamp back and the case would test nothing.
      const line = JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: { primary: windowJson(50, 300, SESSION_RESETS_AT) },
        },
      });
      expect(parseRateLimitLine(line)).toBeNull();
    }
  });

  it('accepts a timestamp with an explicit numeric offset', () => {
    const snapshot = mustParse(
      tokenCountLine({ primary: windowJson(50, 300, SESSION_RESETS_AT) }, '2026-09-07T10:32:02.043+02:00'),
    );
    expect(snapshot.at.toISOString()).toBe(AT_ISO);
  });

  it('reads the plan tier and limit id, and nulls them when absent or blank', () => {
    const present = mustParse(tokenCountLine({ plan_type: 'prolite', limit_id: 'codex' }));
    expect(present.planType).toBe('prolite');
    expect(present.limitId).toBe('codex');

    const absent = mustParse(tokenCountLine({ plan_type: '', limit_id: null }));
    expect(absent.planType).toBeNull();
    expect(absent.limitId).toBeNull();

    const wrongTypes = mustParse(tokenCountLine({ plan_type: 42, limit_id: { id: 'codex' } }));
    expect(wrongTypes.planType).toBeNull();
    expect(wrongTypes.limitId).toBeNull();
  });

  it('keeps the credit balance a string, exactly as sent', () => {
    const snapshot = mustParse(
      tokenCountLine({
        credits: { has_credits: true, unlimited: false, balance: '12.50' },
      }),
    );

    expect(snapshot.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' });
  });

  it('reads non-boolean credit flags as false and a non-string balance as null', () => {
    const snapshot = mustParse(
      tokenCountLine({ credits: { has_credits: 'yes', unlimited: 1, balance: 0 } }),
    );

    expect(snapshot.credits).toEqual({ hasCredits: false, unlimited: false, balance: null });
  });

  it('nulls credits when the line does not carry a usable object', () => {
    const values: unknown[] = [undefined, null, 'none', 0, [], true];
    for (const credits of values) {
      expect(mustParse(tokenCountLine({ credits })).credits).toBeNull();
    }
  });

  it('never throws, whatever the line contains', () => {
    const hostile = [
      '{}',
      '[]',
      '[1,2,3]',
      'null',
      'true',
      '42',
      '"a string"',
      'undefined',
      '<html><body>nope</body></html>',
      ' ',
      '{"type":{"nested":"object"},"payload":{"type":"token_count","rate_limits":{}}}',
      '{"type":"event_msg","payload":{"type":["token_count"],"rate_limits":{}}}',
      `{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":${'['.repeat(200)}${']'.repeat(200)}}},"timestamp":"${AT_ISO}"}`,
      VERBATIM_LINE.repeat(2),
    ];

    for (const line of hostile) {
      expect(() => parseRateLimitLine(line)).not.toThrow();
    }
    // Not a string at all: the reader is streaming an undocumented format and
    // a caller mistake must not become an exception either.
    expect(() => parseRateLimitLine(undefined as unknown as string)).not.toThrow();
    expect(parseRateLimitLine(undefined as unknown as string)).toBeNull();
    expect(() => parseRateLimitLine(42 as unknown as string)).not.toThrow();
  });

  it('copies nothing but the rate limits out of a line', () => {
    // A rollout line holds the user's prompts. The snapshot must contain the
    // counters and nothing else - not from `info`, not from fields we do not
    // recognize, not even from inside `rate_limits`.
    const marker = 'MUST-NOT-ESCAPE-THIS-MODULE';
    const line = JSON.stringify({
      timestamp: AT_ISO,
      type: 'event_msg',
      cwd: `/home/${marker}/project`,
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 18537 }, note: marker },
        rate_limits: {
          plan_type: 'plus',
          limit_id: 'codex',
          unrecognized_field: marker,
          primary: { used_percent: 5, window_minutes: 300, resets_at: SESSION_RESETS_AT, tag: marker },
        },
      },
    });

    const snapshot = mustParse(line);
    expect(JSON.stringify(snapshot).includes(marker)).toBe(false);
    expect(Object.keys(snapshot).sort()).toEqual([
      'at',
      'credits',
      'limitId',
      'planType',
      'session',
      'weekly',
    ]);
    expect(Object.keys(mustWindow(snapshot.session, 'session')).sort()).toEqual([
      'resetsAt',
      'usedPercent',
      'windowMinutes',
    ]);
  });

  it('returns a fresh snapshot per call and never shares Date instances', () => {
    const first = mustParse(VERBATIM_LINE);
    const second = mustParse(VERBATIM_LINE);

    expect(first).not.toBe(second);
    expect(first.at).not.toBe(second.at);
    expect(first.at.getTime()).toBe(second.at.getTime());

    mustWindow(first.session, 'session').resetsAt.setUTCFullYear(1999);
    expect(mustWindow(second.session, 'session').resetsAt.toISOString()).toBe(SESSION_RESETS_ISO);
  });
});

describe('planLabel', () => {
  it('labels the tiers observed on real machines', () => {
    expect(planLabel('plus')).toBe('Plus');
    expect(planLabel('prolite')).toBe('Pro Lite');
  });

  it('labels the rest of the published enum', () => {
    expect(planLabel('free')).toBe('Free');
    expect(planLabel('go')).toBe('Go');
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('team')).toBe('Team');
    expect(planLabel('business')).toBe('Business');
    expect(planLabel('enterprise')).toBe('Enterprise');
    expect(planLabel('edu')).toBe('Education');
    expect(planLabel('education')).toBe('Education');
  });

  it('ignores case, spacing and separators', () => {
    expect(planLabel('PLUS')).toBe('Plus');
    expect(planLabel('Pro_Lite')).toBe('Pro Lite');
    expect(planLabel('pro-lite')).toBe('Pro Lite');
    expect(planLabel('  Pro Lite  ')).toBe('Pro Lite');
    expect(planLabel('BUSINESS')).toBe('Business');
  });

  it('labels enterprise and edu variants we have not seen literally', () => {
    expect(planLabel('enterprise_seat')).toBe('Enterprise');
    expect(planLabel('chatgpt_enterprise')).toBe('Enterprise');
    expect(planLabel('edu_teacher')).toBe('Education');
    expect(planLabel('education_seat')).toBe('Education');
    expect(planLabel('business_v2')).toBe('Business');
  });

  it('prefers the more specific tier when one name contains another', () => {
    expect(planLabel('pro_lite_trial')).toBe('Pro Lite');
    expect(planLabel('chatgpt_pro')).toBe('Pro');
  });

  it('returns "Unknown plan" instead of failing on an unseen value', () => {
    const unseen: (string | null)[] = [
      null,
      '',
      '   ',
      '???',
      'unknown',
      'quantum_tier_9000',
      'null',
      '0',
    ];
    for (const value of unseen) {
      expect(() => planLabel(value)).not.toThrow();
      expect(planLabel(value)).toBe('Unknown plan');
    }
  });

  it('never throws when handed something that is not a string', () => {
    const values: unknown[] = [undefined, 42, {}, [], true, Symbol('plus')];
    for (const value of values) {
      expect(() => planLabel(value as string | null)).not.toThrow();
      expect(planLabel(value as string | null)).toBe('Unknown plan');
    }
  });

  it('labels the plan tier carried on the verbatim line', () => {
    expect(planLabel(mustParse(VERBATIM_LINE).planType)).toBe('Plus');
  });
});
