/**
 * OpenAI's own figures on demand, by asking Codex for them.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The rollout-log reader answers with whatever Codex last wrote, which is
 * whenever the user last ran it. On a machine where Codex is used twice a week
 * that is a percentage from Tuesday shown on Friday, and nothing on disk moves
 * in between - confirmed by looking: no file under ~/.codex refreshes without a
 * model turn.
 *
 * Codex has no `usage` subcommand, but its app-server does: the JSON-RPC
 * protocol the Codex desktop app and TUI speak carries `account/rateLimits/
 * read`, and its schema ships with the CLI (`codex app-server
 * generate-json-schema`). Measured on the machine this was written for:
 *
 *     1.09 s wall, including spawning the process
 *     no usage, token or cost fields in the response
 *     no new rollout file, no new session: it is a metadata fetch, not a turn
 *
 * It DOES make one HTTPS call to the account backend - that is why the figures
 * are live rather than cached - but it spends no quota to report quota, and the
 * request is made by the user's own signed-in CLI. Nothing here reads a
 * credential: no `auth.json`, no token, no endpoint of our own.
 *
 * WHY THE PROTOCOL AND NOT THE ENDPOINT
 * -------------------------------------
 * The underlying HTTP path is in the binary's string table, and calling it
 * directly would mean lifting the ChatGPT access token out of `auth.json` and
 * refreshing it ourselves - undocumented, unversioned, and broken the first
 * time it rotates. The app-server is a generated, versioned contract that
 * handles the token for us. If it changes shape, the probe fails and the
 * rollout reader carries on, which is the correct failure.
 *
 * WHAT IT RETURNS THAT THE LOGS DO NOT
 * ------------------------------------
 * `rateLimitsByLimitId`: one bucket per limit, so a per-model limit
 * ("GPT-5.3-Codex-Spark") arrives beside the plan's own. Those become readings
 * with a `scope`, exactly as Claude Code's per-model weekly limit does.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import type { RateSnapshot, RateWindow } from './parse.js';

/** How long the probe may take before it is abandoned. Measured: ~1.1s. */
export const PROBE_TIMEOUT_MS = 20_000;

/** Largest stdout kept. The answer is a few kilobytes. */
const MAX_PROBE_BYTES = 4 * 1024 * 1024;

/** Below a day is the short rolling window; a day or more is the long one. */
const DAY_MINUTES = 1440;

export interface ProbeOutcome {
  text: string | null;
  reason: string | null;
}

/** One limit family, as the app-server reports it. */
export interface ProbedLimit {
  /** e.g. "codex", or "codex_bengalfox" for a per-model limit. */
  limitId: string;
  /** The display name the protocol gives a per-model limit, when it gives one. */
  limitName: string | null;
  planType: string | null;
  session: RateWindow | null;
  weekly: RateWindow | null;
}

export interface ProbeResult {
  /** When the probe ran. These figures are live as of this instant. */
  at: Date;
  limits: ProbedLimit[];
}

/* -------------------------------------------------------------------------- */
/* reading the answer                                                         */
/* -------------------------------------------------------------------------- */

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * One window from the protocol's camelCase shape.
 *
 * Deliberately not shared with `parse.ts`, which reads the snake_case form the
 * rollout logs carry. Two spellings of one idea, and a single reader that tried
 * to accept both would quietly accept a half-populated object from either.
 */
function windowOf(value: unknown): RateWindow | null {
  const usedPercent = field(value, 'usedPercent');
  const windowMinutes = field(value, 'windowDurationMins');
  const resetsAt = field(value, 'resetsAt');

  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes)) return null;
  if (windowMinutes <= 0) return null;
  // UNIX SECONDS, like the rollout logs. A value in milliseconds would put the
  // reset in the year 58000, so the upper bound is not paranoia.
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
  if (resetsAt <= 0 || resetsAt > 4_102_444_800) return null;

  const clamped = usedPercent < 0 || usedPercent > 100;
  const window: RateWindow = {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: new Date(resetsAt * 1000),
  };
  if (clamped) window.clamped = true;
  return window;
}

/** `primary` and `secondary` sorted into the two windows this tool speaks. */
function limitOf(limitId: string, value: unknown): ProbedLimit | null {
  const windows = [windowOf(field(value, 'primary')), windowOf(field(value, 'secondary'))].filter(
    (window): window is RateWindow => window !== null,
  );
  if (windows.length === 0) return null;

  const session = windows.find((window) => window.windowMinutes < DAY_MINUTES) ?? null;
  const weekly = windows.find((window) => window.windowMinutes >= DAY_MINUTES) ?? null;
  if (session === null && weekly === null) return null;

  return {
    limitId,
    limitName: str(field(value, 'limitName')),
    planType: str(field(value, 'planType')),
    session,
    weekly,
  };
}

/**
 * The limits out of one `account/rateLimits/read` result.
 *
 * `rateLimitsByLimitId` is preferred because it carries every bucket; the
 * flat `rateLimits` is the same thing for the default limit and is used only
 * when the map is absent, so a protocol that drops the map does not take the
 * main figure with it.
 */
export function parseRateLimitsResult(result: unknown, at: Date): ProbeResult {
  const limits: ProbedLimit[] = [];

  const byId = field(result, 'rateLimitsByLimitId');
  if (typeof byId === 'object' && byId !== null && !Array.isArray(byId)) {
    for (const [limitId, value] of Object.entries(byId as Record<string, unknown>)) {
      const limit = limitOf(limitId, value);
      if (limit !== null) limits.push(limit);
    }
  }

  if (limits.length === 0) {
    const flat = field(result, 'rateLimits');
    const limitId = str(field(flat, 'limitId')) ?? 'codex';
    const limit = limitOf(limitId, flat);
    if (limit !== null) limits.push(limit);
  }

  return { at, limits };
}

/**
 * Find the `result` of our request in a stream of newline-delimited JSON-RPC.
 *
 * The app-server also emits notifications and may answer other requests, so the
 * id is what identifies the answer - not the position in the stream.
 */
export function resultForId(stdout: string, id: number): unknown {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (field(parsed, 'id') !== id) continue;
    const error = field(parsed, 'error');
    if (error !== undefined) return null;
    return field(parsed, 'result') ?? null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* running it                                                                 */
/* -------------------------------------------------------------------------- */

/** Where the Codex CLI might be. PATH first, then the installers' own places. */
export function codexCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDir: string,
): string[] {
  const windows = platform === 'win32';
  // `.cmd` rather than the extensionless shim on Windows: the shim is a shell
  // script, and node refuses to spawn a `.cmd` without an interpreter.
  const names = windows ? ['codex.exe', 'codex.cmd'] : ['codex'];

  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir !== '');
  dirs.push(join(homeDir, '.codex', 'bin'), join(homeDir, '.local', 'bin'));
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

/** The request id we ask under. Any number would do; a constant is testable. */
export const REQUEST_ID = 2;

/** The three lines of protocol, in order. */
export function handshake(): string {
  return (
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'quota-monitor', version: '1' } },
    })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n${JSON.stringify({
      jsonrpc: '2.0',
      id: REQUEST_ID,
      method: 'account/rateLimits/read',
    })}\n`
  );
}

/** Drive one `codex app-server` and hand back its stdout. Never throws. */
function runProbe(bin: string, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const windows = bin.toLowerCase().endsWith('.cmd');
    const child = windows
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${bin}" app-server"`], {
          windowsVerbatimArguments: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        })
      : spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });

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
      // Whatever arrived before the deadline may still hold the answer: the
      // server stays open for more requests, so there is no "end" to wait for.
      finish(out === '' ? { text: null, reason: `no answer in ${Math.round(timeoutMs / 1000)}s` } : { text: out, reason: null });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length > MAX_PROBE_BYTES) return;
      out += chunk.toString('utf8');
      // The answer to our request is the only thing we are waiting for. Taking
      // it as soon as it arrives is what keeps this near a second rather than
      // near the timeout - the process would otherwise sit there serving a
      // protocol nobody is speaking.
      if (resultForId(out, REQUEST_ID) !== null) finish({ text: out, reason: null });
    });
    child.on('error', (error: Error) => finish({ text: null, reason: error.message }));
    child.on('close', () => finish(out === '' ? { text: null, reason: 'no output' } : { text: out, reason: null }));

    try {
      child.stdin?.write(handshake());
    } catch (error) {
      finish({ text: null, reason: error instanceof Error ? error.message : String(error) });
    }
  });
}

export interface ProbeDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  now: Date;
  /** Injected in tests; production runs the CLI. */
  run?: (bin: string, timeoutMs: number) => Promise<ProbeOutcome>;
  /** Injected in tests, so the answer does not depend on what is installed. */
  candidates?: readonly string[];
  timeoutMs?: number;
}

/** Ask Codex for its limits, or say why not. Never throws. */
export async function probeRateLimits(
  deps: ProbeDeps,
): Promise<{ result: ProbeResult | null; reason: string | null }> {
  const candidates = deps.candidates ?? codexCandidates(deps.env, deps.platform, deps.homeDir);
  if (candidates.length === 0) return { result: null, reason: 'no codex CLI on PATH' };

  const run = deps.run ?? runProbe;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  let lastReason = 'nothing to run';
  for (const bin of candidates) {
    const outcome = await run(bin, timeoutMs);
    if (outcome.text === null) {
      lastReason = outcome.reason ?? 'no output';
      continue;
    }

    const result = resultForId(outcome.text, REQUEST_ID);
    if (result === null) {
      // A signed-out CLI, or a protocol that has moved on. Either way the next
      // candidate is the same binary from another directory.
      return { result: null, reason: 'no rate limits in the answer' };
    }

    const parsed = parseRateLimitsResult(result, deps.now);
    if (parsed.limits.length === 0) return { result: null, reason: 'no usable window in the answer' };
    return { result: parsed, reason: null };
  }

  return { result: null, reason: lastReason };
}

/* -------------------------------------------------------------------------- */
/* keeping it                                                                 */
/* -------------------------------------------------------------------------- */

export const PROBE_KIND = 'codex-rate-limits';
export const PROBE_VERSION = 1;

/** Beside the other snapshots, in quota-monitor's own directory. */
export function probeSnapshotPath(homeDir: string): string {
  return join(homeDir, '.config', 'quota-monitor', 'codex-rate-limits.json');
}

export function serializeProbe(result: ProbeResult): string {
  return `${JSON.stringify(
    {
      tool: 'quota-monitor',
      kind: PROBE_KIND,
      version: PROBE_VERSION,
      at: result.at.toISOString(),
      limits: result.limits.map((limit) => ({
        limitId: limit.limitId,
        limitName: limit.limitName,
        planType: limit.planType,
        session: limit.session === null ? null : wireWindow(limit.session),
        weekly: limit.weekly === null ? null : wireWindow(limit.weekly),
      })),
    },
    null,
    2,
  )}\n`;
}

function wireWindow(window: RateWindow): Record<string, unknown> {
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes,
    resetsAt: window.resetsAt.toISOString(),
    ...(window.clamped === true ? { clamped: true } : {}),
  };
}

function readWindow(value: unknown): RateWindow | null {
  const usedPercent = field(value, 'usedPercent');
  const windowMinutes = field(value, 'windowMinutes');
  const resetsAt = str(field(value, 'resetsAt'));
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null;
  }
  if (resetsAt === null) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;

  const window: RateWindow = { usedPercent, windowMinutes, resetsAt: at };
  if (field(value, 'clamped') === true) window.clamped = true;
  return window;
}

export function parseProbe(text: string): ProbeResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (field(parsed, 'kind') !== PROBE_KIND) return null;
  if (field(parsed, 'version') !== PROBE_VERSION) return null;
  const atText = str(field(parsed, 'at'));
  if (atText === null) return null;
  const at = new Date(atText);
  if (Number.isNaN(at.getTime())) return null;

  const rawLimits = field(parsed, 'limits');
  if (!Array.isArray(rawLimits)) return null;

  const limits: ProbedLimit[] = [];
  for (const raw of rawLimits) {
    const limitId = str(field(raw, 'limitId'));
    if (limitId === null) continue;
    const session = readWindow(field(raw, 'session'));
    const weekly = readWindow(field(raw, 'weekly'));
    if (session === null && weekly === null) continue;
    limits.push({
      limitId,
      limitName: str(field(raw, 'limitName')),
      planType: str(field(raw, 'planType')),
      session,
      weekly,
    });
  }

  return limits.length === 0 ? null : { at, limits };
}

/** The last probe's answer, or null. Never throws. */
export async function readProbeSnapshot(file: string): Promise<ProbeResult | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_PROBE_BYTES) return null;
    return parseProbe(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write it atomically. Never throws; a failure just means the next read asks again. */
export async function writeProbeSnapshot(file: string, result: ProbeResult): Promise<boolean> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, serializeProbe(result), 'utf8');
    await rename(temp, file);
    return true;
  } catch {
    await rm(temp, { force: true }).catch(() => {
      /* A temp file in a cache directory. */
    });
    return false;
  }
}

/**
 * The default limit family, which is the one the plan's own rows come from.
 *
 * `codex` is what the protocol calls it; anything else is a per-model bucket
 * and becomes a scoped row instead.
 */
export const DEFAULT_LIMIT_ID = 'codex';

/** A probed limit in the shape the rest of the adapter already speaks. */
export function asRateSnapshot(result: ProbeResult, limit: ProbedLimit): RateSnapshot {
  return {
    at: result.at,
    planType: limit.planType,
    limitId: limit.limitId,
    session: limit.session,
    weekly: limit.weekly,
    credits: null,
  };
}
