/**
 * Anthropic's figures on demand, by asking Claude Code for them.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `statusline.ts` records the percentages Claude Code pushes at a status line,
 * and that door only opens in a TERMINAL session: an IDE session, a print-mode
 * run and a headless SDK run never fire one. Someone working in the VS Code
 * extension can spend a day against a bar that has not moved since their last
 * terminal session, and no amount of local arithmetic fixes that - the local
 * estimate cannot see usage from a phone, the web app or another machine
 * either.
 *
 * `claude -p "/usage" --output-format json` answers with the same figures, and
 * MEASURED ON THE MACHINE THIS WAS WRITTEN FOR it costs nothing to ask:
 *
 *     total_cost_usd 0 · every token count 0 · num_turns 0 · api_ms 0
 *     wall clock 1.1s
 *
 * That is the whole reason this is allowed to run on a refresh and at startup.
 * `/usage` is handled inside Claude Code rather than by a model, so it spends
 * no quota to report quota - and nothing here reads a credential or opens a
 * socket. We run the user's own CLI, which is already signed in, and read what
 * it prints.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * - No polling. It runs when a person asks for a refresh and once at startup.
 *   A free call is still a spawned process, and this tool's whole claim is that
 *   watching your usage costs less than the thing being watched.
 * - No credential, no endpoint, no `~/.claude/.credentials.json`. If Claude
 *   Code is not installed or not signed in, the probe fails and the adapter
 *   carries on with the status line snapshot and the local estimate.
 * - Nothing of the payload is kept but the percentages and their reset times.
 *   `/usage` also prints a breakdown of what drove the usage - session counts,
 *   subagent names, MCP server names - and none of it is stored, logged or
 *   echoed.
 *
 * THE THIRD WINDOW
 * ----------------
 * `/usage` reports a per-model weekly limit as well ("Current week (Fable)"),
 * which nothing in this tool models yet. It is parsed here so the data is in
 * hand, and deliberately not recorded: the snapshot's vocabulary is the two
 * windows Claude Code's status line speaks, and widening it is its own change.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  type LimitWindow,
  type ObservedLimits,
  type RateLimitSnapshot,
  mergeSnapshot,
  readRateLimitSnapshot,
  writeRateLimitSnapshot,
} from './statusline.js';

/* -------------------------------------------------------------------------- */
/* parsing what /usage prints                                                 */
/* -------------------------------------------------------------------------- */

/** One line of the report. `resetsAt` is null when the date could not be read. */
export interface UsageLine {
  usedPercentage: number;
  resetsAt: Date | null;
}

export interface UsageReport {
  session: UsageLine | null;
  week: UsageLine | null;
  /** The per-model weekly limit, if the report named one. Parsed, not stored. */
  perModel: (UsageLine & { model: string }) | null;
}

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
});

/**
 * How far either side of `now` a parsed reset may land before the year is
 * reconsidered. A five-hour window resets within hours and a weekly one within
 * days, so anything beyond a month means the year guess was wrong - which is
 * what happens every December.
 */
const YEAR_WINDOW_MS = 40 * 24 * 60 * 60 * 1000;

/**
 * A time zone's offset from UTC at a given instant, in milliseconds.
 *
 * `Intl` is the only thing in the standard library that knows when Taipei is
 * +08:00 and when Berlin stops being +01:00, and this is the documented way to
 * ask it: format the instant AS the zone, read the parts back as if they were
 * UTC, and the difference is the offset. Throws for a zone name it does not
 * know, which is caught by the caller.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value;
    return found === undefined ? 0 : Number(found);
  };

  // `hour12: false` renders midnight as 24 in some engines.
  const hour = read('hour') % 24;
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
  return asUtc - at.getTime();
}

/**
 * Wall-clock parts in a named zone, as an instant.
 *
 * Offsets are computed twice because the first guess is made with the offset at
 * the WRONG instant, and an hour either side of a DST change that offset is not
 * the one that applies. The second pass is the correction; a third would not
 * change anything a widget shows.
 */
function zonedTime(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date | null {
  const naive = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute);
  try {
    const first = zoneOffsetMs(new Date(naive), timeZone);
    const second = zoneOffsetMs(new Date(naive - first), timeZone);
    return new Date(naive - second);
  } catch {
    // An unknown zone name, which is not worth failing the whole read over.
    return null;
  }
}

/**
 * "Sep 21, 6:59am (Asia/Taipei)" as an instant, or null.
 *
 * The text is localised and the year is absent, so this is deliberately narrow:
 * it reads the shape Claude Code prints today and gives up on anything else
 * rather than guessing. A null reset is not fatal - `recordUsageReport` keeps
 * the window's existing reset time, which the status line or a previous probe
 * already established.
 */
export function parseResetTime(text: string, now: Date): Date | null {
  const match = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(
    text.trim(),
  );
  if (match === null) return null;

  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match;
  const month = MONTHS[(monthName ?? '').slice(0, 3).toLowerCase()];
  if (month === undefined) return null;

  const day = Number(dayText);
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (!Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null;

  // 12am is hour 0 and 12pm is hour 12; every other pm hour is +12.
  const isPm = (meridiem ?? '').toLowerCase() === 'pm';
  if (hour === 12) hour = 0;
  if (isPm) hour += 12;

  const timeZone = (zone ?? '').trim();
  if (timeZone === '') return null;

  // The report carries no year. A window resets within days, so the right year
  // is whichever puts the date nearest to now - which is what carries a
  // December reset into January without a special case.
  const nowYear = new Date(now.getTime()).getUTCFullYear();
  let best: Date | null = null;
  for (const year of [nowYear - 1, nowYear, nowYear + 1]) {
    const candidate = zonedTime({ year, month, day, hour, minute }, timeZone);
    if (candidate === null) continue;
    if (best === null || Math.abs(candidate.getTime() - now.getTime()) < Math.abs(best.getTime() - now.getTime())) {
      best = candidate;
    }
  }

  if (best === null) return null;
  return Math.abs(best.getTime() - now.getTime()) > YEAR_WINDOW_MS ? null : best;
}

/** `17% used · resets Sep 16, 4pm (Asia/Taipei)` → the pair. */
function usageLine(rest: string, now: Date): UsageLine | null {
  const percent = /^\s*([\d.]+)\s*%\s*used/i.exec(rest);
  if (percent === null) return null;

  const used = Number(percent[1]);
  if (!Number.isFinite(used) || used < 0 || used > 100) return null;

  const resets = /resets\s+(.+)$/i.exec(rest);
  return {
    usedPercentage: used,
    resetsAt: resets === null ? null : parseResetTime(resets[1] ?? '', now),
  };
}

/**
 * Read the three lines that matter out of the report.
 *
 * Tolerant by construction: every line is optional, an unreadable one is null
 * rather than an error, and text this does not recognise is simply not a
 * figure. `/usage` is a human-facing report and its wording is not a contract,
 * so the failure mode has to be "no figure", never a wrong one.
 */
export function parseUsageReport(text: string, now: Date): UsageReport {
  const report: UsageReport = { session: null, week: null, perModel: null };
  if (typeof text !== 'string' || text === '') return report;

  for (const line of text.split(/\r?\n/)) {
    const session = /^\s*Current session:\s*(.+)$/i.exec(line);
    if (session !== null) {
      report.session ??= usageLine(session[1] ?? '', now);
      continue;
    }

    const week = /^\s*Current week\s*\(([^)]*)\):\s*(.+)$/i.exec(line);
    if (week === null) continue;

    const scope = (week[1] ?? '').trim().toLowerCase();
    const parsed = usageLine(week[2] ?? '', now);
    if (parsed === null) continue;

    if (scope === 'all models') {
      report.week ??= parsed;
    } else {
      report.perModel ??= { ...parsed, model: (week[1] ?? '').trim() };
    }
  }

  return report;
}

/* -------------------------------------------------------------------------- */
/* running the CLI                                                            */
/* -------------------------------------------------------------------------- */

/** How long the probe may take before it is abandoned. Measured: ~1.1s. */
export const PROBE_TIMEOUT_MS = 20_000;

/** Largest stdout kept. The report is a few hundred bytes. */
const MAX_PROBE_BYTES = 256 * 1024;

export interface ProbeOutcome {
  /** The report text, or null when nothing usable came back. */
  text: string | null;
  /** Why not, for the debug log. Never shown as an error: this is best-effort. */
  reason: string | null;
}

/**
 * Where the Claude Code CLI might be.
 *
 * PATH first, because an installed CLI is on it, then the two places the
 * installers put it when the shell that launched this app had a thinner
 * environment than the user's own - which is the normal case for a desktop
 * app started from Explorer or a login item.
 */
export function claudeCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDir: string,
): string[] {
  const windows = platform === 'win32';
  // `.cmd` before the extensionless shim: the shim is a shell script, which
  // Windows cannot run, and node refuses to spawn a `.cmd` without a shell.
  const names = windows ? ['claude.exe', 'claude.cmd'] : ['claude'];

  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir !== '');
  dirs.push(join(homeDir, '.local', 'bin'));
  if (windows) {
    if (env.APPDATA !== undefined) dirs.push(join(env.APPDATA, 'npm'));
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  }

  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const file = join(dir, name);
      if (!found.includes(file) && existsSync(file)) found.push(file);
    }
  }
  return found;
}

/** Run one candidate and hand back its stdout. Never throws. */
function runProbe(bin: string, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    // A `.cmd` cannot be spawned directly (node refuses since the argument
    // injection fix), so it goes through the interpreter Windows uses for it.
    // Every argument here is a literal from this file - nothing a user typed
    // reaches the command line, which is what makes that safe.
    const windows = bin.toLowerCase().endsWith('.cmd');
    const args = ['-p', '/usage', '--output-format', 'json'];
    const child = windows
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`], {
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let done = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({ text: null, reason: `no answer in ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    // Nothing here should hold the process open a moment longer than the read.
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length > MAX_PROBE_BYTES) return;
      out += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => finish({ text: null, reason: error.message }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ text: null, reason: `exited with code ${code ?? 'null'}` });
      finish({ text: out, reason: null });
    });
  });
}

/**
 * The `result` string out of the CLI's JSON envelope.
 *
 * `--output-format json` is asked for rather than the bare text so the answer
 * is framed: a CLI that printed a warning, a login prompt or an update notice
 * alongside the report would otherwise land in the middle of the text being
 * parsed.
 */
function resultText(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const result = (parsed as { result?: unknown } | null)?.result;
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

export interface ProbeDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  /** Injected in tests. Defaults to actually running the CLI. */
  run?: (bin: string, timeoutMs: number) => Promise<ProbeOutcome>;
  /**
   * Injected in tests, where the answer must not depend on whether the machine
   * running them happens to have Claude Code installed. Production passes
   * nothing and the list comes from the filesystem.
   */
  candidates?: readonly string[];
  timeoutMs?: number;
}

/** Ask Claude Code for the report, or say why not. Never throws. */
export async function probeUsage(
  deps: ProbeDeps,
): Promise<{ report: UsageReport | null; reason: string | null; bin: string | null }> {
  const candidates = deps.candidates ?? claudeCandidates(deps.env, deps.platform, deps.homeDir);
  if (candidates.length === 0) {
    return { report: null, reason: 'no claude CLI on PATH', bin: null };
  }

  const run = deps.run ?? runProbe;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  let lastReason = 'nothing to run';
  for (const bin of candidates) {
    const outcome = await run(bin, timeoutMs);
    if (outcome.text === null) {
      lastReason = outcome.reason ?? 'no output';
      continue;
    }

    const text = resultText(outcome.text) ?? outcome.text;
    const report = parseUsageReport(text, new Date());
    if (report.session === null && report.week === null) {
      // A signed-out CLI, an API-key user, or wording this does not know.
      // Either way there is no figure, and the next candidate will not help.
      return { report: null, reason: 'no percentages in the report', bin };
    }
    return { report, reason: null, bin };
  }

  return { report: null, reason: lastReason, bin: null };
}

/* -------------------------------------------------------------------------- */
/* recording it                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Fold a report into the snapshot, through the SAME merge the status line uses.
 *
 * That is the point of doing it here rather than writing the file directly: the
 * higher figure within a window wins, a later window replaces an earlier one,
 * and the superseded figure lands in the history the rate calibration measures.
 * A probe and a status line are two mouths reporting the same thing, and the
 * file cannot tell which spoke - nor should it have to.
 *
 * A window whose reset time could not be read keeps the one already on disk,
 * because a percentage without bounds cannot be placed in time; with neither,
 * the window is skipped.
 */
export function observedFromReport(
  report: UsageReport,
  existing: RateLimitSnapshot | null,
): ObservedLimits {
  const observed: ObservedLimits = {};

  const put = (window: LimitWindow, line: UsageLine | null): void => {
    if (line === null) return;
    const resetsAt = line.resetsAt ?? existing?.windows[window]?.resetsAt ?? null;
    if (resetsAt === null) return;
    observed[window] = { usedPercentage: line.usedPercentage, resetsAt, clamped: false };
  };

  put('five_hour', report.session);
  put('seven_day', report.week);
  return observed;
}

export interface RecordedProbe {
  /** What the report said, or null when there was nothing to record. */
  report: UsageReport | null;
  /** Whether the snapshot on disk changed. */
  wrote: boolean;
  /** Why no figure was recorded, for the debug log. */
  reason: string | null;
}

/** Probe, then record. The one call the adapter makes. */
export async function refreshFromUsage(
  file: string,
  now: Date,
  deps: ProbeDeps,
): Promise<RecordedProbe> {
  const { report, reason } = await probeUsage(deps);
  if (report === null) return { report: null, wrote: false, reason };

  const existing = await readRateLimitSnapshot(file);
  const observed = observedFromReport(report, existing);
  if (Object.keys(observed).length === 0) {
    return { report, wrote: false, reason: 'no window could be placed in time' };
  }

  const { snapshot, changed } = mergeSnapshot(existing, observed, now);
  if (changed) await writeRateLimitSnapshot(file, snapshot);
  return { report, wrote: changed, reason: null };
}
