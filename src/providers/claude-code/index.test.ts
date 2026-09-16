import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../../core/config.js';
import { percentUsed } from '../../core/types.js';
import { MemorySecretStore } from '../../core/secrets.js';
import {
  MAX_ANCHOR_WIDENING_FILES,
  MAX_TRANSCRIPT_FILES,
  PERCENT_LIMIT,
  PROVIDER_ID,
  claudeCodeAdapter,
} from './index.js';
import { statusLineSnapshotPath, writeRateLimitSnapshot } from './statusline.js';
import { MAX_LINE_LENGTH } from './transcripts.js';

import type { RateLimitSnapshot } from './statusline.js';

/**
 * A seam for the one failure that cannot be produced from the filesystem in a
 * portable test: a read that dies PART WAY THROUGH a transcript, which on
 * Windows is a routine EBUSY against a file Claude Code is still appending to.
 * Null in every test but one, in which case the real `node:fs` runs.
 */
const hooks = vi.hoisted(() => ({ createReadStream: null as (() => Readable) | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patched = (...args: Parameters<typeof actual.createReadStream>): unknown =>
    hooks.createReadStream === null ? actual.createReadStream(...args) : hooks.createReadStream();
  return { ...actual, createReadStream: patched };
});

/** Run `fn` with `createReadStream` replaced, restoring it afterwards. */
async function withReadStream<T>(make: () => Readable, fn: () => Promise<T>): Promise<T> {
  hooks.createReadStream = make;
  try {
    return await fn();
  } finally {
    hooks.createReadStream = null;
  }
}

/** A stream that delivers `chunks` and then fails, like a file locked mid-read. */
function failingStream(chunks: readonly string[], err: Error): Readable {
  let next = 0;
  return new Readable({
    encoding: 'utf8',
    read(): void {
      const chunk = chunks[next];
      next += 1;
      if (chunk === undefined) this.destroy(err);
      else this.push(chunk);
    },
  });
}

import type { AdapterContext, QuotaReading } from '../../core/types.js';

/**
 * Fixed instants. Nothing in this file may consult the wall clock.
 *
 * 2026-09-11 is a Friday, so with the default Monday week start the weekly
 * window is [09-07, 09-14), which is clock-anchored and stays that way.
 *
 * The session window is NOT clock-anchored. It opens on the first message
 * after the previous window lapsed, so with the only activity in these tests
 * stamped at 02:00 the window is [02:00, 07:00) - not the [00:00, 05:00) clock
 * block that 03:00 falls in. That difference is the bug this adapter was
 * corrected for; see `anchoring the session window to activity` below.
 */
const NOW = new Date('2026-09-11T03:00:00.000Z');
const WEEK_START = '2026-09-07T00:00:00.000Z';
const WEEK_END = '2026-09-14T00:00:00.000Z';

/** The first message of the session in these fixtures, and so its anchor. */
const IN_SESSION = '2026-09-11T02:00:00.000Z';

/** The window that anchor opens: five hours from the message, not from 00:00. */
const SESSION_START = IN_SESSION;
const SESSION_END = '2026-09-11T07:00:00.000Z';
/** Inside the current week, before the current session block opened. */
const IN_WEEK_ONLY = '2026-09-08T12:00:00.000Z';
/** Before the week opened. */
const BEFORE_WEEK = '2026-09-01T09:00:00.000Z';

/** An mtime inside the widest window, so listTranscripts keeps the file. */
const RECENT_MTIME = new Date('2026-09-10T00:00:00.000Z');

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeClaudeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-cc-adapter-'));
  created.push(dir);
  await mkdir(join(dir, 'projects'));
  return dir;
}

async function writeTranscript(
  claudeDir: string,
  project: string,
  file: string,
  lines: readonly string[],
  mtime: Date = RECENT_MTIME,
): Promise<string> {
  const dir = join(claudeDir, 'projects', project);
  await mkdir(dir, { recursive: true });
  const full = join(dir, file);
  await writeFile(full, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
  await utimes(full, mtime, mtime);
  return full;
}

interface Usage {
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  thinking?: number;
}

/** One assistant record in the exact shape Claude Code writes. */
function assistantLine(at: string, model: string, usage: Usage): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    model,
    sessionId: 'a2f0d0c8-0000-4000-8000-000000000001',
    cwd: '/home/test/project',
    gitBranch: 'main',
    requestId: 'req_1',
    usage: {
      input_tokens: usage.input ?? 0,
      output_tokens: usage.output ?? 0,
      cache_creation_input_tokens: usage.cacheCreation ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      output_tokens_details: { thinking_tokens: usage.thinking ?? 0 },
    },
  });
}

interface Harness {
  ctx: AdapterContext;
  debug: string[];
}

/**
 * `now` is a parameter because the session window is derived from the events,
 * so a test that pins a real anchor needs its own instant. It is still a fixed
 * one - nothing in this file may consult the wall clock.
 */
function harness(
  claudeDir: string,
  options: Record<string, unknown> = {},
  now: Date = NOW,
): Harness {
  const debug: string[] = [];
  return {
    debug,
    ctx: {
      now: () => now,
      homeDir: '/home/test',
      // `dir` is always set explicitly so an ambient $CLAUDE_CONFIG_DIR on the
      // machine running these tests cannot reach the adapter.
      options: { enabled: true, dir: claudeDir, ...options },
      secrets: new MemorySecretStore(),
      debug: (message) => debug.push(message),
    },
  };
}

function byWindow(readings: QuotaReading[], window: string): QuotaReading {
  const found = readings.find((r) => r.window === window);
  if (found === undefined) throw new Error(`no ${window} reading`);
  return found;
}

describe('claudeCodeAdapter', () => {
  it('identifies itself with the id used by the config file and the directory', () => {
    expect(claudeCodeAdapter.id).toBe('claude-code');
    expect(PROVIDER_ID).toBe('claude-code');
    expect(claudeCodeAdapter.displayName).toBe('Claude Code');
    expect(MAX_TRANSCRIPT_FILES).toBe(500);
  });

  describe('detect', () => {
    it('is false when the Claude home does not exist', async () => {
      const { ctx } = harness(join(tmpdir(), 'quota-monitor-does-not-exist-9f3a'));
      expect(await claudeCodeAdapter.detect(ctx)).toBe(false);
    });

    it('is false when projects/ exists but holds no transcript', async () => {
      const dir = await makeClaudeDir();
      await mkdir(join(dir, 'projects', 'l--empty'));
      const { ctx } = harness(dir);
      expect(await claudeCodeAdapter.detect(ctx)).toBe(false);
    });

    it('is false when the only file is not a .jsonl', async () => {
      const dir = await makeClaudeDir();
      await mkdir(join(dir, 'projects', 'l--x'), { recursive: true });
      await writeFile(join(dir, 'projects', 'l--x', 'notes.md'), 'hi', 'utf8');
      const { ctx } = harness(dir);
      expect(await claudeCodeAdapter.detect(ctx)).toBe(false);
    });

    it('is true when at least one transcript exists', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'session.jsonl', []);
      const { ctx } = harness(dir);
      expect(await claudeCodeAdapter.detect(ctx)).toBe(true);
    });
  });

  describe('read', () => {
    it('returns one reading per window, both derived, with correct bounds', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 1000, output: 500 }),
      ]);

      const { ctx } = harness(dir, { plan: 'max-20x' });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(readings.map((r) => r.window)).toEqual(['session', 'weekly']);
      expect(readings.every((r) => r.confidence === 'derived')).toBe(true);
      expect(readings.every((r) => r.provider === 'claude-code')).toBe(true);
      expect(readings.every((r) => r.unit === 'tokens')).toBe(true);
      expect(readings.every((r) => r.label === 'Max 20x')).toBe(true);

      const session = byWindow(readings, 'session');
      expect(session.windowStart).toBe(SESSION_START);
      expect(session.resetsAt).toBe(SESSION_END);

      const weekly = byWindow(readings, 'weekly');
      expect(weekly.windowStart).toBe(WEEK_START);
      expect(weekly.resetsAt).toBe(WEEK_END);
    });

    it('counts input + output and places events in the right windows', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', {
          input: 1000,
          output: 500,
          cacheCreation: 2000,
          cacheRead: 30000,
        }),
        assistantLine(IN_WEEK_ONLY, 'claude-sonnet-5', { input: 400, output: 100 }),
        assistantLine(BEFORE_WEEK, 'claude-opus-5', { input: 999999, output: 999999 }),
      ]);

      const { ctx } = harness(dir, { plan: 'max-20x' });
      const readings = await claudeCodeAdapter.read(ctx);

      // Cache classes are excluded from the numerator by default.
      expect(byWindow(readings, 'session').used).toBe(1500);
      // The week adds the earlier sonnet call, and still excludes last week's.
      expect(byWindow(readings, 'weekly').used).toBe(2000);
    });

    it('folds cache tokens into used when countCache is on', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', {
          input: 1000,
          output: 500,
          cacheCreation: 2000,
          cacheRead: 30000,
        }),
      ]);

      const { ctx } = harness(dir, { plan: 'max-20x', countCache: true });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(byWindow(readings, 'session').used).toBe(33500);
      expect(byWindow(readings, 'session').note).toContain('countCache');
    });

    it('prices every token class, including the cache it leaves out of used', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', {
          input: 1000,
          output: 500,
          cacheCreation: 2000,
          cacheRead: 30000,
        }),
        assistantLine(IN_WEEK_ONLY, 'claude-sonnet-5', { input: 400, output: 100 }),
      ]);

      const { ctx } = harness(dir, { plan: 'max-20x' });
      const readings = await claudeCodeAdapter.read(ctx);

      // opus: 1000*5 + 500*25 + 2000*6.25 + 30000*0.5, per million.
      expect(byWindow(readings, 'session').estimatedCostUsd).toBeCloseTo(0.045, 10);
      // plus sonnet: 400*2 + 100*10, per million.
      expect(byWindow(readings, 'weekly').estimatedCostUsd).toBeCloseTo(0.0468, 10);
    });

    it('prices each model separately rather than blending them', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 1_000_000, output: 0 }),
        assistantLine(IN_SESSION, 'claude-haiku-4-5', { input: 1_000_000, output: 0 }),
      ]);

      const { ctx } = harness(dir);
      const readings = await claudeCodeAdapter.read(ctx);

      // $5.00 of opus input + $1.00 of haiku input. A blended rate would not
      // land on 6 exactly.
      expect(byWindow(readings, 'session').estimatedCostUsd).toBeCloseTo(6, 10);
    });

    it('resolves a dated model id to its base price', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5-20260101', { input: 1_000_000, output: 0 }),
      ]);

      const { ctx } = harness(dir);
      expect(byWindow(await claudeCodeAdapter.read(ctx), 'session').estimatedCostUsd).toBeCloseTo(
        5,
        10,
      );
    });

    it('omits the cost and says so when no model in the window has a price', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'some-future-model', { input: 100, output: 100 }),
      ]);

      const { ctx } = harness(dir);
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      // Never $0.00 - that reads as "this was free".
      expect(session.estimatedCostUsd).toBeUndefined();
      expect(session.used).toBe(200);
      expect(session.note).toContain('some-future-model');
      expect(session.note).toContain('pricing.ts');
    });

    it('ignores a zero-token synthetic record when listing unpriced models', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        // Claude Code writes these for locally generated assistant messages.
        assistantLine(IN_SESSION, '<synthetic>', {}),
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 1_000_000, output: 0 }),
      ]);

      const { ctx } = harness(dir);
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      expect(session.estimatedCostUsd).toBeCloseTo(5, 10);
      expect(session.note).not.toContain('<synthetic>');
      expect(session.note).not.toContain('cost excludes');
    });

    it('still names an unpriced model that really did burn tokens', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, '<synthetic>', {}),
        assistantLine(IN_SESSION, 'claude-opus-6', { input: 100, output: 100 }),
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 100, output: 0 }),
      ]);

      const { ctx } = harness(dir);
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      expect(session.note).toContain('claude-opus-6');
      expect(session.note).not.toContain('<synthetic>');
    });

    it('reports zero with a zero cost when there is nothing in the window', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(BEFORE_WEEK, 'claude-opus-5', { input: 100, output: 100 }),
      ]);

      const { ctx } = harness(dir);
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      expect(session.used).toBe(0);
      expect(session.estimatedCostUsd).toBe(0);
    });

    it('works when the Claude home is missing entirely', async () => {
      const { ctx } = harness(join(tmpdir(), 'quota-monitor-missing-2b71'));
      const readings = await claudeCodeAdapter.read(ctx);

      expect(readings).toHaveLength(2);
      expect(readings.every((r) => r.used === 0)).toBe(true);
    });
  });

  describe('the denominator', () => {
    it('takes no limit from the plan table, and the note says how to get one', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 10, output: 10 }),
      ]);

      const { ctx } = harness(dir, { plan: 'max-20x' });
      const readings = await claudeCodeAdapter.read(ctx);

      // The table deliberately holds no cap for any plan, so a correctly
      // detected Max 20x still yields no denominator and therefore no bar.
      expect(byWindow(readings, 'session').limit).toBeNull();
      expect(byWindow(readings, 'weekly').limit).toBeNull();

      const note = byWindow(readings, 'session').note ?? '';
      expect(note).toContain('plans.ts');
      expect(note).toContain('no cap known');
      expect(note).toContain('providers.claude-code.sessionLimit');
    });

    it('reads the plan id from ctx.options.plan, tolerating loose spelling', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', []);

      const { ctx } = harness(dir, { plan: 'Max 5x' });
      const readings = await claudeCodeAdapter.read(ctx);

      // Loose spelling still resolves the plan, which drives the label and
      // the session length. It no longer drives a cap, because there is none.
      expect(byWindow(readings, 'session').label).toBe('Max 5x');
      expect(byWindow(readings, 'session').limit).toBeNull();
    });

    it('falls back to the all-null unknown plan rather than inventing a cap', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 10, output: 10 }),
      ]);

      // A bare "max" is ambiguous and must not resolve to either Max tier.
      const { ctx } = harness(dir, { plan: 'max' });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(byWindow(readings, 'session').label).toBe('Unknown plan');
      expect(byWindow(readings, 'session').limit).toBeNull();
      expect(byWindow(readings, 'session').note).toContain('no cap known');
    });

    it('shows no cap for a plan the table declines to estimate', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', []);

      const { ctx } = harness(dir, { plan: 'team' });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(readings.every((r) => r.limit === null)).toBe(true);
      expect(byWindow(readings, 'weekly').note).toContain('providers.claude-code.weeklyLimit');
    });

    it('prefers a measured cap from config, and says the number came from there', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', []);

      const { ctx } = harness(dir, {
        plan: 'max-20x',
        sessionLimit: 250_000,
        weeklyLimit: 4_000_000,
      });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(byWindow(readings, 'session').limit).toBe(250_000);
      expect(byWindow(readings, 'weekly').limit).toBe(4_000_000);
      expect(byWindow(readings, 'session').note).toContain('came from your config');
      expect(byWindow(readings, 'session').note).not.toContain('COMMUNITY ESTIMATE');
    });

    it('accepts "none" as an explicit request for no percentage', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', []);

      // Pair "none" with a real configured weekly cap, so the test still
      // proves the two windows are resolved independently now that the plan
      // table contributes nothing to either of them.
      const { ctx } = harness(dir, {
        plan: 'max-20x',
        sessionLimit: 'none',
        weeklyLimit: 4_000_000,
      });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(byWindow(readings, 'session').limit).toBeNull();
      expect(byWindow(readings, 'weekly').limit).toBe(4_000_000);
    });

    it('ignores a nonsensical cap and falls back to the table, which has none', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', []);

      const { ctx, debug } = harness(dir, { plan: 'max-20x', sessionLimit: -5 });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(byWindow(readings, 'session').limit).toBeNull();
      expect(debug.some((line) => line.includes('sessionLimit'))).toBe(true);
    });

    it('is derived even when the user supplied the denominator themselves', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', []);

      const { ctx } = harness(dir, { sessionLimit: 1000, weeklyLimit: 2000 });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(readings.every((r) => r.confidence === 'derived')).toBe(true);
    });
  });

  describe('window options', () => {
    it('honours a custom session length', async () => {
      const dir = await makeClaudeDir();
      // 02:30 anchors a one-hour window at 02:30, which is still open at 03:00.
      // A clock-aligned hour would have said [03:00, 04:00).
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine('2026-09-11T02:30:00.000Z', 'claude-opus-5', { input: 1, output: 0 }),
      ]);

      const { ctx } = harness(dir, { sessionHours: 1 });
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      expect(session.windowStart).toBe('2026-09-11T02:30:00.000Z');
      expect(session.resetsAt).toBe('2026-09-11T03:30:00.000Z');
    });

    it('honours a custom week start', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', []);

      const { ctx } = harness(dir, { weekStartsOn: 0 });
      const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

      expect(weekly.windowStart).toBe('2026-09-06T00:00:00.000Z');
      expect(weekly.resetsAt).toBe('2026-09-13T00:00:00.000Z');
    });

    it('ignores an out-of-range session length instead of throwing', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 0 }),
      ]);

      const { ctx, debug } = harness(dir, { sessionHours: 99 });
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      // Falls back to five hours, anchored on the message at 02:00.
      expect(session.windowStart).toBe(SESSION_START);
      expect(session.resetsAt).toBe(SESSION_END);
      expect(debug.some((line) => line.includes('sessionHours'))).toBe(true);
    });

    it('ignores an out-of-range week start instead of throwing', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', []);

      const { ctx, debug } = harness(dir, { weekStartsOn: 12 });
      const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

      expect(weekly.windowStart).toBe(WEEK_START);
      expect(debug.some((line) => line.includes('weekStartsOn'))).toBe(true);
    });
  });

  describe('fail-soft parsing', () => {
    it('skips malformed lines and keeps the good ones', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        'not json at all',
        '{"truncated": ',
        '{"type":"user","timestamp":"2026-09-11T02:00:00.000Z"}',
        '{"type":"assistant","model":"claude-opus-5"}',
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 700, output: 300 }),
        '   ',
        '[]',
      ]);

      const { ctx } = harness(dir);
      expect(byWindow(await claudeCodeAdapter.read(ctx), 'session').used).toBe(1000);
    });

    it('reads across several projects and transcripts', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--one', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 100, output: 0 }),
      ]);
      await writeTranscript(dir, 'l--one', 'b.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 200, output: 0 }),
      ]);
      await writeTranscript(dir, 'l--two', 'c.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 300, output: 0 }),
      ]);

      const { ctx } = harness(dir);
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      expect(session.used).toBe(600);
      expect(session.note).toContain('3 transcripts');
    });

    it('handles a batch larger than the internal flush threshold', async () => {
      const dir = await makeClaudeDir();
      const lines = Array.from({ length: 5000 }, () =>
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 }),
      );
      await writeTranscript(dir, 'l--x', 'big.jsonl', lines);

      const { ctx } = harness(dir);
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      expect(session.used).toBe(10_000);
      expect(session.note).toContain('5,000 calls');
    });

    it('skips transcripts last modified before the widest window opened', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(
        dir,
        'l--x',
        'stale.jsonl',
        [assistantLine(IN_SESSION, 'claude-opus-5', { input: 5000, output: 0 })],
        new Date('2026-08-01T00:00:00.000Z'),
      );
      await writeTranscript(dir, 'l--x', 'fresh.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 7, output: 0 }),
      ]);

      const { ctx } = harness(dir);
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      expect(session.used).toBe(7);
      expect(session.note).toContain('1 transcript');
    });
  });

  describe('the work cap', () => {
    it('reads the newest files and refuses to truncate silently', async () => {
      const dir = await makeClaudeDir();
      // Six transcripts, one call each, mtimes an hour apart.
      for (let i = 0; i < 6; i += 1) {
        await writeTranscript(
          dir,
          'l--x',
          `s${i}.jsonl`,
          [assistantLine(IN_SESSION, 'claude-opus-5', { input: 100, output: 0 })],
          new Date(Date.UTC(2026, 8, 9, i)),
        );
      }

      const { ctx, debug } = harness(dir, { maxFiles: 3 });
      const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

      expect(session.used).toBe(300);
      expect(session.note).toContain('TRUNCATED');
      expect(session.note).toContain('6 transcripts matched');
      expect(session.note).toContain('newest 3');
      // Dropped files could hold the message that opened the session window,
      // so the anchor is no longer provable either.
      expect(session.note).toContain('ANCHOR UNCERTAIN');
      expect(debug.some((line) => line.includes('6 transcripts matched'))).toBe(true);
    });

    it('says nothing about truncation when the cap did not bite', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 0 }),
      ]);

      const { ctx } = harness(dir, { maxFiles: 3 });
      expect(byWindow(await claudeCodeAdapter.read(ctx), 'session').note).not.toContain(
        'TRUNCATED',
      );
    });
  });

  /**
   * The adapter is only ever handed options that survived `parseConfig`, and
   * `parseConfig` drops any key matching /token|key|secret|password/i so a
   * pasted credential cannot reach an adapter. That is correct, and it means
   * an option named `sessionTokens` would be silently deleted on the way in -
   * the override would look supported and do nothing. These tests walk the
   * real config path so that trap cannot be re-set by a rename.
   */
  describe('every documented option survives parseConfig', () => {
    const YAML = [
      'providers:',
      '  claude-code:',
      '    plan: max-20x',
      '    dir: /tmp/claude',
      '    sessionHours: 5',
      '    weekStartsOn: 1',
      '    sessionLimit: 240000',
      '    weeklyLimit: 4000000',
      '    countCache: true',
      '    maxFiles: 500',
      '',
    ].join('\n');

    it('keeps every key, with no warning', () => {
      const { config, warnings } = parseConfig(YAML);
      const options = config.providers['claude-code'];

      expect(warnings).toEqual([]);
      expect(options).toMatchObject({
        enabled: true,
        plan: 'max-20x',
        dir: '/tmp/claude',
        sessionHours: 5,
        weekStartsOn: 1,
        sessionLimit: 240_000,
        weeklyLimit: 4_000_000,
        countCache: true,
        maxFiles: 500,
      });
    });

    it('reaches the adapter and actually changes the reading', async () => {
      const dir = await makeClaudeDir();
      await writeTranscript(dir, 'l--x', 'a.jsonl', [
        assistantLine(IN_SESSION, 'claude-opus-5', { input: 10, output: 10 }),
      ]);

      const { config } = parseConfig(YAML);
      const fromFile = config.providers['claude-code'] ?? { enabled: true };
      // Point the parsed options at the fixture, keeping everything else.
      const { ctx } = harness(dir, { ...fromFile, dir });
      const readings = await claudeCodeAdapter.read(ctx);

      expect(byWindow(readings, 'session').limit).toBe(240_000);
      expect(byWindow(readings, 'weekly').limit).toBe(4_000_000);
    });

    it('would have caught the sessionTokens trap', () => {
      // Kept as a live demonstration of why the keys are not called that.
      const { config, warnings } = parseConfig(
        ['providers:', '  claude-code:', '    sessionTokens: 240000', ''].join('\n'),
      );

      expect(config.providers['claude-code']).not.toHaveProperty('sessionTokens');
      expect(warnings.join(' ')).toContain('looks like an inline secret');
    });
  });

  it('never claims a reported confidence, whatever the config says', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 }),
    ]);

    for (const plan of ['pro', 'max-5x', 'max-20x', 'team', 'api', 'unknown', 'nonsense']) {
      const { ctx } = harness(dir, { plan });
      const readings = await claudeCodeAdapter.read(ctx);
      expect(readings.map((r) => r.confidence)).toEqual(['derived', 'derived']);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* regressions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Records 29-31 of a real transcript, restamped into the window under test and
 * with the content blocks elided. One API call, three records - Claude Code
 * writes one per content block and repeats the same cumulative usage object on
 * each. Summed naively this is 3 x (2 + 2087) = 6,267 tokens and 163,845
 * cache-read tokens; the call actually used 2,089 and read 54,615.
 */
function duplicateBlockLines(at: readonly string[]): string[] {
  const usage =
    '"usage":{"input_tokens":2,"cache_creation_input_tokens":427,"cache_read_input_tokens":54615,"output_tokens":2087,"output_tokens_details":{"thinking_tokens":1916}}';
  return at.map(
    (timestamp, i) =>
      `{"type":"assistant","timestamp":"${timestamp}","uuid":"uuid-${i}","requestId":"req_011CevncBsRU8McX6gpT5Hiw","sessionId":"0ad77082-7c17-4558-8c3d-2cfd7cdd4cc1","message":{"id":"msg_011CevncCPS9Vpk3sF8XKQSv","role":"assistant","model":"claude-opus-5",${usage}}}`,
  );
}

const DUPLICATE_STAMPS = [
  '2026-09-11T02:30:59.817Z',
  '2026-09-11T02:31:00.639Z',
  '2026-09-11T02:31:01.592Z',
];

describe('one API call, three records (regression: a 2.8x overcount)', () => {
  it('counts the three content-block records as one call', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(
      dir,
      'l--Open-Source-quota-monitor',
      '0ad77082-7c17-4558-8c3d-2cfd7cdd4cc1.jsonl',
      duplicateBlockLines(DUPLICATE_STAMPS),
    );

    const { ctx } = harness(dir);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.used).toBe(2089);
    expect(session.used).not.toBe(6267);
    expect(session.note).toContain('1 call');
  });

  it('does not treble the cache totals either', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', duplicateBlockLines(DUPLICATE_STAMPS));

    const { ctx } = harness(dir, { countCache: true });
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    // input + output + cacheCreation + cacheRead for the single call.
    expect(session.used).toBe(2 + 2087 + 427 + 54615);
    expect(session.note).toContain('cache tokens included via countCache');
  });

  it('prices one call once', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', duplicateBlockLines(DUPLICATE_STAMPS));
    const one = byWindow(await claudeCodeAdapter.read(harness(dir).ctx), 'session');

    const dirSingle = await makeClaudeDir();
    await writeTranscript(dirSingle, 'l--x', 'a.jsonl', duplicateBlockLines([DUPLICATE_STAMPS[0] ?? '']));
    const single = byWindow(await claudeCodeAdapter.read(harness(dirSingle).ctx), 'session');

    expect(single.estimatedCostUsd).toBeGreaterThan(0);
    expect(one.estimatedCostUsd).toBe(single.estimatedCostUsd);
  });

  it('keeps the later, larger usage object when one is still growing', async () => {
    // The same call recorded twice in a real subagent transcript: output_tokens
    // 3 while the response was in flight, then 26069 once it finished.
    const dir = await makeClaudeDir();
    const line = (at: string, out: number, thinking: number): string =>
      `{"type":"assistant","timestamp":"${at}","requestId":"req_011Cec6nH7EgqNfUpiWiCEWJ","message":{"id":"msg_011Cec6nJP8pWzbyrnrv9Fde","role":"assistant","model":"claude-opus-5","usage":{"input_tokens":2,"cache_creation_input_tokens":247711,"cache_read_input_tokens":0,"output_tokens":${out},"output_tokens_details":{"thinking_tokens":${thinking}}}}}`;
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      line('2026-09-11T02:39:16.736Z', 3, 0),
      line('2026-09-11T02:43:17.337Z', 26069, 6966),
    ]);

    const { ctx } = harness(dir);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.used).toBe(2 + 26069);
    expect(session.note).toContain('1 call');
  });

  it('still counts two genuinely different calls as two', async () => {
    const dir = await makeClaudeDir();
    const line = (at: string, id: string, out: number): string =>
      `{"type":"assistant","timestamp":"${at}","requestId":"req_a","message":{"id":"${id}","role":"assistant","model":"claude-opus-5","usage":{"output_tokens":${out}}}}`;
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      line('2026-09-11T02:00:00.000Z', 'msg_one', 100),
      line('2026-09-11T02:00:01.000Z', 'msg_two', 200),
    ]);

    const { ctx } = harness(dir);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.used).toBe(300);
    expect(session.note).toContain('2 calls');
  });

  it('de-duplicates across a flush boundary within one transcript', async () => {
    // The two records of one call are separated by 3,000 other calls, well past
    // the old 4,096-event flush batch. The largest such gap measured on disk is
    // 2,204 records.
    const dir = await makeClaudeDir();
    const other = (i: number): string =>
      `{"type":"assistant","timestamp":"2026-09-11T02:00:00.000Z","requestId":"req_o${i}","message":{"id":"msg_o${i}","role":"assistant","model":"claude-opus-5","usage":{"output_tokens":1}}}`;
    const dup = (at: string, out: number): string =>
      `{"type":"assistant","timestamp":"${at}","requestId":"req_dup","message":{"id":"msg_dup","role":"assistant","model":"claude-opus-5","usage":{"output_tokens":${out}}}}`;

    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      dup('2026-09-11T02:00:00.000Z', 5),
      ...Array.from({ length: 3000 }, (_unused, i) => other(i)),
      dup('2026-09-11T02:00:02.000Z', 9),
    ]);

    const { ctx } = harness(dir);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.used).toBe(3000 + 9);
    expect(session.note).toContain('3,001 calls');
  });
});

describe('nested subagent transcripts (regression: half the tokens went missing)', () => {
  it('counts a transcript four levels below the project directory', async () => {
    const dir = await makeClaudeDir();
    const nestedDir = join(
      dir,
      'projects',
      'l--Open-Source-frameforge',
      '82087e29-8809-4b9a-b10e-a2a8f7444051',
      'subagents',
      'workflows',
      'wf_0a765196-414',
    );
    await mkdir(nestedDir, { recursive: true });
    const nested = join(nestedDir, 'agent-a20beb8bee51569a8.jsonl');
    // The real record, restamped into the window under test.
    await writeFile(
      nested,
      '{"type":"assistant","timestamp":"2026-09-11T02:43:17.337Z","requestId":"req_011Cec6nH7EgqNfUpiWiCEWJ","message":{"id":"msg_011Cec6nJP8pWzbyrnrv9Fde","role":"assistant","model":"claude-opus-5","usage":{"input_tokens":2,"cache_creation_input_tokens":247711,"output_tokens":26069,"output_tokens_details":{"thinking_tokens":6966}}}}\n',
      'utf8',
    );
    await utimes(nested, RECENT_MTIME, RECENT_MTIME);

    const { ctx } = harness(dir);
    const readings = await claudeCodeAdapter.read(ctx);
    const session = byWindow(readings, 'session');

    expect(session.used).toBe(2 + 26069);
    expect(session.note).toContain('1 transcript');
    expect(session.note).not.toContain('INCOMPLETE');
  });

  it('adds nested usage to the top-level transcript rather than replacing it', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--proj', 'session.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 10, output: 90 }),
    ]);
    const nestedDir = join(dir, 'projects', 'l--proj', 'session', 'subagents');
    await mkdir(nestedDir, { recursive: true });
    const nested = join(nestedDir, 'agent-1.jsonl');
    await writeFile(
      nested,
      `${assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 4 })}\n`,
      'utf8',
    );
    await utimes(nested, RECENT_MTIME, RECENT_MTIME);

    const { ctx } = harness(dir);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.used).toBe(105);
    expect(session.note).toContain('2 transcripts');
  });

  it('detect() sees a project whose only transcripts are nested', async () => {
    const dir = await makeClaudeDir();
    const nestedDir = join(dir, 'projects', 'l--proj', 'sess', 'subagents', 'workflows', 'wf_1');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, 'agent-1.jsonl'), '{"type":"assistant"}\n', 'utf8');

    const { ctx } = harness(dir);
    expect(await claudeCodeAdapter.detect(ctx)).toBe(true);
  });
});

describe('partial reads (regression: a prefix reported as a whole file)', () => {
  it('says INCOMPLETE when a transcript could not be read to the end', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 }),
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 }),
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 }),
    ]);

    const { ctx, debug } = harness(dir);
    const readings = await withReadStream(
      () =>
        failingStream(
          [`${assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 })}\n`],
          Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }),
        ),
      () => claudeCodeAdapter.read(ctx),
    );

    const session = byWindow(readings, 'session');
    // The prefix that did arrive is still counted - it is real usage.
    expect(session.used).toBe(2);
    // ...but the reading must not present it as the whole file.
    expect(session.note).toContain('INCOMPLETE');
    expect(session.note).toContain('1 of 1 transcript');
    expect(session.note).toContain('undercount');
    expect(byWindow(readings, 'weekly').note).toContain('INCOMPLETE');
    expect(debug.some((line) => line.includes('was not fully read'))).toBe(true);
  });

  it('says nothing about INCOMPLETE when every transcript was read', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 }),
    ]);

    const { ctx } = harness(dir);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.note).not.toContain('INCOMPLETE');
  });

  it('says INCOMPLETE when a line above the length cap had to be dropped', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 }),
      `{"type":"assistant","pad":"${'x'.repeat(MAX_LINE_LENGTH)}"}`,
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1, output: 1 }),
    ]);

    const { ctx } = harness(dir);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    // Both real records survive; the monster line does not, and is disclosed.
    expect(session.used).toBe(4);
    expect(session.note).toContain('INCOMPLETE');
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* the session window is anchored to activity, not to the clock               */
/* -------------------------------------------------------------------------- */

/**
 * The reading that started this: 2026-09-11 at 08:17Z, Claude Code's own
 * /usage panel showing "Session (5hr) 13%, resets in 3h" while the widget said
 * 48%. The panel's countdown puts the window at 06:49Z-11:49Z, which is five
 * hours from the first message after the previous window lapsed - not the
 * 05:00Z-10:00Z clock block the adapter used to ask for.
 *
 * The fixture below is that morning's shape, with the measured token counts:
 * 641,223 tokens in the window that had already closed and 709,837 in the one
 * that was open. A clock-aligned adapter reports their sum, 1,351,060, which
 * is almost exactly the double the user noticed.
 */
const NOW_0817 = new Date('2026-09-11T08:17:00.000Z');

/** Opens the PREVIOUS window, 01:49 -> 06:49. Nothing else can. */
const PREV_ANCHOR = '2026-09-11T01:49:00.000Z';
/** Five hours after PREV_ANCHOR to the millisecond: opens the current window. */
const ANCHOR = '2026-09-11T06:49:00.000Z';
const ANCHOR_END = '2026-09-11T11:49:00.000Z';
/** What windowBounds('session') would have returned at 08:17Z. */
const CLOCK_BLOCK_START = '2026-09-11T05:00:00.000Z';

/** The morning's usage, in one transcript, exactly as the adapter reads it. */
const MORNING_LINES = [
  assistantLine(PREV_ANCHOR, 'claude-opus-5', { input: 1_000 }),
  assistantLine('2026-09-11T05:10:00.000Z', 'claude-opus-5', { input: 500_000 }),
  assistantLine('2026-09-11T06:30:00.000Z', 'claude-opus-5', { input: 141_223 }),
  assistantLine(ANCHOR, 'claude-opus-5', { input: 200_000 }),
  assistantLine('2026-09-11T07:30:00.000Z', 'claude-opus-5', { input: 300_000 }),
  assistantLine('2026-09-11T08:00:00.000Z', 'claude-opus-5', { input: 209_837 }),
];

describe('anchoring the session window to activity (regression: a 2x overcount)', () => {
  it('opens the window on the first message after the last one lapsed', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', MORNING_LINES);

    const { ctx } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.windowStart).toBe(ANCHOR);
    expect(session.resetsAt).toBe(ANCHOR_END);
  });

  it('is not the clock block, and does not count the previous window', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', MORNING_LINES);

    const { ctx } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    // A clock-aligned implementation fails both of these.
    expect(session.windowStart).not.toBe(CLOCK_BLOCK_START);
    expect(session.used).not.toBe(1_351_060);
    expect(session.used).toBe(709_837);
  });

  it('divides by the measured cap to the percentage Claude Code showed', async () => {
    // The user's config now carries the caps implied by the corrected figure:
    // 709,837 / 0.13. Getting 13% back out is the end-to-end check.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', MORNING_LINES);

    const { ctx } = harness(dir, { sessionLimit: 5_460_285 }, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(Math.round(percentUsed(session) ?? 0)).toBe(13);
    // ...and it is still derived. Correcting the window did not make the cap
    // ours to report; the user supplied it.
    expect(session.confidence).toBe('derived');
  });

  it('says in the note where the window opened and why', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', MORNING_LINES);

    const { ctx, debug } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');
    const note = session.note ?? '';

    expect(note).toContain('ANCHORED TO YOUR ACTIVITY');
    expect(note).toContain(ANCHOR);
    expect(note).toContain(ANCHOR_END);
    // The lookback covered a full day and found an idle gap, so there is
    // nothing to hedge about.
    expect(note).not.toContain('ANCHOR UNCERTAIN');
    expect(debug.some((line) => line.includes('anchored to activity'))).toBe(true);
  });

  it('leaves the weekly window exactly where it was', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', MORNING_LINES);

    const { ctx } = harness(dir, {}, NOW_0817);
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    expect(weekly.windowStart).toBe(WEEK_START);
    expect(weekly.resetsAt).toBe(WEEK_END);
    // Every token of the morning, including the closed session window's.
    expect(weekly.used).toBe(1_352_060);
    expect(weekly.note ?? '').not.toContain('ANCHORED TO YOUR ACTIVITY');
  });

  it('reports no open window rather than inventing one after a long idle', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T01:00:00.000Z', 'claude-opus-5', { input: 42_000 }),
    ]);

    const { ctx } = harness(dir, {}, NOW_0817);
    const readings = await claudeCodeAdapter.read(ctx);
    const session = byWindow(readings, 'session');

    // The window opened at 01:00 and closed at 06:00; nothing has opened one
    // since, so there is no interval and no countdown to show.
    expect(session.windowStart).toBeNull();
    expect(session.resetsAt).toBeNull();
    expect(session.used).toBe(0);
    expect(session.note ?? '').toContain('no session window is open');
    expect(session.note ?? '').toContain('2026-09-11T06:00:00.000Z');

    // The tokens are not lost - they are still this week's.
    expect(byWindow(readings, 'weekly').used).toBe(42_000);
  });

  it('says nothing is open when the search finds no usage at all', async () => {
    const dir = await makeClaudeDir();
    // The one record on disk is older than the widest the search can ever
    // reach, so the transcript is opened (its mtime is recent) and yields
    // nothing at all - not even a timestamp to chain from.
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-06-01T09:00:00.000Z', 'claude-opus-5', { input: 5_000 }),
    ]);

    const { ctx } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.windowStart).toBeNull();
    expect(session.used).toBe(0);
    expect(session.note ?? '').toContain('no usage recorded in the');
    expect(session.note ?? '').toContain('searched');
  });

  it('honours a session length longer than the default when anchoring', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', MORNING_LINES);

    // At eight hours the 01:49 window is still open at 08:17, so nothing after
    // it ever anchors a new one and the whole morning counts.
    const { ctx } = harness(dir, { sessionHours: 8 }, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.windowStart).toBe(PREV_ANCHOR);
    expect(session.resetsAt).toBe('2026-09-11T09:49:00.000Z');
    expect(session.used).toBe(1_352_060);
  });
});

/* -------------------------------------------------------------------------- */
/* the widening search for the anchor                                         */
/* -------------------------------------------------------------------------- */

/**
 * ANCHOR UNCERTAIN has to MEAN something.
 *
 * Proving where the rolling window opened needs an idle gap of one whole
 * session window inside the stretch of history that was actually read. The
 * adapter used to read a fixed 24 hours, which for anyone who uses Claude Code
 * daily runs right up to the edge of the lookback - so the disclosure fired on
 * nearly every read, including on this machine while the anchor was provably
 * right, and a warning that is always on is a warning nobody reads.
 *
 * The search now widens (24h, 3d, 7d, 30d) and stops the instant it can prove
 * the anchor. These tests are the point of that change, and the assertions
 * that matter most are the two NEGATIVE ones: the note must be ABSENT when a
 * gap was found, whether it took one step or several.
 */

/** One record every `everyHours` hours across `[fromIso, toIso]`, inclusive. */
function steadyLines(fromIso: string, toIso: string, everyHours: number): string[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const step = everyHours * 3_600_000;
  const lines: string[] = [];
  for (let at = from; at <= to; at += step) {
    lines.push(assistantLine(new Date(at).toISOString(), 'claude-opus-5', { input: 10 }));
  }
  return lines;
}

/** Debug lines the widening loop emits, whether it stepped or gave up. */
function widenings(debug: readonly string[]): string[] {
  return debug.filter((line) => line.includes('widen'));
}

describe('the widening search for the session anchor', () => {
  it('finds the gap in the first stretch, widens nothing, and says nothing', async () => {
    // The morning fixture: nothing at all before 01:49, and the search starts
    // at the week boundary, so the idle stretch is days long and the very
    // first check proves the chain.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', MORNING_LINES);

    const { ctx, debug } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.windowStart).toBe(ANCHOR);
    // The whole point of the change.
    expect(session.note ?? '').not.toContain('ANCHOR UNCERTAIN');
    // And it cost exactly what it cost before: one pass, no second listing.
    expect(widenings(debug)).toEqual([]);
    expect(debug.some((line) => line.includes('scanning 1 transcript'))).toBe(true);
  });

  it('widens once when the first stretch has no gap, and still says nothing', async () => {
    const dir = await makeClaudeDir();
    // Unbroken activity every four hours from the start of the week to now, so
    // the first stretch - which reaches back to the week boundary - holds no
    // five-hour gap anywhere and cannot prove the anchor on its own.
    await writeTranscript(
      dir,
      'l--x',
      'week.jsonl',
      steadyLines('2026-09-07T00:00:00.000Z', '2026-09-11T08:00:00.000Z', 4),
      new Date('2026-09-11T08:00:00.000Z'),
    );
    // Older activity, in a transcript last written before the week opened, so
    // the first pass never touches it. It ends 15h into 2026-09-04, which is
    // where the seven-day rung starts looking - and that leading idle stretch
    // is the proof.
    await writeTranscript(
      dir,
      'l--x',
      'before.jsonl',
      steadyLines('2026-09-05T00:00:00.000Z', '2026-09-06T20:00:00.000Z', 4),
      new Date('2026-09-06T20:00:00.000Z'),
    );

    const { ctx, debug } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    // Chained from 09-05T00:00, the windows land on 00:00, 08:00 and 16:00
    // each day, so the one open at 08:17 opened at 08:00.
    expect(session.windowStart).toBe('2026-09-11T08:00:00.000Z');
    expect(session.resetsAt).toBe('2026-09-11T13:00:00.000Z');
    // Widened - and therefore silent. This is the case that used to warn.
    expect(session.note ?? '').not.toContain('ANCHOR UNCERTAIN');

    const steps = widenings(debug);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain('widened the anchor search to 7 days');
    expect(steps[0]).toContain('idle gap');
    // One extra transcript opened, not the whole directory.
    expect(steps[0]).toContain('+1 transcript');
  });

  it('warns only when the ceiling is reached with no gap anywhere', async () => {
    const dir = await makeClaudeDir();
    // A month of activity every four hours with no five-hour break in it, one
    // transcript per day so the widening steps have something new to open.
    // Nothing short of the ceiling can prove an anchor against this.
    const lastMs = Date.parse('2026-09-11T08:00:00.000Z');
    for (let day = 0; day < 33; day += 1) {
      const from = Date.UTC(2026, 7, 10 + day);
      if (from > lastMs) break;
      const to = Math.min(from + 20 * 3_600_000, lastMs);
      await writeTranscript(
        dir,
        'l--x',
        `d${String(day).padStart(2, '0')}.jsonl`,
        steadyLines(new Date(from).toISOString(), new Date(to).toISOString(), 4),
        new Date(to),
      );
    }

    const { ctx, debug } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');
    const note = session.note ?? '';

    // Chained from the oldest record inside the ceiling (08-12T12:00), the
    // windows settle on 04:00, 12:00 and 20:00 each day - so this is a real
    // answer, it just cannot be shown to be the right one, which is exactly
    // what the note has to say.
    expect(session.windowStart).toBe('2026-09-11T04:00:00.000Z');
    expect(note).toContain('ANCHOR UNCERTAIN');
    expect(note).toContain('no idle gap of 5 hours');
    expect(note).toContain('30 days of history searched');
    expect(note).toContain('as far back as the search goes');
    expect(note).toContain('undercount');
    expect(debug.some((line) => line.includes('anchor uncertain'))).toBe(true);

    // It walked the ladder to the ceiling and stopped there: 7 days, then 30.
    const steps = widenings(debug);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('widened the anchor search to 7 days');
    expect(steps[1]).toContain('widened the anchor search to 30 days');
    expect(steps.every((line) => line.includes('still no idle gap'))).toBe(true);
  }, 30_000);

  it('stops at the file ceiling rather than reading the whole directory', async () => {
    const dir = await makeClaudeDir();
    // Unbroken four-hourly activity across the week, so the first stretch
    // cannot prove the anchor and the search wants to widen...
    await writeTranscript(
      dir,
      'l--x',
      'week.jsonl',
      steadyLines('2026-09-07T00:00:00.000Z', '2026-09-11T08:00:00.000Z', 4),
      new Date('2026-09-11T08:00:00.000Z'),
    );
    // ...into more transcripts than one refresh is allowed to open. A step
    // that does not fit is not started at all: half of it could show an idle
    // gap that the unread half fills in.
    const older = new Date('2026-09-06T20:00:00.000Z');
    await Promise.all(
      Array.from({ length: MAX_ANCHOR_WIDENING_FILES + 1 }, (_unused, i) =>
        writeTranscript(
          dir,
          'l--x',
          `old${String(i).padStart(4, '0')}.jsonl`,
          [assistantLine('2026-09-06T20:00:00.000Z', 'claude-opus-5', { input: 1 })],
          older,
        ),
      ),
    );

    const { ctx, debug } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');
    const note = session.note ?? '';

    expect(note).toContain('ANCHOR UNCERTAIN');
    expect(note).toContain(`opened ${MAX_ANCHOR_WIDENING_FILES + 1} more transcripts`);
    // It searched what it had already read and stopped there.
    expect(note).toContain('4.35 days of history searched');
    expect(debug.some((line) => line.includes('past the 400-file ceiling'))).toBe(true);
    // The weekly reading is untouched by any of this: 27 records of 10 tokens.
    expect(byWindow(await claudeCodeAdapter.read(ctx), 'weekly').used).toBe(270);
  }, 60_000);

  it('no longer warns about the case that used to warn on every read', async () => {
    // The old fixed 24-hour lookback disclosed ANCHOR UNCERTAIN here, because
    // the oldest usage it could see sat 0.28h inside the lookback. The anchor
    // was never actually in doubt: the search starts at the week boundary,
    // three days of silence precede that message, and that is a proof.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-10T10:00:00.000Z', 'claude-opus-5', { input: 10 }),
      assistantLine('2026-09-11T08:10:00.000Z', 'claude-opus-5', { input: 20 }),
    ]);

    const { ctx, debug } = harness(dir, {}, NOW_0817);
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.windowStart).toBe('2026-09-11T08:10:00.000Z');
    expect(session.resetsAt).toBe('2026-09-11T13:10:00.000Z');
    expect(session.note ?? '').not.toContain('ANCHOR UNCERTAIN');
    expect(debug.some((line) => line.includes('anchor uncertain'))).toBe(false);
    expect(widenings(debug)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Anthropic's own figure, via the status line snapshot                       */
/* -------------------------------------------------------------------------- */

/** A home directory of its own, so a snapshot written here reaches only this test. */
async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-cc-home-'));
  created.push(dir);
  return dir;
}

function snapshotHarness(
  claudeDir: string,
  home: string,
  options: Record<string, unknown> = {},
  now: Date = NOW,
): Harness {
  const base = harness(claudeDir, options, now);
  return { debug: base.debug, ctx: { ...base.ctx, homeDir: home } };
}

function reported(
  usedPercentage: number,
  resetsAt: string,
  observedAt: string,
  history: readonly { usedPercentage: number; observedAt: string }[] = [],
) {
  return {
    usedPercentage,
    resetsAt: new Date(resetsAt),
    observedAt: new Date(observedAt),
    clamped: false,
    history: history.map((seen) => ({
      usedPercentage: seen.usedPercentage,
      observedAt: new Date(seen.observedAt),
    })),
  };
}

async function writeSnapshot(home: string, windows: RateLimitSnapshot['windows']): Promise<void> {
  await writeRateLimitSnapshot(statusLineSnapshotPath(home), { writtenAt: NOW, windows });
}

describe('reported figures from the status line snapshot', () => {
  it("reports Anthropic's own percentages, reset times and window bounds", async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1000, output: 500 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      five_hour: reported(18, '2026-09-11T06:00:00.000Z', '2026-09-11T02:30:00.000Z'),
      seven_day: reported(39.5, '2026-09-15T12:00:00.000Z', '2026-09-11T02:30:00.000Z'),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x' });
    const readings = await claudeCodeAdapter.read(ctx);
    expect(readings.map((r) => r.window)).toEqual(['session', 'weekly']);

    const session = byWindow(readings, 'session');
    expect(session).toMatchObject({
      provider: 'claude-code',
      label: 'Max 20x',
      confidence: 'reported',
      unit: 'percent',
      used: 18,
      limit: PERCENT_LIMIT,
      resetsAt: '2026-09-11T06:00:00.000Z',
      windowStart: '2026-09-11T01:00:00.000Z',
    });
    expect(percentUsed(session)).toBe(18);
    expect(session.estimatedCostUsd).toBeGreaterThan(0);
    expect(session.note).toContain("Anthropic's own figure");
    expect(session.note).toContain('no Claude Code call has been recorded on this machine since');

    const weekly = byWindow(readings, 'weekly');
    expect(weekly).toMatchObject({
      confidence: 'reported',
      unit: 'percent',
      used: 39.5,
      resetsAt: '2026-09-15T12:00:00.000Z',
      windowStart: '2026-09-08T12:00:00.000Z',
    });
  });

  it("counts tokens and cost over Anthropic's five hours, not over the estimated window", async () => {
    // The estimate anchors on the 00:30 call and opens [00:30, 05:30). Anthropic
    // says the window resets at 06:00, so it opened at 01:00 and the 00:30 call
    // belongs to the window before it.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T00:30:00.000Z', 'claude-opus-5', { input: 100_000 }),
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1000 }),
    ]);

    const estimate = byWindow(
      await claudeCodeAdapter.read(snapshotHarness(dir, await makeHome()).ctx),
      'session',
    );
    expect(estimate.used).toBe(101_000);

    const home = await makeHome();
    await writeSnapshot(home, {
      five_hour: reported(12, '2026-09-11T06:00:00.000Z', '2026-09-11T02:59:00.000Z'),
    });
    const session = byWindow(await claudeCodeAdapter.read(snapshotHarness(dir, home).ctx), 'session');

    expect(session.confidence).toBe('reported');
    expect(session.note).toContain('covers 1 call inside this same window');
    expect(session.estimatedCostUsd ?? 0).toBeLessThan(estimate.estimatedCostUsd ?? 0);
  });

  it("uses Anthropic's seven-day bounds even when they open before the calendar week", async () => {
    // Monday 2026-09-07 opens the calendar week. Anthropic's window resets on
    // Saturday at 18:00, so it opened the previous Saturday - and the Sunday
    // call below is inside it.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-06T12:00:00.000Z', 'claude-opus-5', { input: 400 }),
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1000 }),
    ]);

    const calendar = byWindow(
      await claudeCodeAdapter.read(snapshotHarness(dir, await makeHome()).ctx),
      'weekly',
    );
    expect(calendar.used).toBe(1000);

    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(41, '2026-09-12T18:00:00.000Z', '2026-09-11T02:59:00.000Z'),
    });
    const weekly = byWindow(await claudeCodeAdapter.read(snapshotHarness(dir, home).ctx), 'weekly');

    expect(weekly.windowStart).toBe('2026-09-05T18:00:00.000Z');
    expect(weekly.note).toContain('covers 2 calls inside this same window');
  });

  it('says how far behind the figure is when calls came after it', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 10 }),
      assistantLine('2026-09-11T02:10:00.000Z', 'claude-opus-5', { input: 10 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      five_hour: reported(30, '2026-09-11T06:00:00.000Z', '2026-09-11T01:30:00.000Z'),
    });

    const session = byWindow(await claudeCodeAdapter.read(snapshotHarness(dir, home).ctx), 'session');

    expect(session.confidence).toBe('reported');
    expect(session.note).toContain('BEHIND');
    expect(session.note).toContain('1h 30m ago');
    expect(session.note).toContain('2 Claude Code calls recorded on this machine since then are not in it');
  });

  it('does not count a call recorded moments before the status line ran as one it missed', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T02:00:30.000Z', 'claude-opus-5', { input: 10 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      five_hour: reported(30, '2026-09-11T06:00:00.000Z', '2026-09-11T02:00:00.000Z'),
    });

    const session = byWindow(await claudeCodeAdapter.read(snapshotHarness(dir, home).ctx), 'session');
    expect(session.note).not.toContain('BEHIND');
  });

  it("falls back to the estimate once Anthropic's window has reset, and says so", async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1000, output: 500 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      five_hour: reported(97, '2026-09-11T02:30:00.000Z', '2026-09-11T01:00:00.000Z'),
    });

    const readings = await claudeCodeAdapter.read(snapshotHarness(dir, home).ctx);
    const session = byWindow(readings, 'session');
    const weekly = byWindow(readings, 'weekly');

    expect(session.confidence).toBe('derived');
    expect(session.unit).toBe('tokens');
    expect(session.note).toContain("Anthropic's last reported 5-hour figure, 97%");
    expect(session.note).toContain('ended at 2026-09-11T02:30:00.000Z');
    expect(weekly.confidence).toBe('derived');
    expect(weekly.note).toContain('has not seen a 7-day figure yet');
  });

  it('points at the status line setup when there is no snapshot at all', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1 }),
    ]);

    const { ctx, debug } = snapshotHarness(dir, await makeHome());
    const readings = await claudeCodeAdapter.read(ctx);

    expect(readings.every((r) => r.confidence === 'derived')).toBe(true);
    expect(byWindow(readings, 'session').note).toContain('quota statusline --print-config');
    expect(debug).toContain('claude-code: no status line snapshot, so every percentage is derived');
  });

  it('treats a snapshot it cannot read as no snapshot', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {});
    await writeFile(statusLineSnapshotPath(home), '{"kind": "claude-code-rate-limits", ', 'utf8');

    const readings = await claudeCodeAdapter.read(snapshotHarness(dir, home).ctx);
    expect(readings.every((r) => r.confidence === 'derived')).toBe(true);
  });

  it('skips the anchor search for a five-hour window Anthropic reported', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine(IN_SESSION, 'claude-opus-5', { input: 1 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      five_hour: reported(5, '2026-09-11T06:00:00.000Z', '2026-09-11T02:59:00.000Z'),
    });

    const { ctx, debug } = snapshotHarness(dir, home);
    await claudeCodeAdapter.read(ctx);

    expect(debug.some((line) => line.includes('5-hour reported'))).toBe(true);
    expect(debug.some((line) => line.includes('anchored to activity'))).toBe(false);
    expect(widenings(debug)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* topping a stale reported figure up                                         */
/* -------------------------------------------------------------------------- */

describe('topping a reported figure up with the usage it cannot include', () => {
  it('adds the calls recorded since, and marks the whole row an estimate', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      // Before the figure: already inside it, and must not be added twice.
      assistantLine('2026-09-11T01:00:00.000Z', 'claude-opus-5', { input: 100_000 }),
      // After it: this is what the status line never got to see.
      assistantLine('2026-09-11T02:30:00.000Z', 'claude-opus-5', { input: 50_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(40, '2026-09-15T12:00:00.000Z', '2026-09-11T02:00:00.000Z'),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 1_000_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    // 50,000 of a 1,000,000 cap is five points, on top of Anthropic's forty.
    expect(weekly.used).toBe(45);
    expect(weekly.unit).toBe('percent');
    expect(weekly.limit).toBe(PERCENT_LIMIT);
    // Ours now, in part, so it may not claim to be theirs.
    expect(weekly.confidence).toBe('derived');
    expect(weekly.note).toContain('TOPPED UP');
    expect(weekly.note).toContain("40% of the 7-day limit is Anthropic's own figure");
    expect(weekly.note).toContain('adds an estimate of 5%');
    expect(weekly.note).toContain('1 Claude Code call recorded on this machine since');
  });

  it('tops the five-hour window up the same way', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T02:30:00.000Z', 'claude-opus-5', { input: 20_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      five_hour: reported(20, '2026-09-11T06:00:00.000Z', '2026-09-11T02:00:00.000Z'),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', sessionLimit: 200_000 });
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    expect(session.used).toBe(30);
    expect(session.confidence).toBe('derived');
    expect(session.note).toContain('TOPPED UP');
  });

  it("leaves the figure exactly as Anthropic stated it when nothing came after", async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T01:00:00.000Z', 'claude-opus-5', { input: 100_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(40, '2026-09-15T12:00:00.000Z', '2026-09-11T02:00:00.000Z'),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 1_000_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    expect(weekly.used).toBe(40);
    expect(weekly.confidence).toBe('reported');
    expect(weekly.note).not.toContain('TOPPED UP');
  });

  it('does not add the call that produced the figure', async () => {
    // Thirty seconds after the status line ran: the same response, written to
    // the transcript a moment later. Inside the grace, so it is already in the
    // percentage and adding it would count it twice.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T02:00:30.000Z', 'claude-opus-5', { input: 50_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(40, '2026-09-15T12:00:00.000Z', '2026-09-11T02:00:00.000Z'),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 1_000_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    expect(weekly.used).toBe(40);
    expect(weekly.confidence).toBe('reported');
  });

  it('never tops a figure past 100', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T02:30:00.000Z', 'claude-opus-5', { input: 500_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(97, '2026-09-15T12:00:00.000Z', '2026-09-11T02:00:00.000Z'),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 1_000_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    expect(weekly.used).toBe(PERCENT_LIMIT);
    expect(percentUsed(weekly)).toBe(PERCENT_LIMIT);
  });

  it('says the figure is behind, and how to make it estimable, when there is no cap', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T02:30:00.000Z', 'claude-opus-5', { input: 50_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(40, '2026-09-15T12:00:00.000Z', '2026-09-11T02:00:00.000Z'),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 'none' });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    expect(weekly.used).toBe(40);
    expect(weekly.confidence).toBe('reported');
    expect(weekly.note).toContain('BEHIND');
    expect(weekly.note).toContain('providers.claude-code.weeklyLimit');
  });
});

/* -------------------------------------------------------------------------- */
/* pricing the top-up from Anthropic's own two figures                        */
/* -------------------------------------------------------------------------- */

describe('the rate the top-up is priced at', () => {
  const RESETS = '2026-09-15T12:00:00.000Z';

  it("measures it from the last two reported figures rather than from a cap", async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      // Between the two figures: 100K tokens bought 10 points, so one point
      // costs 10K tokens whatever mix of models produced them.
      assistantLine('2026-09-11T00:30:00.000Z', 'claude-opus-5', { input: 100_000 }),
      // After the second figure: 50K tokens, which at that rate is 5 points.
      assistantLine('2026-09-11T02:00:00.000Z', 'claude-opus-5', { input: 50_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(50, RESETS, '2026-09-11T01:00:00.000Z', [
        { usedPercentage: 40, observedAt: '2026-09-11T00:00:00.000Z' },
      ]),
    });

    // A cap that would give a very different answer: 50K of 500K is 10 points,
    // not 5. The measured rate has to win.
    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 500_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    expect(weekly.used).toBeCloseTo(55, 6);
    expect(weekly.confidence).toBe('derived');
    expect(weekly.note).toContain('MEASURED');
    expect(weekly.note).toContain('they added 10% over the 100.0K tokens recorded between');
    // The addition is local-only, and the row has to say so.
    expect(weekly.note).toContain('FLOOR');
  });

  it('falls back to the cap when too little local work sits between the two figures', async () => {
    // 10K tokens is under the floor: an interval that thin is mostly a
    // measurement of what happened on someone's phone.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T00:30:00.000Z', 'claude-opus-5', { input: 10_000 }),
      assistantLine('2026-09-11T02:00:00.000Z', 'claude-opus-5', { input: 50_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(50, RESETS, '2026-09-11T01:00:00.000Z', [
        { usedPercentage: 40, observedAt: '2026-09-11T00:00:00.000Z' },
      ]),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 500_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    // 50K of the 500K cap: ten points, the old arithmetic.
    expect(weekly.used).toBeCloseTo(60, 6);
    expect(weekly.note).toContain('priced against the 500.0K-token cap');
    expect(weekly.note).toContain('a constant, so it is only right while your mix of models is');
  });

  it('prices from the newest usable pair, not the oldest', async () => {
    // The oldest pair spans a cheap stretch (40 points for 2M tokens); the
    // newest spans an expensive one (2 points for 40K). Anything that reached
    // for the widest span would price this work at a fifth of what it costs.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-10T21:00:00.000Z', 'claude-sonnet-4-5', { input: 2_000_000 }),
      assistantLine('2026-09-11T00:45:00.000Z', 'claude-opus-5', { input: 40_000 }),
      assistantLine('2026-09-11T02:00:00.000Z', 'claude-opus-5', { input: 50_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(50, RESETS, '2026-09-11T01:00:00.000Z', [
        { usedPercentage: 10, observedAt: '2026-09-10T20:00:00.000Z' },
        { usedPercentage: 44, observedAt: '2026-09-11T00:00:00.000Z' },
        { usedPercentage: 48, observedAt: '2026-09-11T00:30:00.000Z' },
      ]),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 500_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    // 2 points per 40K tokens, so 50K tokens is 2.5 points.
    expect(weekly.used).toBeCloseTo(52.5, 6);
    expect(weekly.note).toContain('2026-09-11T00:30:00.000Z');
  });

  it('widens to an older pair when the newest rise is too small to measure', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T00:30:00.000Z', 'claude-opus-5', { input: 100_000 }),
      assistantLine('2026-09-11T02:00:00.000Z', 'claude-opus-5', { input: 50_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      // Half a point apart: under the floor, and the only pair there is.
      seven_day: reported(50, RESETS, '2026-09-11T01:00:00.000Z', [
        { usedPercentage: 49.5, observedAt: '2026-09-11T00:00:00.000Z' },
      ]),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 500_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    // 0.5 points per 100K tokens, so 50K is a quarter of a point.
    expect(weekly.used).toBeCloseTo(50.25, 6);
    expect(weekly.note).toContain('MEASURED');
  });

  it('measures the five-hour window from its own pair', async () => {
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T01:30:00.000Z', 'claude-opus-5', { input: 60_000 }),
      assistantLine('2026-09-11T02:30:00.000Z', 'claude-opus-5', { input: 30_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      five_hour: reported(20, '2026-09-11T06:00:00.000Z', '2026-09-11T02:00:00.000Z', [
        { usedPercentage: 14, observedAt: '2026-09-11T01:00:00.000Z' },
      ]),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', sessionLimit: 1_000_000 });
    const session = byWindow(await claudeCodeAdapter.read(ctx), 'session');

    // 6 points per 60K tokens, so 30K is 3 points on top of 20.
    expect(session.used).toBeCloseTo(23, 6);
    expect(session.note).toContain('MEASURED');
  });

  it('ignores history from a window that has since reset', async () => {
    // The pair belongs to the window before this one. `mergeSnapshot` clears
    // history on a reset, so a file carrying both is one this tool did not
    // write - and the adapter still must not price today's work with
    // yesterday's rate. Nothing usable means the cap, not a guess.
    const dir = await makeClaudeDir();
    await writeTranscript(dir, 'l--x', 'a.jsonl', [
      assistantLine('2026-09-11T02:00:00.000Z', 'claude-opus-5', { input: 50_000 }),
    ]);
    const home = await makeHome();
    await writeSnapshot(home, {
      seven_day: reported(50, RESETS, '2026-09-11T01:00:00.000Z', [
        // Higher than the current figure: only a reset explains it.
        { usedPercentage: 80, observedAt: '2026-09-11T00:00:00.000Z' },
      ]),
    });

    const { ctx } = snapshotHarness(dir, home, { plan: 'max-20x', weeklyLimit: 500_000 });
    const weekly = byWindow(await claudeCodeAdapter.read(ctx), 'weekly');

    expect(weekly.used).toBeCloseTo(60, 6);
    expect(weekly.note).toContain('priced against the 500.0K-token cap');
  });
});
