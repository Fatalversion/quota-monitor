import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  LIMIT_WINDOW_MS,
  MAX_HISTORY,
  MAX_PAYLOAD_BYTES,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  formatPercent,
  formatStatusLine,
  formatTimeLeft,
  mergeSnapshot,
  parseSnapshot,
  parseStatusLinePayload,
  readRateLimitSnapshot,
  recordStatusLine,
  serializeSnapshot,
  statusLineSnapshotPath,
  writeRateLimitSnapshot,
} from './statusline.js';

import type { ObservedLimits, RateLimitSnapshot } from './statusline.js';

/** Fixed instant. Nothing in this file may consult the wall clock. */
const NOW = new Date('2026-09-15T12:00:00.000Z');
const LATER = new Date('2026-09-15T12:20:00.000Z');

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Epoch seconds, the unit Claude Code sends. */
function epochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** A status line payload in the documented shape, with the noise it really carries. */
function payload(rateLimits: unknown): string {
  return JSON.stringify({
    session_id: 'abc',
    cwd: '/home/someone/secret-project',
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    workspace: { repo: { host: 'github.com', owner: 'someone', name: 'secret-project' } },
    rate_limits: rateLimits,
  });
}

function window(usedPercentage: number, resetsInMs: number, now: Date = NOW) {
  return { used_percentage: usedPercentage, resets_at: epochSeconds(now.getTime() + resetsInMs) };
}

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-statusline-'));
  created.push(dir);
  return dir;
}

describe('parseStatusLinePayload', () => {
  it('reads both windows, converting resets_at from epoch seconds', () => {
    const limits = parseStatusLinePayload(
      payload({ five_hour: window(23.5, 3 * HOUR), seven_day: window(41.2, 5 * DAY) }),
      NOW,
    );
    expect(limits.five_hour?.usedPercentage).toBe(23.5);
    expect(limits.five_hour?.resetsAt.toISOString()).toBe('2026-09-15T15:00:00.000Z');
    expect(limits.seven_day?.usedPercentage).toBe(41.2);
    expect(limits.seven_day?.resetsAt.toISOString()).toBe('2026-09-20T12:00:00.000Z');
    expect(limits.five_hour?.clamped).toBe(false);
  });

  it('keeps nothing but the numbers from a payload full of personal context', () => {
    const limits = parseStatusLinePayload(payload({ five_hour: window(18, HOUR) }), NOW);
    expect(Object.keys(limits)).toEqual(['five_hour']);
    expect(JSON.stringify(limits)).not.toContain('secret-project');
  });

  it('is empty when rate_limits is absent, as it is for API-key users and before the first response', () => {
    expect(parseStatusLinePayload(payload(undefined), NOW)).toEqual({});
    expect(parseStatusLinePayload(JSON.stringify({ model: {} }), NOW)).toEqual({});
  });

  it('accepts one window when the other is missing', () => {
    const limits = parseStatusLinePayload(payload({ seven_day: window(90, DAY) }), NOW);
    expect(limits.five_hour).toBeUndefined();
    expect(limits.seven_day?.usedPercentage).toBe(90);
  });

  it('ignores the gateway spend_limit window, which has no fixed length to model', () => {
    const limits = parseStatusLinePayload(payload({ spend_limit: window(62.8, DAY) }), NOW);
    expect(limits).toEqual({});
  });

  it('never throws on text that is not a payload', () => {
    for (const text of ['', 'not json', '[]', 'null', '42', '{"rate_limits": []}']) {
      expect(parseStatusLinePayload(text, NOW)).toEqual({});
    }
  });

  it('refuses a payload larger than the cap without parsing it', () => {
    const huge = payload({ five_hour: window(10, HOUR) }) + ' '.repeat(MAX_PAYLOAD_BYTES);
    expect(parseStatusLinePayload(huge, NOW)).toEqual({});
  });

  it('skips a window whose fields are the wrong type', () => {
    const limits = parseStatusLinePayload(
      payload({
        five_hour: { used_percentage: '18', resets_at: epochSeconds(NOW.getTime() + HOUR) },
        seven_day: { used_percentage: 18, resets_at: 'tomorrow' },
      }),
      NOW,
    );
    expect(limits).toEqual({});
  });

  it('clamps a percentage outside 0-100 and says so', () => {
    const limits = parseStatusLinePayload(
      payload({ five_hour: window(104, HOUR), seven_day: window(-3, DAY) }),
      NOW,
    );
    expect(limits.five_hour).toMatchObject({ usedPercentage: 100, clamped: true });
    expect(limits.seven_day).toMatchObject({ usedPercentage: 0, clamped: true });
  });

  it('refuses a reset time in milliseconds rather than rendering a countdown to the year 58000', () => {
    const limits = parseStatusLinePayload(
      payload({ five_hour: { used_percentage: 18, resets_at: NOW.getTime() + HOUR } }),
      NOW,
    );
    expect(limits).toEqual({});
  });

  it('refuses a reset further out than the window is long', () => {
    const limits = parseStatusLinePayload(payload({ five_hour: window(18, 2 * DAY) }), NOW);
    expect(limits).toEqual({});
  });

  it('refuses a window that closed more than a window ago, and keeps one that closed recently', () => {
    const limits = parseStatusLinePayload(
      payload({ five_hour: window(18, -6 * HOUR), seven_day: window(50, -HOUR) }),
      NOW,
    );
    expect(limits.five_hour).toBeUndefined();
    expect(limits.seven_day?.usedPercentage).toBe(50);
  });
});

describe('mergeSnapshot', () => {
  const observed = (limits: string): ObservedLimits => parseStatusLinePayload(limits, NOW);

  it('writes nothing for a payload with no windows onto an empty disk', () => {
    const { snapshot, changed } = mergeSnapshot(null, {}, NOW);
    expect(changed).toBe(false);
    expect(snapshot.windows).toEqual({});
  });

  it('takes the first figure it sees and stamps it', () => {
    const { snapshot, changed } = mergeSnapshot(null, observed(payload({ five_hour: window(18, HOUR) })), NOW);
    expect(changed).toBe(true);
    expect(snapshot.windows.five_hour?.usedPercentage).toBe(18);
    expect(snapshot.windows.five_hour?.observedAt).toEqual(NOW);
    expect(snapshot.writtenAt).toEqual(NOW);
  });

  it('keeps the higher figure within one window, because usage only accumulates', () => {
    const first = mergeSnapshot(null, observed(payload({ five_hour: window(30, 3 * HOUR) })), NOW).snapshot;
    const raised = mergeSnapshot(first, observed(payload({ five_hour: window(31, 3 * HOUR) })), LATER);
    expect(raised.changed).toBe(true);
    expect(raised.snapshot.windows.five_hour?.usedPercentage).toBe(31);
    expect(raised.snapshot.windows.five_hour?.observedAt).toEqual(LATER);
  });

  it('ignores an idle session repeating an older, lower figure for the same window', () => {
    const live = mergeSnapshot(null, observed(payload({ five_hour: window(45, 3 * HOUR) })), NOW).snapshot;
    const stale = mergeSnapshot(live, observed(payload({ five_hour: window(12, 3 * HOUR) })), LATER);
    expect(stale.changed).toBe(false);
    expect(stale.snapshot.windows.five_hour?.usedPercentage).toBe(45);
    expect(stale.snapshot.writtenAt).toEqual(NOW);
  });

  it('does not make a repeated figure look fresh', () => {
    const first = mergeSnapshot(null, observed(payload({ five_hour: window(45, 3 * HOUR) })), NOW).snapshot;
    const repeat = mergeSnapshot(first, observed(payload({ five_hour: window(45, 3 * HOUR) })), LATER);
    expect(repeat.changed).toBe(false);
    expect(repeat.snapshot.windows.five_hour?.observedAt).toEqual(NOW);
  });

  it('treats resets a few seconds apart as the same window', () => {
    const first = mergeSnapshot(null, observed(payload({ five_hour: window(45, 3 * HOUR) })), NOW).snapshot;
    const jittered = mergeSnapshot(
      first,
      observed(payload({ five_hour: window(20, 3 * HOUR + 4_000) })),
      LATER,
    );
    expect(jittered.changed).toBe(false);
    expect(jittered.snapshot.windows.five_hour?.usedPercentage).toBe(45);
  });

  it('replaces a window with a newer one even when the new figure is lower', () => {
    const old = mergeSnapshot(null, observed(payload({ five_hour: window(97, 10 * 60_000) })), NOW).snapshot;
    const fresh = mergeSnapshot(old, observed(payload({ five_hour: window(2, 5 * HOUR) })), LATER);
    expect(fresh.changed).toBe(true);
    expect(fresh.snapshot.windows.five_hour?.usedPercentage).toBe(2);
  });

  it('never lets an older window replace a newer one', () => {
    const newer = mergeSnapshot(null, observed(payload({ five_hour: window(2, 5 * HOUR) })), NOW).snapshot;
    const older = mergeSnapshot(newer, observed(payload({ five_hour: window(97, 10 * 60_000) })), LATER);
    expect(older.changed).toBe(false);
    expect(older.snapshot.windows.five_hour?.usedPercentage).toBe(2);
  });

  it('keeps a window the new payload did not mention', () => {
    const both = mergeSnapshot(
      null,
      observed(payload({ five_hour: window(18, HOUR), seven_day: window(39, DAY) })),
      NOW,
    ).snapshot;
    const onlyFive = mergeSnapshot(both, observed(payload({ five_hour: window(19, HOUR) })), LATER);
    expect(onlyFive.snapshot.windows.seven_day?.usedPercentage).toBe(39);
    expect(onlyFive.snapshot.windows.seven_day?.observedAt).toEqual(NOW);
  });

  it('reaches the same figures whichever order two sessions write in', () => {
    const live = observed(payload({ five_hour: window(60, 2 * HOUR), seven_day: window(40, DAY) }));
    const idle = observed(payload({ five_hour: window(20, 2 * HOUR), seven_day: window(70, 3 * DAY) }));

    const ab = mergeSnapshot(mergeSnapshot(null, live, NOW).snapshot, idle, NOW).snapshot;
    const ba = mergeSnapshot(mergeSnapshot(null, idle, NOW).snapshot, live, NOW).snapshot;

    const figures = (s: RateLimitSnapshot) => ({
      five: [s.windows.five_hour?.usedPercentage, s.windows.five_hour?.resetsAt.getTime()],
      seven: [s.windows.seven_day?.usedPercentage, s.windows.seven_day?.resetsAt.getTime()],
    });
    expect(figures(ab)).toEqual(figures(ba));
    expect(ab.windows.five_hour?.usedPercentage).toBe(60);
    expect(ab.windows.seven_day?.usedPercentage).toBe(70);
  });
});

describe('snapshot serialisation', () => {
  const snapshot: RateLimitSnapshot = {
    writtenAt: NOW,
    windows: {
      five_hour: {
        usedPercentage: 18,
        resetsAt: new Date('2026-09-15T15:00:00.000Z'),
        observedAt: NOW,
        clamped: false,
        history: [],
      },
      seven_day: {
        usedPercentage: 100,
        resetsAt: new Date('2026-09-20T12:00:00.000Z'),
        observedAt: new Date('2026-09-15T11:00:00.000Z'),
        clamped: true,
        history: [],
      },
    },
  };

  it('round-trips', () => {
    expect(parseSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot);
  });

  it('labels the file so nothing else is mistaken for it', () => {
    const parsed: unknown = JSON.parse(serializeSnapshot(snapshot));
    expect(parsed).toMatchObject({ tool: 'quota-monitor', kind: SNAPSHOT_KIND, version: SNAPSHOT_VERSION });
  });

  it('refuses another format or version rather than half-reading it', () => {
    const text = serializeSnapshot(snapshot);
    expect(parseSnapshot(text.replace(`"version": ${SNAPSHOT_VERSION}`, '"version": 99'))).toBeNull();
    expect(parseSnapshot(text.replace(SNAPSHOT_KIND, 'something-else'))).toBeNull();
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot('{}')).toBeNull();
  });

  it('drops a malformed window and keeps the good one', () => {
    const text = serializeSnapshot(snapshot).replace('"usedPercentage": 18', '"usedPercentage": 180');
    const parsed = parseSnapshot(text);
    expect(parsed?.windows.five_hour).toBeUndefined();
    expect(parsed?.windows.seven_day?.usedPercentage).toBe(100);
  });
});

describe('the snapshot file', () => {
  it('lives in quota-monitor\'s own directory, never inside ~/.claude', () => {
    const file = statusLineSnapshotPath('/home/someone');
    expect(file.replaceAll('\\', '/')).toBe('/home/someone/.config/quota-monitor/claude-code-rate-limits.json');
  });

  it('is written through a temp file and leaves none behind', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    const snapshot = mergeSnapshot(
      null,
      parseStatusLinePayload(payload({ five_hour: window(18, HOUR) }), NOW),
      NOW,
    ).snapshot;

    await writeRateLimitSnapshot(file, snapshot);
    await writeRateLimitSnapshot(file, snapshot);

    const dir = join(home, '.config', 'quota-monitor');
    expect(await readdir(dir)).toEqual(['claude-code-rate-limits.json']);
    expect(await readRateLimitSnapshot(file)).toEqual(snapshot);
  });

  it('reads as null when missing, corrupt, a directory, or implausibly large', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    expect(await readRateLimitSnapshot(file)).toBeNull();

    await writeRateLimitSnapshot(file, { writtenAt: NOW, windows: {} });
    await writeFile(file, '{ truncated', 'utf8');
    expect(await readRateLimitSnapshot(file)).toBeNull();

    await writeFile(file, ' '.repeat(128 * 1024), 'utf8');
    expect(await readRateLimitSnapshot(file)).toBeNull();

    expect(await readRateLimitSnapshot(home)).toBeNull();
  });
});

describe('recordStatusLine', () => {
  it('records a payload and reports what it saw', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    const result = await recordStatusLine(
      payload({ five_hour: window(18, 3 * HOUR), seven_day: window(39, 5 * DAY) }),
      file,
      NOW,
    );
    expect(result.wrote).toBe(true);
    expect(result.observed.five_hour?.usedPercentage).toBe(18);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { windows: Record<string, unknown> };
    expect(Object.keys(onDisk.windows)).toEqual(['five_hour', 'seven_day']);
    expect(await readFile(file, 'utf8')).not.toContain('secret-project');
  });

  it('creates no file for a payload with nothing in it', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    const result = await recordStatusLine(payload(undefined), file, NOW);
    expect(result.wrote).toBe(false);
    await expect(stat(file)).rejects.toThrow();
  });

  it('does not rewrite the file when nothing changed', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    const text = payload({ five_hour: window(18, 3 * HOUR) });
    await recordStatusLine(text, file, NOW);
    const second = await recordStatusLine(text, file, LATER);
    expect(second.wrote).toBe(false);
    expect((await readRateLimitSnapshot(file))?.writtenAt).toEqual(NOW);
  });

  it('throws when the snapshot cannot be written, so the caller can fall back', async () => {
    const home = await makeHome();
    // A FILE where the config directory should be makes mkdir fail.
    await writeFile(join(home, '.config'), 'in the way', 'utf8');
    await expect(
      recordStatusLine(payload({ five_hour: window(18, HOUR) }), statusLineSnapshotPath(home), NOW),
    ).rejects.toThrow();
  });
});

describe('the status line text', () => {
  it('prints both windows with the time left in each', () => {
    const limits = parseStatusLinePayload(
      payload({
        five_hour: window(18, 2 * HOUR + 31 * 60_000),
        seven_day: window(39.25, 5 * DAY + 2 * HOUR),
      }),
      NOW,
    );
    expect(formatStatusLine(limits, NOW)).toBe('5h 18% (2h 31m) | 7d 39.3% (5d 02h)');
  });

  it('leaves out a window that has already reset', () => {
    const limits = parseStatusLinePayload(
      payload({ five_hour: window(97, -60_000), seven_day: window(39, DAY) }),
      NOW,
    );
    expect(formatStatusLine(limits, NOW)).toBe('7d 39% (1d 00h)');
  });

  it('is empty when there is nothing to show', () => {
    expect(formatStatusLine({}, NOW)).toBe('');
  });

  it('formats percentages and durations the way the rest of the tool does', () => {
    expect(formatPercent(18)).toBe('18%');
    expect(formatPercent(23.45)).toBe('23.5%');
    expect(formatPercent(Number.NaN)).toBe('0%');
    expect(formatTimeLeft(30_000)).toBe('<1m');
    expect(formatTimeLeft(45 * 60_000)).toBe('45m');
    expect(formatTimeLeft(LIMIT_WINDOW_MS.five_hour)).toBe('5h 00m');
    expect(formatTimeLeft(LIMIT_WINDOW_MS.seven_day)).toBe('7d 00h');
  });
});

describe('history: the figures a window used to carry', () => {
  const observed = (limits: string): ObservedLimits => parseStatusLinePayload(limits, NOW);

  it('keeps the superseded figure, which is half of a measurable rate', () => {
    const first = mergeSnapshot(null, observed(payload({ five_hour: window(30, 3 * HOUR) })), NOW)
      .snapshot;
    const raised = mergeSnapshot(first, observed(payload({ five_hour: window(38, 3 * HOUR) })), LATER)
      .snapshot;

    expect(raised.windows.five_hour?.usedPercentage).toBe(38);
    expect(raised.windows.five_hour?.history).toEqual([{ usedPercentage: 30, observedAt: NOW }]);
  });

  it('keeps nothing from a window that has already reset', () => {
    const first = mergeSnapshot(null, observed(payload({ five_hour: window(30, HOUR) })), NOW)
      .snapshot;
    // A later reset is a different window: what the old one charged says
    // nothing about the new one.
    const next = mergeSnapshot(first, observed(payload({ five_hour: window(4, 5 * HOUR) })), LATER)
      .snapshot;

    expect(next.windows.five_hour?.usedPercentage).toBe(4);
    expect(next.windows.five_hour?.history).toEqual([]);
  });

  it('does not record an idle session repeating an older figure', () => {
    const first = mergeSnapshot(null, observed(payload({ five_hour: window(45, 3 * HOUR) })), NOW)
      .snapshot;
    const stale = mergeSnapshot(first, observed(payload({ five_hour: window(12, 3 * HOUR) })), LATER)
      .snapshot;

    expect(stale.windows.five_hour?.history).toEqual([]);
  });

  it('keeps the newest MAX_HISTORY and drops the oldest', () => {
    let snapshot = mergeSnapshot(null, observed(payload({ seven_day: window(1, DAY) })), NOW)
      .snapshot;
    for (let step = 2; step <= MAX_HISTORY + 4; step += 1) {
      snapshot = mergeSnapshot(
        snapshot,
        observed(payload({ seven_day: window(step, DAY) })),
        new Date(NOW.getTime() + step * 60_000),
      ).snapshot;
    }

    const history = snapshot.windows.seven_day?.history ?? [];
    expect(history).toHaveLength(MAX_HISTORY);
    // The current figure is MAX_HISTORY + 4; the kept history ends just below
    // it and starts as late as the cap allows.
    expect(history[history.length - 1]?.usedPercentage).toBe(MAX_HISTORY + 3);
    expect(history[0]?.usedPercentage).toBe(4);
  });

  it('survives the round trip to disk', () => {
    const snapshot: RateLimitSnapshot = {
      writtenAt: NOW,
      windows: {
        seven_day: {
          usedPercentage: 50,
          resetsAt: new Date('2026-09-20T12:00:00.000Z'),
          observedAt: NOW,
          clamped: false,
          history: [
            { usedPercentage: 30, observedAt: new Date('2026-09-15T09:00:00.000Z') },
            { usedPercentage: 44, observedAt: new Date('2026-09-15T11:00:00.000Z') },
          ],
        },
      },
    };

    const back = parseSnapshot(serializeSnapshot(snapshot));
    expect(back?.windows.seven_day?.history).toEqual(snapshot.windows.seven_day?.history);
  });

  it('writes no history key at all while there is none', () => {
    const snapshot: RateLimitSnapshot = {
      writtenAt: NOW,
      windows: {
        seven_day: {
          usedPercentage: 50,
          resetsAt: new Date('2026-09-20T12:00:00.000Z'),
          observedAt: NOW,
          clamped: false,
          history: [],
        },
      },
    };

    expect(serializeSnapshot(snapshot)).not.toContain('history');
  });

  it('reads a file written before history existed as a window with none', () => {
    const text = JSON.stringify({
      tool: 'quota-monitor',
      kind: 'claude-code-rate-limits',
      version: 1,
      writtenAt: NOW.toISOString(),
      windows: {
        seven_day: {
          usedPercentage: 50,
          resetsAt: '2026-09-20T12:00:00.000Z',
          observedAt: NOW.toISOString(),
          clamped: false,
        },
      },
    });

    expect(parseSnapshot(text)?.windows.seven_day?.history).toEqual([]);
  });

  it('drops a malformed entry, and one stamped at or after the figure it belongs to', () => {
    const text = JSON.stringify({
      tool: 'quota-monitor',
      kind: 'claude-code-rate-limits',
      version: 1,
      writtenAt: NOW.toISOString(),
      windows: {
        seven_day: {
          usedPercentage: 50,
          resetsAt: '2026-09-20T12:00:00.000Z',
          observedAt: NOW.toISOString(),
          clamped: false,
          history: [
            { usedPercentage: 'thirty', observedAt: '2026-09-15T09:00:00.000Z' },
            { usedPercentage: 30, observedAt: 'never' },
            // Later than the current figure: it cannot be something this
            // window used to say.
            { usedPercentage: 30, observedAt: '2026-09-15T13:00:00.000Z' },
            { usedPercentage: 44, observedAt: '2026-09-15T11:00:00.000Z' },
            { usedPercentage: 30, observedAt: '2026-09-15T09:00:00.000Z' },
          ],
        },
      },
    });

    // Sorted on the way in, because several sessions write this file and only
    // the instants are authoritative.
    expect(parseSnapshot(text)?.windows.seven_day?.history).toEqual([
      { usedPercentage: 30, observedAt: new Date('2026-09-15T09:00:00.000Z') },
      { usedPercentage: 44, observedAt: new Date('2026-09-15T11:00:00.000Z') },
    ]);
  });
});
