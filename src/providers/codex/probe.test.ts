import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_LIMIT_ID,
  REQUEST_ID,
  handshake,
  parseProbe,
  parseRateLimitsResult,
  probeRateLimits,
  probeSnapshotPath,
  readProbeSnapshot,
  resultForId,
  serializeProbe,
  writeProbeSnapshot,
} from './probe.js';

const NOW = new Date('2026-09-16T08:00:00.000Z');
const RESETS_WEEK = 1_789_951_079;
const RESETS_SESSION = 1_789_562_334;

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-codex-'));
  created.push(dir);
  return dir;
}

/** Trimmed from a real `account/rateLimits/read` answer on 2026-09-16. */
const RESULT = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: RESETS_WEEK },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'pro',
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      primary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: RESETS_WEEK },
      secondary: null,
      planType: 'pro',
    },
    codex_bengalfox: {
      limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: RESETS_SESSION },
      secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: RESETS_WEEK },
      planType: 'pro',
    },
  },
};

const envelope = (result: unknown): string =>
  [
    JSON.stringify({ jsonrpc: '2.0', method: 'sessionConfigured', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: REQUEST_ID, result }),
    '',
  ].join('\n');

describe('reading the app-server answer', () => {
  it('takes every limit family, not only the default one', () => {
    const probe = parseRateLimitsResult(RESULT, NOW);
    expect(probe.limits.map((limit) => limit.limitId).sort()).toEqual(['codex', 'codex_bengalfox']);
  });

  it('sorts the two windows by their own length', () => {
    const probe = parseRateLimitsResult(RESULT, NOW);
    const model = probe.limits.find((limit) => limit.limitId === 'codex_bengalfox');

    // 300 minutes is the short window whether it arrives as primary or not.
    expect(model?.session?.usedPercent).toBe(4);
    expect(model?.session?.windowMinutes).toBe(300);
    expect(model?.weekly?.usedPercent).toBe(11);
    expect(model?.weekly?.windowMinutes).toBe(10080);
  });

  it('keeps the name a per-model bucket gives itself', () => {
    const probe = parseRateLimitsResult(RESULT, NOW);
    expect(probe.limits.find((limit) => limit.limitId !== DEFAULT_LIMIT_ID)?.limitName).toBe(
      'GPT-5.3-Codex-Spark',
    );
  });

  it('falls back to the flat shape when the map is absent', () => {
    const probe = parseRateLimitsResult({ rateLimits: RESULT.rateLimits }, NOW);
    expect(probe.limits).toHaveLength(1);
    expect(probe.limits[0]?.weekly?.usedPercent).toBe(80);
  });

  it('reads the reset as UNIX seconds and refuses milliseconds', () => {
    const seconds = parseRateLimitsResult(RESULT, NOW);
    expect(seconds.limits[0]?.weekly?.resetsAt.toISOString()).toBe(
      new Date(RESETS_WEEK * 1000).toISOString(),
    );

    // A value in milliseconds would put the reset in the year 58000.
    const millis = parseRateLimitsResult(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: RESETS_WEEK * 1000 },
        },
      },
      NOW,
    );
    expect(millis.limits).toEqual([]);
  });

  it('clamps a percentage outside 0-100 and says it clamped', () => {
    const probe = parseRateLimitsResult(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 140, windowDurationMins: 10080, resetsAt: RESETS_WEEK },
        },
      },
      NOW,
    );
    expect(probe.limits[0]?.weekly).toMatchObject({ usedPercent: 100, clamped: true });
  });

  it('answers with nothing rather than a wrong figure', () => {
    for (const result of [null, {}, { rateLimits: {} }, { rateLimits: { primary: {} } }]) {
      expect(parseRateLimitsResult(result, NOW).limits).toEqual([]);
    }
  });
});

describe('finding our answer in the stream', () => {
  it('matches on the request id, not on position', () => {
    expect(resultForId(envelope(RESULT), REQUEST_ID)).toMatchObject({ rateLimits: { limitId: 'codex' } });
  });

  it('is null for an error reply, a missing reply, or noise', () => {
    expect(resultForId(JSON.stringify({ id: REQUEST_ID, error: { code: -32601 } }), REQUEST_ID)).toBeNull();
    expect(resultForId('{"id":99,"result":{}}', REQUEST_ID)).toBeNull();
    expect(resultForId('not json\n\n', REQUEST_ID)).toBeNull();
  });

  it('speaks the three lines of protocol in order', () => {
    const lines = handshake().trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.method)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);
    expect(lines[2].id).toBe(REQUEST_ID);
  });
});

describe('probing', () => {
  const deps = (run: () => Promise<{ text: string | null; reason: string | null }>) => ({
    env: {},
    platform: 'linux' as NodeJS.Platform,
    homeDir: '/home/x',
    now: NOW,
    candidates: ['/bin/codex'],
    run,
  });

  it('returns the limits the CLI answered with', async () => {
    const { result, reason } = await probeRateLimits(
      deps(async () => ({ text: envelope(RESULT), reason: null })),
    );
    expect(reason).toBeNull();
    expect(result?.limits).toHaveLength(2);
    expect(result?.at).toEqual(NOW);
  });

  it('says why it could not ask, rather than failing the read', async () => {
    const missing = await probeRateLimits({
      env: { PATH: '/nowhere' },
      platform: 'linux',
      homeDir: '/home/nobody',
      now: NOW,
      run: async () => ({ text: null, reason: 'never called' }),
    });
    expect(missing.result).toBeNull();
    expect(missing.reason).toBe('no codex CLI on PATH');

    const silent = await probeRateLimits(deps(async () => ({ text: null, reason: 'exited with code 1' })));
    expect(silent.result).toBeNull();
    expect(silent.reason).toBe('exited with code 1');

    const empty = await probeRateLimits(deps(async () => ({ text: envelope({}), reason: null })));
    expect(empty.result).toBeNull();
    expect(empty.reason).toBe('no usable window in the answer');
  });
});

describe('keeping the answer', () => {
  it('round trips through the file', async () => {
    const home = await makeHome();
    const file = probeSnapshotPath(home);
    const probe = parseRateLimitsResult(RESULT, NOW);

    expect(await writeProbeSnapshot(file, probe)).toBe(true);
    const back = await readProbeSnapshot(file);

    expect(back?.at).toEqual(NOW);
    expect(back?.limits).toHaveLength(2);
    expect(back?.limits.find((limit) => limit.limitId === 'codex_bengalfox')).toMatchObject({
      limitName: 'GPT-5.3-Codex-Spark',
      planType: 'pro',
    });
    expect(back?.limits[0]?.weekly?.resetsAt).toBeInstanceOf(Date);
  });

  it('treats a file it cannot understand as no file', async () => {
    const home = await makeHome();
    const file = probeSnapshotPath(home);
    await writeProbeSnapshot(file, parseRateLimitsResult(RESULT, NOW));

    for (const text of [
      '{ not json',
      JSON.stringify({ kind: 'something-else', version: 1, at: NOW.toISOString(), limits: [] }),
      JSON.stringify({ kind: 'codex-rate-limits', version: 99, at: NOW.toISOString(), limits: [] }),
      JSON.stringify({ kind: 'codex-rate-limits', version: 1, at: 'never', limits: [] }),
      // No window in any limit is nothing worth keeping.
      JSON.stringify({
        kind: 'codex-rate-limits',
        version: 1,
        at: NOW.toISOString(),
        limits: [{ limitId: 'codex', session: null, weekly: null }],
      }),
    ]) {
      await writeFile(file, text, 'utf8');
      expect(await readProbeSnapshot(file)).toBeNull();
    }
  });

  it('is null for a file that is not there', async () => {
    expect(await readProbeSnapshot(probeSnapshotPath(await makeHome()))).toBeNull();
  });

  it('keeps a clamped window marked as clamped', () => {
    const probe = parseRateLimitsResult(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 140, windowDurationMins: 10080, resetsAt: RESETS_WEEK },
        },
      },
      NOW,
    );
    expect(parseProbe(serializeProbe(probe))?.limits[0]?.weekly?.clamped).toBe(true);
  });
});
