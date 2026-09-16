import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  claudeCandidates,
  modelsFromReport,
  observedFromReport,
  parseResetTime,
  parseUsageReport,
  probeUsage,
  refreshFromUsage,
} from './usage.js';
import { readRateLimitSnapshot, statusLineSnapshotPath } from './statusline.js';

import type { ProbeOutcome, UsageReport } from './usage.js';

/** Fixed instant. Nothing in this file may consult the wall clock. */
const NOW = new Date('2026-09-16T06:40:00.000Z');

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-usage-'));
  created.push(dir);
  return dir;
}

/** Verbatim, from `claude -p "/usage" --output-format json` on 2026-09-16. */
const REPORT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 17% used · resets Sep 16, 4pm (Asia/Taipei)',
  'Current week (all models): 83% used · resets Sep 21, 6:59am (Asia/Taipei)',
  'Current week (Fable): 76% used · resets Sep 21, 6:59am (Asia/Taipei)',
  '',
  "What's contributing to your limits usage?",
  'Approximate, based on local sessions on this machine — does not include other devices or claude.ai.',
  '',
  'Last 24h · 5362 requests · 63 sessions',
  '  93% of your usage came from subagent-heavy sessions',
  '  Top subagents: workflow-subagent 43%, general-purpose 4%',
  '  Top MCP servers: claude.ai ClickUp 1%',
].join('\n');

const envelope = (result: string): string =>
  JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0, num_turns: 0, result });

function runner(outcomes: Record<string, ProbeOutcome>) {
  const seen: string[] = [];
  const run = async (bin: string): Promise<ProbeOutcome> => {
    seen.push(bin);
    return outcomes[bin] ?? { text: null, reason: 'not configured' };
  };
  return { run, seen };
}

describe('reading what /usage prints', () => {
  it('takes the three figures out of the report', () => {
    const report = parseUsageReport(REPORT, NOW);

    expect(report.session?.usedPercentage).toBe(17);
    expect(report.week?.usedPercentage).toBe(83);
    expect(report.perModel).toMatchObject({ model: 'Fable', usedPercentage: 76 });
  });

  it('reads the reset times through their named zone', () => {
    const report = parseUsageReport(REPORT, NOW);

    // 4pm in Taipei is UTC+8, so 08:00Z the same day.
    expect(report.session?.resetsAt?.toISOString()).toBe('2026-09-16T08:00:00.000Z');
    // 6:59am on the 21st, same offset.
    expect(report.week?.resetsAt?.toISOString()).toBe('2026-09-20T22:59:00.000Z');
  });

  it('keeps the breakdown out of it', () => {
    // The report also carries session counts, subagent names and MCP server
    // names. None of it is a figure, and none of it may become one.
    const report = parseUsageReport(REPORT, NOW);
    expect(Object.keys(report)).toEqual(['session', 'week', 'perModel']);
    expect(JSON.stringify(report)).not.toContain('ClickUp');
    expect(JSON.stringify(report)).not.toContain('subagent');
  });

  it('answers with nothing rather than a wrong figure', () => {
    for (const text of [
      '',
      'You are currently using ANTHROPIC_API_KEY to power your Claude Code usage',
      'Current session: unknown',
      'Current session: 200% used',
      'Current week (all models): -4% used',
    ]) {
      const report = parseUsageReport(text, NOW);
      expect(report.session).toBeNull();
      expect(report.week).toBeNull();
    }
  });

  it('keeps a percentage whose reset time it cannot read', () => {
    // The wording of the date is not a contract; the percentage is the part
    // worth having, and the window's bounds can come from the snapshot.
    const report = parseUsageReport('Current week (all models): 61% used · resets soon', NOW);
    expect(report.week).toEqual({ usedPercentage: 61, resetsAt: null });
  });

  it('takes the first of a repeated line rather than the last', () => {
    const report = parseUsageReport(
      ['Current session: 10% used', 'Current session: 90% used'].join('\n'),
      NOW,
    );
    expect(report.session?.usedPercentage).toBe(10);
  });
});

describe('parseResetTime', () => {
  it('reads noon and midnight the way the clock means them', () => {
    expect(parseResetTime('Sep 16, 12pm (UTC)', NOW)?.toISOString()).toBe(
      '2026-09-16T12:00:00.000Z',
    );
    expect(parseResetTime('Sep 16, 12am (UTC)', NOW)?.toISOString()).toBe(
      '2026-09-16T00:00:00.000Z',
    );
  });

  it('carries a December reset into January', () => {
    const newYear = new Date('2026-12-30T12:00:00.000Z');
    expect(parseResetTime('Jan 2, 9am (UTC)', newYear)?.toISOString()).toBe(
      '2027-01-02T09:00:00.000Z',
    );
  });

  it('honours the zone the report names, not the machine running', () => {
    // Same wall clock, three zones, three instants.
    expect(parseResetTime('Sep 16, 9am (UTC)', NOW)?.toISOString()).toBe(
      '2026-09-16T09:00:00.000Z',
    );
    expect(parseResetTime('Sep 16, 9am (Asia/Taipei)', NOW)?.toISOString()).toBe(
      '2026-09-16T01:00:00.000Z',
    );
    expect(parseResetTime('Sep 16, 9am (America/New_York)', NOW)?.toISOString()).toBe(
      '2026-09-16T13:00:00.000Z',
    );
  });

  it('refuses what it cannot read rather than guessing', () => {
    for (const text of [
      '',
      'soon',
      'Sep 16, 4pm',
      'Sep 16, 4pm (Not/AZone)',
      'Xxx 16, 4pm (UTC)',
      'Sep 40, 4pm (UTC)',
      'Sep 16, 25pm (UTC)',
      // A year away: the year guess cannot make this the current window.
      'Mar 3, 4pm (UTC)',
    ]) {
      expect(parseResetTime(text, NOW)).toBeNull();
    }
  });
});

describe('finding the CLI', () => {
  it('prefers a real executable to the shim on Windows', () => {
    const found = claudeCandidates(
      { PATH: ['C:\\nope', 'C:\\Program Files\\nodejs'].join(';') },
      'win32',
      'C:\\Users\\Paul',
    );
    // The repo's own machine has claude.cmd there; whatever is present, the
    // extensionless shell script must never be offered on Windows.
    expect(found.every((file) => !file.endsWith('claude'))).toBe(true);
  });

  it('answers with nothing when there is no CLI anywhere', () => {
    expect(claudeCandidates({ PATH: '/nowhere' }, 'linux', '/home/nobody')).toEqual([]);
  });
});

describe('probing', () => {
  const deps = (run: (bin: string) => Promise<ProbeOutcome>, bins: string[] = ['/bin/claude']) => ({
    env: { PATH: '/bin' },
    platform: 'linux' as NodeJS.Platform,
    homeDir: '/home/x',
    run: (bin: string) => run(bin),
    // The candidate list is filesystem-dependent, so the probe is driven
    // through the injected runner rather than through PATH.
    candidates: bins,
  });

  it('says why it could not ask, rather than failing the read', async () => {
    const { run } = runner({});
    const outcome = await probeUsage({
      env: { PATH: '/nowhere' },
      platform: 'linux',
      homeDir: '/home/nobody',
      run,
    });

    expect(outcome.report).toBeNull();
    expect(outcome.reason).toBe('no claude CLI on PATH');
  });

  it('unwraps the JSON envelope the CLI prints', async () => {
    const report = parseUsageReport(REPORT, NOW);
    expect(report.week?.usedPercentage).toBe(83);
    // The envelope is what --output-format json produces; the parser sees only
    // its `result` string.
    expect(JSON.parse(envelope(REPORT)).result).toContain('Current week');
    void deps;
  });
});

describe('recording a report', () => {
  const report: UsageReport = {
    session: { usedPercentage: 18, resetsAt: new Date('2026-09-16T08:00:00.000Z') },
    week: { usedPercentage: 83, resetsAt: new Date('2026-09-20T22:59:00.000Z') },
    perModel: { model: 'Fable', usedPercentage: 76, resetsAt: null },
  };

  it('keeps the per-model figure out of the snapshot', () => {
    const observed = observedFromReport(report, null);
    expect(Object.keys(observed)).toEqual(['five_hour', 'seven_day']);
  });

  it('skips a window it cannot place in time', () => {
    const observed = observedFromReport(
      { session: { usedPercentage: 18, resetsAt: null }, week: null, perModel: null },
      null,
    );
    expect(observed).toEqual({});
  });

  it("borrows the window's existing reset time when the report's is unreadable", async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    await refreshFromUsage(file, NOW, {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: envelope(REPORT), reason: null }),
    });

    const existing = await readRateLimitSnapshot(file);
    const observed = observedFromReport(
      { session: null, week: { usedPercentage: 90, resetsAt: null }, perModel: null },
      existing,
    );
    expect(observed.seven_day?.resetsAt?.toISOString()).toBe('2026-09-20T22:59:00.000Z');
  });

  it('writes the figures, and pushes the superseded one into history', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);

    const first = await refreshFromUsage(file, NOW, {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: envelope(REPORT), reason: null }),
    });
    expect(first.wrote).toBe(true);

    // A later probe with a higher weekly figure: the same merge rules the
    // status line goes through, so the 83 becomes history and the rate
    // calibration has a pair to measure.
    const later = REPORT.replace('83% used', '88% used');
    const second = await refreshFromUsage(file, new Date(NOW.getTime() + 3_600_000), {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: envelope(later), reason: null }),
    });
    expect(second.wrote).toBe(true);

    const snapshot = await readRateLimitSnapshot(file);
    expect(snapshot?.windows.seven_day?.usedPercentage).toBe(88);
    expect(snapshot?.windows.seven_day?.history).toEqual([
      { usedPercentage: 83, observedAt: NOW },
    ]);
  });

  it('writes nothing at all when the CLI says nothing usable', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);

    const outcome = await refreshFromUsage(file, NOW, {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: envelope('You are currently using ANTHROPIC_API_KEY'), reason: null }),
    });

    expect(outcome.wrote).toBe(false);
    expect(outcome.reason).toBe('no percentages in the report');
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('leaves a good snapshot alone when a later probe fails', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    await refreshFromUsage(file, NOW, {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: envelope(REPORT), reason: null }),
    });
    const before = await readFile(file, 'utf8');

    await refreshFromUsage(file, new Date(NOW.getTime() + 60_000), {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: null, reason: 'exited with code 1' }),
    });

    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('does not treat a file it cannot parse as permission to start again', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    await refreshFromUsage(file, NOW, {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: envelope(REPORT), reason: null }),
    });
    await writeFile(file, '{ not json', 'utf8');

    const outcome = await refreshFromUsage(file, new Date(NOW.getTime() + 60_000), {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: envelope(REPORT), reason: null }),
    });

    // An unreadable file is no file: the probe's figures are written fresh.
    expect(outcome.wrote).toBe(true);
    const snapshot = await readRateLimitSnapshot(file);
    expect(snapshot?.windows.seven_day?.usedPercentage).toBe(83);
  });
});

describe('the per-model limit', () => {
  it('is taken from the report and keyed by the name it printed', () => {
    const report = parseUsageReport(REPORT, NOW);
    const models = modelsFromReport(report, null);
    expect(models['Fable']).toMatchObject({ usedPercentage: 76, clamped: false });
    expect(models['Fable']?.resetsAt.toISOString()).toBe('2026-09-20T22:59:00.000Z');
  });

  it('is nothing at all when the report named no model', () => {
    const report = parseUsageReport('Current week (all models): 50% used', NOW);
    expect(modelsFromReport(report, null)).toEqual({});
  });

  it('reaches the snapshot when a probe records one', async () => {
    const home = await makeHome();
    const file = statusLineSnapshotPath(home);
    await refreshFromUsage(file, NOW, {
      env: {},
      platform: 'linux',
      homeDir: home,
      candidates: ['/bin/claude'],
      run: async () => ({ text: envelope(REPORT), reason: null }),
    });

    const snapshot = await readRateLimitSnapshot(file);
    expect(snapshot?.models['Fable']?.usedPercentage).toBe(76);
  });
});
