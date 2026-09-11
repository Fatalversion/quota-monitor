import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { parseConfig } from '../../core/config.js';
import { MemorySecretStore } from '../../core/secrets.js';
import { MAX_ROLLOUT_FILES, PERCENT_LIMIT, PROVIDER_ID, codexAdapter } from './index.js';

import type { AdapterContext, QuotaReading } from '../../core/types.js';

/**
 * Fixed instants. Nothing in this file may consult the wall clock.
 *
 * `SNAPSHOT_AT` is the timestamp on the real rollout line quoted in
 * `parse.ts`, and NOW sits exactly 134 minutes later so the staleness the note
 * prints is a value the test can name: '2h 14m'.
 */
const NOW = new Date('2026-09-07T10:46:02.043Z');
const SNAPSHOT_AT = '2026-09-07T08:32:02.043Z';

/**
 * `resets_at` values from the real file, in UNIX SECONDS. The ISO strings
 * beside them are what the adapter must produce - written out rather than
 * computed, so a sign error in the seconds-to-milliseconds conversion cannot
 * hide behind the same arithmetic on both sides.
 */
const PRIMARY_RESETS_AT = 1_788_787_915;
const PRIMARY_RESETS_AT_ISO = '2026-09-07T13:31:55.000Z';
const SECONDARY_RESETS_AT = 1_789_374_715;
const SECONDARY_RESETS_AT_ISO = '2026-09-14T08:31:55.000Z';

/** resets_at minus window_minutes, for each window. Both land on the same instant here. */
const PRIMARY_STARTS_ISO = '2026-09-07T08:31:55.000Z';
const SECONDARY_STARTS_ISO = '2026-09-07T08:31:55.000Z';

/** The two window lengths Codex actually reports: five hours and seven days. */
const SESSION_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCodexDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-codex-adapter-'));
  created.push(dir);
  await mkdir(join(dir, 'sessions'));
  return dir;
}

interface WindowSpec {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}

interface LineSpec {
  at?: string;
  primary?: WindowSpec | null;
  secondary?: WindowSpec | null;
  plan?: string | null;
  credits?: { has_credits: boolean; unlimited: boolean; balance: string } | null;
}

const SESSION_WINDOW: WindowSpec = {
  used_percent: 0,
  window_minutes: SESSION_MINUTES,
  resets_at: PRIMARY_RESETS_AT,
};

const WEEKLY_WINDOW: WindowSpec = {
  used_percent: 0,
  window_minutes: WEEKLY_MINUTES,
  resets_at: SECONDARY_RESETS_AT,
};

/**
 * One `token_count` line in the exact shape Codex writes, `info` included.
 *
 * The token counts are here on purpose: they are what the adapter must NOT
 * turn into a percentage, so leaving them out would make the test unable to
 * catch a regression that starts dividing by them.
 */
function tokenCountLine(spec: LineSpec = {}): string {
  return JSON.stringify({
    timestamp: spec.at ?? SNAPSHOT_AT,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 18_520,
          cached_input_tokens: 1408,
          cache_write_input_tokens: 0,
          output_tokens: 17,
          reasoning_output_tokens: 10,
          total_tokens: 18_537,
        },
        last_token_usage: {
          input_tokens: 18_520,
          cached_input_tokens: 1408,
          cache_write_input_tokens: 0,
          output_tokens: 17,
          reasoning_output_tokens: 10,
          total_tokens: 18_537,
        },
        model_context_window: 258_400,
      },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: spec.primary === undefined ? SESSION_WINDOW : spec.primary,
        secondary: spec.secondary === undefined ? WEEKLY_WINDOW : spec.secondary,
        credits:
          spec.credits === undefined
            ? { has_credits: false, unlimited: false, balance: '0' }
            : spec.credits,
        individual_limit: null,
        spend_control_reached: null,
        plan_type: spec.plan === undefined ? 'plus' : spec.plan,
        rate_limit_reached_type: null,
      },
    },
  });
}

/**
 * A line carrying what a rollout is actually full of: the user's prompt text.
 *
 * Every privacy assertion in this file leans on this string never escaping the
 * parser, so it is deliberately distinctive.
 */
const SECRET_PROMPT = 'ROLLOUT-PRIVATE-PROMPT-do-not-echo';

function promptLine(): string {
  return JSON.stringify({
    timestamp: SNAPSHOT_AT,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: SECRET_PROMPT }],
    },
  });
}

interface RolloutSpec {
  /** `['2026', '09', '07']` - the YYYY/MM/DD nesting Codex writes. */
  day?: readonly [string, string, string];
  name: string;
  mtime?: Date;
  lines?: readonly string[];
  /** `sessions` unless the test is exercising the archive. */
  root?: string;
}

const DEFAULT_DAY = ['2026', '09', '07'] as const;

async function writeRollout(codexDir: string, spec: RolloutSpec): Promise<string> {
  const dir = join(codexDir, spec.root ?? 'sessions', ...(spec.day ?? DEFAULT_DAY));
  await mkdir(dir, { recursive: true });
  const file = join(dir, spec.name);
  const lines = spec.lines ?? [tokenCountLine()];
  await writeFile(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
  if (spec.mtime !== undefined) await utimes(file, spec.mtime, spec.mtime);
  return file;
}

interface Harness {
  ctx: AdapterContext;
  debug: string[];
}

function harness(codexDir: string, options: Record<string, unknown> = {}): Harness {
  const debug: string[] = [];
  return {
    debug,
    ctx: {
      now: () => NOW,
      homeDir: '/home/test',
      // `dir` is always set explicitly so an ambient $CODEX_HOME on the machine
      // running these tests cannot reach the adapter.
      options: { enabled: true, dir: codexDir, ...options },
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

describe('codexAdapter', () => {
  it('identifies itself with the id used by the config file and the directory', () => {
    expect(codexAdapter.id).toBe('codex');
    expect(PROVIDER_ID).toBe('codex');
    expect(codexAdapter.displayName).toBe('Codex');
    expect(PERCENT_LIMIT).toBe(100);
    expect(MAX_ROLLOUT_FILES).toBe(25);
  });

  describe('detect', () => {
    it('is false when the Codex home does not exist', async () => {
      const { ctx } = harness(join(tmpdir(), 'quota-monitor-no-codex-7b21'));
      expect(await codexAdapter.detect(ctx)).toBe(false);
    });

    it('is false when sessions/ exists but is empty', async () => {
      const { ctx } = harness(await makeCodexDir());
      expect(await codexAdapter.detect(ctx)).toBe(false);
    });

    it('is false when the day directory holds no .jsonl', async () => {
      const dir = await makeCodexDir();
      await mkdir(join(dir, 'sessions', ...DEFAULT_DAY), { recursive: true });
      await writeFile(join(dir, 'sessions', ...DEFAULT_DAY, 'notes.md'), 'hi', 'utf8');
      const { ctx } = harness(dir);
      expect(await codexAdapter.detect(ctx)).toBe(false);
    });

    it('is true when at least one rollout exists, even an empty one', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, { name: 'rollout-a.jsonl', lines: [] });
      const { ctx } = harness(dir);
      expect(await codexAdapter.detect(ctx)).toBe(true);
    });

    it('is false when every rollout is zstd-compressed, and says so', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, { name: 'rollout-old.jsonl.zst', lines: ['not really zstd'] });
      const { ctx, debug } = harness(dir);
      expect(await codexAdapter.detect(ctx)).toBe(false);
      expect(debug.join('\n')).toContain('1 zstd-compressed');
    });

    /**
     * REGRESSION. `detect` gates `read`, so an option that widens what `read`
     * looks at has to widen `detect` too. `includeArchived` was honoured only
     * in `read`, so a user whose live `sessions/` had been emptied got a silent
     * "Codex is not here" and no hint that the option they set was ignored.
     */
    it('honours includeArchived, so the option cannot be gated away by detect', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, { name: 'rollout-archived.jsonl', root: 'archived_sessions' });

      await expect(codexAdapter.detect(harness(dir).ctx)).resolves.toBe(false);

      const opted = harness(dir, { includeArchived: true });
      await expect(codexAdapter.detect(opted.ctx)).resolves.toBe(true);
      // And detect's answer matches what read() would actually have produced.
      expect(await codexAdapter.read(opted.ctx)).toHaveLength(2);
    });

    it('never throws, whatever the directory turns out to be', async () => {
      const dir = await makeCodexDir();
      await rm(join(dir, 'sessions'), { recursive: true });
      await writeFile(join(dir, 'sessions'), 'a file where a directory should be', 'utf8');
      const { ctx } = harness(dir);
      await expect(codexAdapter.detect(ctx)).resolves.toBe(false);
    });
  });

  describe('read', () => {
    it('returns one reported percentage per window, against a limit of 100', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: [
          tokenCountLine({
            primary: { ...SESSION_WINDOW, used_percent: 42.7 },
            secondary: { ...WEEKLY_WINDOW, used_percent: 8.5 },
          }),
        ],
      });

      const { ctx } = harness(dir);
      const readings = await codexAdapter.read(ctx);
      expect(readings).toHaveLength(2);

      const session = byWindow(readings, 'session');
      expect(session).toMatchObject({
        provider: 'codex',
        label: 'Plus',
        window: 'session',
        used: 42.7,
        limit: 100,
        unit: 'percent',
        windowStart: PRIMARY_STARTS_ISO,
        resetsAt: PRIMARY_RESETS_AT_ISO,
        confidence: 'reported',
      });

      const weekly = byWindow(readings, 'weekly');
      expect(weekly).toMatchObject({
        window: 'weekly',
        used: 8.5,
        limit: 100,
        unit: 'percent',
        windowStart: SECONDARY_STARTS_ISO,
        resetsAt: SECONDARY_RESETS_AT_ISO,
        confidence: 'reported',
      });
    });

    it("is 'reported', never 'derived' - the whole reason this adapter exists", async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, { name: 'rollout-a.jsonl' });
      const { ctx } = harness(dir);
      for (const reading of await codexAdapter.read(ctx)) {
        expect(reading.confidence).toBe('reported');
        expect(reading.unit).toBe('percent');
        expect(reading.limit).toBe(100);
      }
    });

    it('never turns the local token counts into a percentage', async () => {
      // The line carries 18,537 total tokens and a 258,400 context window.
      // 18537/258400 is 7.17%, which is the number a well-meaning regression
      // would print. OpenAI said 0, so 0 is what we print.
      const dir = await makeCodexDir();
      await writeRollout(dir, { name: 'rollout-a.jsonl' });
      const { ctx } = harness(dir);
      const readings = await codexAdapter.read(ctx);
      for (const reading of readings) expect(reading.used).toBe(0);
      expect(JSON.stringify(readings)).not.toContain('18537');
      expect(JSON.stringify(readings)).not.toContain('258400');
    });

    it('keys the window off window_minutes, not off primary/secondary order', async () => {
      // The weekly figures arrive under "primary" and the session ones under
      // "secondary". Getting this backwards would report an almost-exhausted
      // week as a comfortable five-hour window.
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: [
          tokenCountLine({
            primary: { ...WEEKLY_WINDOW, used_percent: 91 },
            secondary: { ...SESSION_WINDOW, used_percent: 3 },
          }),
        ],
      });

      const { ctx } = harness(dir);
      const readings = await codexAdapter.read(ctx);
      expect(byWindow(readings, 'weekly').used).toBe(91);
      expect(byWindow(readings, 'session').used).toBe(3);
    });

    it('computes windowStart as resetsAt minus the window length', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: [tokenCountLine({ secondary: null })],
      });

      const { ctx } = harness(dir);
      const [reading] = await codexAdapter.read(ctx);
      const start = new Date(reading?.windowStart ?? '');
      const end = new Date(reading?.resetsAt ?? '');
      expect((end.getTime() - start.getTime()) / 60_000).toBe(SESSION_MINUTES);
    });

    it('returns one reading when only one window is reported', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: [tokenCountLine({ secondary: null })],
      });

      const { ctx } = harness(dir);
      const readings = await codexAdapter.read(ctx);
      expect(readings.map((r) => r.window)).toEqual(['session']);
    });

    it('takes the newest snapshot inside a rollout, not the first', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: [
          tokenCountLine({
            at: '2026-09-07T08:00:00.000Z',
            primary: { ...SESSION_WINDOW, used_percent: 10 },
          }),
          tokenCountLine({
            at: SNAPSHOT_AT,
            primary: { ...SESSION_WINDOW, used_percent: 61 },
          }),
        ],
      });

      const { ctx } = harness(dir);
      expect(byWindow(await codexAdapter.read(ctx), 'session').used).toBe(61);
    });

    it('takes the newest rollout and stops there instead of reading them all', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-old.jsonl',
        mtime: new Date('2026-09-05T10:00:00.000Z'),
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 99 } })],
      });
      await writeRollout(dir, {
        name: 'rollout-new.jsonl',
        mtime: new Date('2026-09-07T10:00:00.000Z'),
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 12 } })],
      });

      const { ctx } = harness(dir);
      const session = byWindow(await codexAdapter.read(ctx), 'session');
      expect(session.used).toBe(12);
      // The note admits how many files had to be opened; one means the older
      // rollout was never touched.
      expect(session.note).not.toContain('opened before');
    });

    it('falls through to an older rollout when the newest carries no snapshot', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-old.jsonl',
        mtime: new Date('2026-09-05T10:00:00.000Z'),
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 77 } })],
      });
      await writeRollout(dir, {
        name: 'rollout-new.jsonl',
        mtime: new Date('2026-09-07T10:00:00.000Z'),
        lines: [promptLine(), promptLine()],
      });

      const { ctx } = harness(dir);
      const session = byWindow(await codexAdapter.read(ctx), 'session');
      expect(session.used).toBe(77);
      // Two files opened in total. The note says two, and says what was done
      // with them; the old wording claimed two had come up empty when only one
      // had.
      expect(session.note).toContain('2 rollouts opened; this is the newest snapshot in them');
    });

    /**
     * REGRESSION. `listRollouts` orders by FILE MTIME, which is not the instant
     * of a file's newest `token_count`: a session that logged a prompt after
     * its last model turn has the newer mtime while holding the older snapshot.
     * The scan used to stop at the first file that answered, so with two Codex
     * windows open it would print a percentage that was not the newest one on
     * disk. It must keep looking while a candidate's mtime says it could still
     * hold something newer.
     */
    it('prefers the newest snapshot over the newest file when they disagree', async () => {
      const dir = await makeCodexDir();

      // Newest mtime, oldest snapshot: this session went quiet at 08:00 and
      // only recorded a prompt at 10:00.
      await writeRollout(dir, {
        name: 'rollout-idle.jsonl',
        mtime: new Date('2026-09-07T10:00:00.000Z'),
        lines: [
          tokenCountLine({
            at: '2026-09-07T08:00:00.000Z',
            primary: { ...SESSION_WINDOW, used_percent: 99 },
          }),
          promptLine(),
        ],
      });

      // Older mtime, newer snapshot: the window that was actually burning quota.
      await writeRollout(dir, {
        name: 'rollout-busy.jsonl',
        mtime: new Date('2026-09-07T09:30:00.000Z'),
        lines: [
          tokenCountLine({
            at: '2026-09-07T09:29:00.000Z',
            primary: { ...SESSION_WINDOW, used_percent: 12 },
          }),
        ],
      });

      const { ctx } = harness(dir);
      const session = byWindow(await codexAdapter.read(ctx), 'session');
      expect(session.used).toBe(12);
      expect(session.note).toContain('taken 2026-09-07T09:29:00.000Z');
    });

    it('still opens exactly one rollout when the newest file holds the newest snapshot', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-old.jsonl',
        mtime: new Date('2026-09-05T10:00:00.000Z'),
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 99 } })],
      });
      await writeRollout(dir, {
        name: 'rollout-new.jsonl',
        // Later than the snapshot inside it, as every real rollout's mtime is.
        mtime: new Date('2026-09-07T10:00:00.000Z'),
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 12 } })],
      });

      const { ctx } = harness(dir);
      const session = byWindow(await codexAdapter.read(ctx), 'session');
      expect(session.used).toBe(12);
      // The older file's mtime is behind the snapshot we hold, so it cannot
      // beat it and is never opened.
      expect(session.note).not.toContain('rollouts opened');
    });

    it('skips a rate_limits record with no usable window and reports its line number', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-new.jsonl',
        mtime: new Date('2026-09-07T10:00:00.000Z'),
        lines: [promptLine(), tokenCountLine({ primary: null, secondary: null })],
      });
      await writeRollout(dir, {
        name: 'rollout-old.jsonl',
        mtime: new Date('2026-09-05T10:00:00.000Z'),
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 5 } })],
      });

      const { ctx, debug } = harness(dir);
      expect(byWindow(await codexAdapter.read(ctx), 'session').used).toBe(5);
      expect(debug.join('\n')).toContain('carried no usable window (first at line 2)');
    });

    it('returns nothing rather than a zero when no snapshot exists anywhere', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, { name: 'rollout-a.jsonl', lines: [promptLine()] });
      const { ctx, debug } = harness(dir);
      expect(await codexAdapter.read(ctx)).toEqual([]);
      expect(debug.join('\n')).toContain('reporting nothing rather than zero');
    });

    it('returns nothing when there is no sessions directory at all', async () => {
      const { ctx } = harness(join(tmpdir(), 'quota-monitor-no-codex-7b21'));
      await expect(codexAdapter.read(ctx)).resolves.toEqual([]);
    });

    it('ignores a rollout of pure junk without throwing', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: ['{not json', '', '   ', '[]', 'null', '{"type":"event_msg"}'],
      });
      const { ctx } = harness(dir);
      await expect(codexAdapter.read(ctx)).resolves.toEqual([]);
    });

    it('clamps an out-of-range percentage and says that it did', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: [
          tokenCountLine({
            primary: { ...SESSION_WINDOW, used_percent: 150 },
            secondary: null,
          }),
        ],
      });

      const { ctx } = harness(dir);
      const session = byWindow(await codexAdapter.read(ctx), 'session');
      expect(session.used).toBe(100);
      expect(session.note).toContain('outside 0-100');
    });
  });

  describe('the plan label', () => {
    async function labelFor(plan: string | null): Promise<string> {
      const dir = await makeCodexDir();
      await writeRollout(dir, { name: 'rollout-a.jsonl', lines: [tokenCountLine({ plan })] });
      const { ctx } = harness(dir);
      const [reading] = await codexAdapter.read(ctx);
      return reading?.label ?? '';
    }

    it('reads the tier out of the rollout, so auth.json is never needed', async () => {
      expect(await labelFor('plus')).toBe('Plus');
      expect(await labelFor('pro_lite')).toBe('Pro Lite');
    });

    it('never fails on a tier we have not seen', async () => {
      expect(await labelFor('quantum_ultra_2030')).toBe('Unknown plan');
      expect(await labelFor(null)).toBe('Unknown plan');
    });
  });

  describe('the note', () => {
    async function noteFor(
      lines: readonly string[],
      extra?: readonly RolloutSpec[],
    ): Promise<string> {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        mtime: new Date('2026-09-07T10:00:00.000Z'),
        lines,
      });
      for (const spec of extra ?? []) await writeRollout(dir, spec);
      const { ctx } = harness(dir);
      const [reading] = await codexAdapter.read(ctx);
      return reading?.note ?? '';
    }

    it("says the figure is OpenAI's own and not one we computed", async () => {
      const note = await noteFor([tokenCountLine({ secondary: null })]);
      expect(note).toContain("OpenAI's own figure");
      expect(note).toContain('rate_limits.used_percent');
      expect(note).toContain('never recomputes it from local token counts');
    });

    it('states how stale the snapshot is, in words, and that it is not live', async () => {
      const note = await noteFor([tokenCountLine({ secondary: null })]);
      expect(note).toContain('NOT LIVE');
      expect(note).toContain('this snapshot is 2h 14m old');
      expect(note).toContain(`(taken ${SNAPSHOT_AT})`);
      expect(note).toContain('will not change until you next run Codex');
    });

    it('scales the staleness wording with the age', async () => {
      const minutes = await noteFor([
        tokenCountLine({ at: '2026-09-07T10:01:02.043Z', secondary: null }),
      ]);
      expect(minutes).toContain('this snapshot is 45m old');

      const days = await noteFor([
        tokenCountLine({ at: '2026-09-04T04:46:02.043Z', secondary: null }),
      ]);
      expect(days).toContain('this snapshot is 3d 06h old');

      const fresh = await noteFor([
        tokenCountLine({ at: '2026-09-07T10:46:00.043Z', secondary: null }),
      ]);
      expect(fresh).toContain('this snapshot is less than a minute old');
    });

    it('never prints a negative age when the snapshot is stamped in the future', async () => {
      const note = await noteFor([
        tokenCountLine({ at: '2026-09-08T10:46:02.043Z', secondary: null }),
      ]);
      expect(note).toContain('less than a minute old');
      expect(note).not.toContain('-1d');
    });

    /**
     * REGRESSION. Staleness has two halves and the note only carried one. A
     * five-hour window read out of a rollout written yesterday has ALREADY
     * ROLLED OVER, so its percentage describes a window the user is no longer
     * in - a stale 85% otherwise reads as 85% of the window they are in right
     * now. Saying only "this snapshot is 1d old" leaves the reader to do that
     * arithmetic themselves.
     */
    it('says when the window a figure describes has already reset', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, { name: 'rollout-stale.jsonl', lines: [tokenCountLine()] });

      const base = harness(dir).ctx;
      // Exactly one day after the 5-hour window's reset; the weekly window has
      // days left on it.
      const later: AdapterContext = { ...base, now: () => new Date('2026-09-08T13:31:55.000Z') };
      const readings = await codexAdapter.read(later);

      const session = byWindow(readings, 'session');
      expect(session.note).toContain('ALREADY RESET');
      expect(session.note).toContain('the 5h window this figure describes ended 1d 00h ago');

      // The weekly window is still open, so it must carry no such warning.
      expect(byWindow(readings, 'weekly').note).not.toContain('ALREADY RESET');
    });

    it('says nothing about a reset that has not happened yet', async () => {
      const note = await noteFor([tokenCountLine()]);
      expect(note).not.toContain('ALREADY RESET');
    });

    it('names the window length in the units a person thinks in', async () => {
      expect(await noteFor([tokenCountLine({ secondary: null })])).toContain('the 5h window');
      expect(await noteFor([tokenCountLine({ primary: null })])).toContain('the 7d window');
    });

    it('admits how many rollouts were skipped for being zstd-compressed', async () => {
      const note = await noteFor(
        [tokenCountLine({ secondary: null })],
        [
          { name: 'rollout-old-1.jsonl.zst', lines: ['x'] },
          { name: 'rollout-old-2.jsonl.zst', lines: ['x'] },
        ],
      );
      expect(note).toContain('2 older rollouts are zstd-compressed');
      expect(note).toContain('adds no zstd dependency');
    });

    it('says nothing about compression when there is none to report', async () => {
      const note = await noteFor([tokenCountLine({ secondary: null })]);
      expect(note).not.toContain('zstd');
    });

    it('reports a credit balance only when Codex says there are credits', async () => {
      const none = await noteFor([tokenCountLine({ secondary: null })]);
      expect(none).not.toContain('credit');

      const some = await noteFor([
        tokenCountLine({
          secondary: null,
          credits: { has_credits: true, unlimited: false, balance: '1250' },
        }),
      ]);
      expect(some).toContain('credit balance of 1250');

      const unlimited = await noteFor([
        tokenCountLine({
          secondary: null,
          credits: { has_credits: true, unlimited: true, balance: '0' },
        }),
      ]);
      expect(unlimited).toContain('credits as unlimited');
    });

    it('summarises a balance that is not plainly a number rather than echoing it', async () => {
      const note = await noteFor([
        tokenCountLine({
          secondary: null,
          credits: { has_credits: true, unlimited: false, balance: 'drop table users;' },
        }),
      ]);
      expect(note).toContain('reports a credit balance');
      expect(note).not.toContain('drop table');
    });
  });

  describe('privacy', () => {
    it('puts no line content in a reading, a note or a debug string', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: [
          promptLine(),
          '{"timestamp":"2026-09-07T08:00:00.000Z","type":"event_msg","payload":{"type":"token_count","truncated' +
            SECRET_PROMPT,
          tokenCountLine(),
          promptLine(),
        ],
      });

      const { ctx, debug } = harness(dir);
      const readings = await codexAdapter.read(ctx);
      expect(readings).toHaveLength(2);

      const everything = JSON.stringify(readings) + '\n' + debug.join('\n');
      expect(everything).not.toContain(SECRET_PROMPT);
    });

    it('reports a bad record by line number and by nothing else', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-a.jsonl',
        lines: [promptLine(), tokenCountLine({ primary: null, secondary: null })],
      });

      const { ctx, debug } = harness(dir);
      await codexAdapter.read(ctx);
      const line = debug.find((m) => m.includes('no usable window')) ?? '';
      expect(line).toContain('first at line 2');
      expect(line).not.toContain(SECRET_PROMPT);
      expect(line).not.toContain('used_percent');
    });

    it('never opens auth.json, even when one is sitting in the tree', async () => {
      const dir = await makeCodexDir();
      await writeFile(join(dir, 'auth.json'), `{"token":"${SECRET_PROMPT}"}`, 'utf8');
      // And again where the walk would actually reach it.
      await mkdir(join(dir, 'sessions', ...DEFAULT_DAY), { recursive: true });
      await writeFile(
        join(dir, 'sessions', ...DEFAULT_DAY, 'auth.json'),
        `{"token":"${SECRET_PROMPT}"}`,
        'utf8',
      );
      await writeRollout(dir, { name: 'rollout-a.jsonl' });

      const { ctx, debug } = harness(dir);
      const readings = await codexAdapter.read(ctx);
      expect(readings).toHaveLength(2);
      expect(JSON.stringify(readings) + debug.join('\n')).not.toContain(SECRET_PROMPT);
    });
  });

  describe('options', () => {
    it('honours maxFiles, and ignores an unusable one with a debug line', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        name: 'rollout-old.jsonl',
        mtime: new Date('2026-09-05T10:00:00.000Z'),
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 33 } })],
      });
      await writeRollout(dir, {
        name: 'rollout-new.jsonl',
        mtime: new Date('2026-09-07T10:00:00.000Z'),
        lines: [promptLine()],
      });

      // Only the newest file is read, and it carries no snapshot.
      const capped = harness(dir, { maxFiles: 1 });
      expect(await codexAdapter.read(capped.ctx)).toEqual([]);

      // With room for both, the older one answers.
      const open = harness(dir, { maxFiles: 2 });
      expect(byWindow(await codexAdapter.read(open.ctx), 'session').used).toBe(33);

      const bad = harness(dir, { maxFiles: 0 });
      await codexAdapter.read(bad.ctx);
      expect(bad.debug.join('\n')).toContain('ignoring maxFiles 0');
    });

    it('leaves archived_sessions alone unless asked', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        root: 'archived_sessions',
        name: 'rollout-archived.jsonl',
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 64 } })],
      });

      const off = harness(dir);
      expect(await codexAdapter.read(off.ctx)).toEqual([]);

      const on = harness(dir, { includeArchived: true });
      expect(byWindow(await codexAdapter.read(on.ctx), 'session').used).toBe(64);
    });
  });

  describe('every documented option survives parseConfig', () => {
    const YAML = [
      'providers:',
      '  codex:',
      '    dir: /tmp/codex',
      '    maxFiles: 25',
      '    includeArchived: false',
      '',
    ].join('\n');

    it('keeps every key, with no warning', () => {
      // src/core/config.ts drops any key matching /token|key|secret|password/i
      // before an adapter sees it. This is the test that catches an option
      // named `...Token` the day somebody adds one.
      const { config, warnings } = parseConfig(YAML);
      expect(warnings).toEqual([]);
      expect(config.providers['codex']).toMatchObject({
        enabled: true,
        dir: '/tmp/codex',
        maxFiles: 25,
        includeArchived: false,
      });
    });

    it('reaches the adapter and actually changes what is read', async () => {
      const dir = await makeCodexDir();
      await writeRollout(dir, {
        root: 'archived_sessions',
        name: 'rollout-archived.jsonl',
        lines: [tokenCountLine({ primary: { ...SESSION_WINDOW, used_percent: 21 } })],
      });

      const { config } = parseConfig(
        ['providers:', '  codex:', '    includeArchived: true', ''].join('\n'),
      );
      const fromFile = config.providers['codex'] ?? { enabled: true };
      const { ctx } = harness(dir, { ...fromFile });
      expect(byWindow(await codexAdapter.read(ctx), 'session').used).toBe(21);
    });

    it('ships enabled in the default config', () => {
      const { config } = parseConfig('');
      expect(config.providers['codex']).toEqual({ enabled: true });
    });
  });
});
