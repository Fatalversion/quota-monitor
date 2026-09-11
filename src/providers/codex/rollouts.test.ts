import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CODEX_HOME_ENV,
  DEFAULT_ROLLOUT_LIMIT,
  codexHomeDir,
  listRollouts,
  streamLines,
} from './rollouts.js';

/**
 * The line the adapter is after, verbatim in shape from a real rollout on
 * disk. It carries no prompt text and no absolute path, which is the only
 * reason it can live in a test file at all.
 */
const TOKEN_COUNT_LINE =
  '{"timestamp":"2026-09-07T08:32:02.043Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":18520,"cached_input_tokens":1408,"cache_write_input_tokens":0,"output_tokens":17,"reasoning_output_tokens":10,"total_tokens":18537},"last_token_usage":{"input_tokens":18520,"cached_input_tokens":1408,"cache_write_input_tokens":0,"output_tokens":17,"reasoning_output_tokens":10,"total_tokens":18537},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":0.0,"window_minutes":300,"resets_at":1788787915},"secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1789374715},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"plus","rate_limit_reached_type":null}}}';

// Fixed instants. Nothing in this file may consult the wall clock.
const T1 = new Date('2026-09-05T10:00:00.000Z');
const T2 = new Date('2026-09-06T10:00:00.000Z');
const T3 = new Date('2026-09-07T10:00:00.000Z');
const T4 = new Date('2026-09-08T10:00:00.000Z');

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp directory, cleaned up after the suite. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-codex-'));
  created.push(dir);
  return dir;
}

/** Build `<tmp>/sessions` and return the Codex home that contains it. */
async function makeCodexDir(): Promise<string> {
  const codexDir = await makeTempDir();
  await mkdir(join(codexDir, 'sessions'));
  return codexDir;
}

interface RolloutSpec {
  /** `['2026', '09', '07']` - the YYYY/MM/DD nesting Codex actually writes. */
  day: readonly [string, string, string];
  name: string;
  mtime?: Date;
  lines?: readonly string[];
  /** `sessions` unless the test is exercising the archive. */
  root?: string;
}

/** Write one rollout into the date-nested tree and return its absolute path. */
async function writeRollout(codexDir: string, spec: RolloutSpec): Promise<string> {
  const dir = join(codexDir, spec.root ?? 'sessions', ...spec.day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, spec.name);
  const lines = spec.lines ?? [TOKEN_COUNT_LINE];
  await writeFile(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
  if (spec.mtime !== undefined) await utimes(file, spec.mtime, spec.mtime);
  return file;
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** Run `fn` with CODEX_HOME set to `value`, or unset when undefined. */
async function withCodexHomeEnv(
  value: string | undefined,
  fn: () => void | Promise<void>,
): Promise<void> {
  const previous = process.env[CODEX_HOME_ENV];
  if (value === undefined) delete process.env[CODEX_HOME_ENV];
  else process.env[CODEX_HOME_ENV] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[CODEX_HOME_ENV];
    else process.env[CODEX_HOME_ENV] = previous;
  }
}

describe('codexHomeDir', () => {
  it('defaults to <homeDir>/.codex', async () => {
    await withCodexHomeEnv(undefined, () => {
      expect(codexHomeDir('/home/ada')).toBe(join('/home/ada', '.codex'));
    });
  });

  it('prefers an explicit override over the environment', async () => {
    await withCodexHomeEnv('/from/env', () => {
      expect(codexHomeDir('/home/ada', '/custom/codex')).toBe(resolve('/custom/codex'));
    });
  });

  it('falls back to CODEX_HOME when no override is passed', async () => {
    await withCodexHomeEnv('/from/env', () => {
      expect(codexHomeDir('/home/ada')).toBe(resolve('/from/env'));
    });
  });

  it('ignores a blank override and a blank environment value', async () => {
    await withCodexHomeEnv('   ', () => {
      expect(codexHomeDir('/home/ada')).toBe(join('/home/ada', '.codex'));
      expect(codexHomeDir('/home/ada', '  ')).toBe(join('/home/ada', '.codex'));
    });
  });

  it('expands a leading ~ in the override against homeDir', async () => {
    await withCodexHomeEnv(undefined, () => {
      expect(codexHomeDir('/home/ada', '~/elsewhere')).toBe(resolve(join('/home/ada', 'elsewhere')));
      expect(codexHomeDir('/home/ada', '~')).toBe(resolve('/home/ada'));
    });
  });
});

describe('listRollouts', () => {
  it('returns an empty selection when the Codex home does not exist', async () => {
    const parent = await makeTempDir();

    await expect(listRollouts(join(parent, 'nope'))).resolves.toEqual({
      files: [],
      entries: [],
      skippedCompressed: 0,
      scanned: 0,
    });
  });

  it('returns an empty selection when sessions/ exists but is empty', async () => {
    const codexDir = await makeCodexDir();

    await expect(listRollouts(codexDir)).resolves.toEqual({
      files: [],
      entries: [],
      skippedCompressed: 0,
      scanned: 0,
    });
  });

  it('returns an empty selection when sessions is a file rather than a directory', async () => {
    const codexDir = await makeTempDir();
    await writeFile(join(codexDir, 'sessions'), 'not a directory', 'utf8');

    await expect(listRollouts(codexDir)).resolves.toEqual({
      files: [],
      entries: [],
      skippedCompressed: 0,
      scanned: 0,
    });
  });

  it('descends the YYYY/MM/DD nesting a flat readdir cannot see', async () => {
    const codexDir = await makeCodexDir();
    const rollout = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T16-31-52-01a07afe-4c1d-4f3a-9c62-5b0c9a1e77d1.jsonl',
    });

    // The premise, asserted rather than assumed: the top of sessions/ holds
    // one directory entry and zero rollouts.
    const flat = await readdir(join(codexDir, 'sessions'), { withFileTypes: true });
    expect(flat.filter((entry) => entry.isFile())).toEqual([]);

    const selection = await listRollouts(codexDir);

    expect(selection.files).toEqual([rollout]);
    expect(selection.scanned).toBe(1);
  });

  it('finds rollouts spread across several months and days', async () => {
    const codexDir = await makeCodexDir();
    const a = await writeRollout(codexDir, {
      day: ['2026', '08', '31'],
      name: 'rollout-2026-08-31T09-00-00-aaaaaaaa.jsonl',
      mtime: T1,
    });
    const b = await writeRollout(codexDir, {
      day: ['2026', '09', '01'],
      name: 'rollout-2026-09-01T09-00-00-bbbbbbbb.jsonl',
      mtime: T2,
    });
    const c = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T09-00-00-cccccccc.jsonl',
      mtime: T3,
    });

    const selection = await listRollouts(codexDir);

    expect([...selection.files].sort()).toEqual([a, b, c].sort());
    expect(selection.scanned).toBe(3);
    expect(selection.skippedCompressed).toBe(0);
  });

  it('orders newest first by mtime, not by path', async () => {
    const codexDir = await makeCodexDir();
    // The oldest-looking path is deliberately the newest file, so a name sort
    // and an mtime sort cannot agree.
    const oldPathNewFile = await writeRollout(codexDir, {
      day: ['2026', '08', '01'],
      name: 'rollout-2026-08-01T00-00-00-aaaaaaaa.jsonl',
      mtime: T3,
    });
    const middle = await writeRollout(codexDir, {
      day: ['2026', '09', '01'],
      name: 'rollout-2026-09-01T00-00-00-bbbbbbbb.jsonl',
      mtime: T2,
    });
    const newPathOldFile = await writeRollout(codexDir, {
      day: ['2026', '09', '09'],
      name: 'rollout-2026-09-09T00-00-00-cccccccc.jsonl',
      mtime: T1,
    });

    const selection = await listRollouts(codexDir);

    expect(selection.files).toEqual([oldPathNewFile, middle, newPathOldFile]);
  });

  /**
   * The mtimes are part of the selection, not an internal detail: a reader that
   * only gets paths has to assume the first file holds the newest snapshot, and
   * that assumption is false - a file's mtime is later than its newest
   * `token_count`, by an amount that differs per file. `mtimeMs` is the upper
   * bound that lets the codex adapter know when it can stop opening files.
   */
  it('pairs every returned path with the mtime it was ordered on', async () => {
    const codexDir = await makeCodexDir();
    const newer = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T08-00-00-aaaaaaaa.jsonl',
      mtime: T3,
    });
    const older = await writeRollout(codexDir, {
      day: ['2026', '09', '05'],
      name: 'rollout-2026-09-05T08-00-00-bbbbbbbb.jsonl',
      mtime: T1,
    });

    const selection = await listRollouts(codexDir);

    expect(selection.entries.map((entry) => entry.file)).toEqual(selection.files);
    expect(selection.entries).toEqual([
      { file: newer, mtimeMs: T3.getTime() },
      { file: older, mtimeMs: T1.getTime() },
    ]);
  });

  it('breaks an mtime tie by path, stably across calls', async () => {
    const codexDir = await makeCodexDir();
    const first = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T08-00-00-aaaaaaaa.jsonl',
      mtime: T2,
    });
    const second = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T19-00-00-bbbbbbbb.jsonl',
      mtime: T2,
    });

    const one = await listRollouts(codexDir);
    const two = await listRollouts(codexDir);

    // Rollout names embed a UTC stamp, so descending path order puts the later
    // session first even when the filesystem stamped both the same instant.
    expect(one.files).toEqual([second, first]);
    expect(two.files).toEqual(one.files);
  });

  it('counts a .jsonl.zst rollout as skipped and never returns it', async () => {
    const codexDir = await makeCodexDir();
    const plain = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T16-31-52-01a07afe.jsonl',
      mtime: T3,
    });
    const compressed = await writeRollout(codexDir, {
      day: ['2026', '08', '20'],
      name: 'rollout-2026-08-20T11-02-03-deadbeef.jsonl.zst',
      mtime: T1,
      lines: ['not-really-zstd-but-the-name-is-what-matters'],
    });
    await writeRollout(codexDir, {
      day: ['2026', '08', '21'],
      name: 'rollout-2026-08-21T11-02-03-feedface.jsonl.zst',
      mtime: T1,
      lines: ['also-compressed'],
    });

    const selection = await listRollouts(codexDir);

    // Silent truncation is the failure mode: the caller must be able to say
    // "older windows may be incomplete" instead of pretending they are whole.
    expect(selection.files).toEqual([plain]);
    expect(selection.files).not.toContain(compressed);
    expect(selection.skippedCompressed).toBe(2);
    expect(selection.scanned).toBe(3);
  });

  it('caps the returned files at opts.limit, newest first', async () => {
    const codexDir = await makeCodexDir();
    const newest = await writeRollout(codexDir, {
      day: ['2026', '09', '08'],
      name: 'rollout-2026-09-08T00-00-00-dddddddd.jsonl',
      mtime: T4,
    });
    const second = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T00-00-00-cccccccc.jsonl',
      mtime: T3,
    });
    await writeRollout(codexDir, {
      day: ['2026', '09', '06'],
      name: 'rollout-2026-09-06T00-00-00-bbbbbbbb.jsonl',
      mtime: T2,
    });
    await writeRollout(codexDir, {
      day: ['2026', '09', '05'],
      name: 'rollout-2026-09-05T00-00-00-aaaaaaaa.jsonl',
      mtime: T1,
    });

    const selection = await listRollouts(codexDir, { limit: 2 });

    expect(selection.files).toEqual([newest, second]);
    // The cap trims what is returned, never what was counted.
    expect(selection.scanned).toBe(4);
  });

  it('defaults to DEFAULT_ROLLOUT_LIMIT files', async () => {
    const codexDir = await makeCodexDir();
    const total = DEFAULT_ROLLOUT_LIMIT + 2;
    for (let i = 0; i < total; i += 1) {
      const stamp = String(i).padStart(2, '0');
      await writeRollout(codexDir, {
        day: ['2026', '09', '07'],
        name: `rollout-2026-09-07T${stamp}-00-00-0000000${stamp}.jsonl`,
        // Minute i of a fixed hour: distinct, ordered, and clock-free.
        mtime: new Date(Date.UTC(2026, 8, 7, 0, i, 0)),
      });
    }

    const selection = await listRollouts(codexDir);

    expect(DEFAULT_ROLLOUT_LIMIT).toBe(25);
    expect(selection.files).toHaveLength(DEFAULT_ROLLOUT_LIMIT);
    expect(selection.scanned).toBe(total);
    expect(selection.files[0]).toContain(`T${String(total - 1).padStart(2, '0')}-00-00`);
  });

  it('accounts for every rollout it saw: kept + trimmed + compressed', async () => {
    const codexDir = await makeCodexDir();
    for (let i = 0; i < 5; i += 1) {
      await writeRollout(codexDir, {
        day: ['2026', '09', '07'],
        name: `rollout-2026-09-07T0${i}-00-00-plain${i}.jsonl`,
        mtime: new Date(Date.UTC(2026, 8, 7, i, 0, 0)),
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await writeRollout(codexDir, {
        day: ['2026', '08', '01'],
        name: `rollout-2026-08-01T0${i}-00-00-old${i}.jsonl.zst`,
        lines: ['compressed'],
      });
    }

    const selection = await listRollouts(codexDir, { limit: 2 });

    const trimmed = selection.scanned - selection.skippedCompressed - selection.files.length;
    expect(selection.files).toHaveLength(2);
    expect(selection.skippedCompressed).toBe(3);
    expect(selection.scanned).toBe(8);
    expect(trimmed).toBe(3);
  });

  it('honours limit 0 and normalises a negative, fractional, or NaN limit', async () => {
    const codexDir = await makeCodexDir();
    for (let i = 0; i < 3; i += 1) {
      await writeRollout(codexDir, {
        day: ['2026', '09', '07'],
        name: `rollout-2026-09-07T0${i}-00-00-0000000${i}.jsonl`,
        mtime: new Date(Date.UTC(2026, 8, 7, i, 0, 0)),
      });
    }

    const none = await listRollouts(codexDir, { limit: 0 });
    expect(none.files).toEqual([]);
    // Asking for nothing is not the same as finding nothing.
    expect(none.scanned).toBe(3);

    await expect(listRollouts(codexDir, { limit: -5 })).resolves.toMatchObject({ files: [] });

    const fractional = await listRollouts(codexDir, { limit: 2.7 });
    expect(fractional.files).toHaveLength(2);

    const nan = await listRollouts(codexDir, { limit: Number.NaN });
    expect(nan.files).toHaveLength(3);

    const infinite = await listRollouts(codexDir, { limit: Number.POSITIVE_INFINITY });
    expect(infinite.files).toHaveLength(3);
  });

  it('ignores everything that is not a rollout, and never lists auth.json', async () => {
    const codexDir = await makeCodexDir();
    const keep = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T16-31-52-01a07afe.jsonl',
    });
    const dayDir = join(codexDir, 'sessions', '2026', '09', '07');
    // The OAuth token store, planted where the walk would trip over it.
    await writeFile(join(dayDir, 'auth.json'), '{"tokens":{"access_token":"nope"}}', 'utf8');
    await writeFile(join(codexDir, 'auth.json'), '{"tokens":{"access_token":"nope"}}', 'utf8');
    await writeFile(join(dayDir, 'history.jsonl.tmp'), 'nope', 'utf8');
    await writeFile(join(dayDir, 'notes.txt'), 'nope', 'utf8');
    await writeFile(join(dayDir, '.jsonl'), 'nope', 'utf8');
    await writeFile(join(dayDir, '.hidden.jsonl'), 'nope', 'utf8');
    await mkdir(join(dayDir, 'decoy.jsonl'));

    const selection = await listRollouts(codexDir);

    expect(selection.files).toEqual([keep]);
    expect(selection.scanned).toBe(1);
    expect(selection.skippedCompressed).toBe(0);
  });

  it('does not enter hidden directories', async () => {
    const codexDir = await makeCodexDir();
    const keep = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T16-31-52-01a07afe.jsonl',
    });
    const hidden = join(codexDir, 'sessions', '.trash');
    await mkdir(hidden, { recursive: true });
    await writeFile(join(hidden, 'rollout-2026-01-01T00-00-00-hidden.jsonl'), '{}\n', 'utf8');

    await expect(listRollouts(codexDir)).resolves.toMatchObject({ files: [keep], scanned: 1 });
  });

  it('accepts an uppercase extension', async () => {
    const codexDir = await makeCodexDir();
    const upper = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'ROLLOUT-2026-09-07T16-31-52-01A07AFE.JSONL',
    });

    await expect(listRollouts(codexDir)).resolves.toMatchObject({ files: [upper] });
  });

  it('skips archived_sessions/ by default and walks it on request', async () => {
    const codexDir = await makeCodexDir();
    const live = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T16-31-52-live.jsonl',
      mtime: T3,
    });
    const archived = await writeRollout(codexDir, {
      day: ['2026', '05', '01'],
      name: 'rollout-2026-05-01T10-00-00-archived.jsonl',
      mtime: T1,
      root: 'archived_sessions',
    });

    const liveOnly = await listRollouts(codexDir);
    expect(liveOnly.files).toEqual([live]);
    expect(liveOnly.scanned).toBe(1);

    const both = await listRollouts(codexDir, { includeArchived: true });
    expect(both.files).toEqual([live, archived]);
    expect(both.scanned).toBe(2);
  });

  it('counts compressed rollouts in the archive too, when it is walked', async () => {
    const codexDir = await makeCodexDir();
    await writeRollout(codexDir, {
      day: ['2026', '05', '01'],
      name: 'rollout-2026-05-01T10-00-00-archived.jsonl.zst',
      lines: ['compressed'],
      root: 'archived_sessions',
    });

    await expect(listRollouts(codexDir)).resolves.toMatchObject({
      skippedCompressed: 0,
      scanned: 0,
    });
    await expect(listRollouts(codexDir, { includeArchived: true })).resolves.toMatchObject({
      files: [],
      skippedCompressed: 1,
      scanned: 1,
    });
  });

  it('stops descending at a bounded depth', async () => {
    const codexDir = await makeCodexDir();
    // Four levels below sessions/ is reachable - one more than the real
    // YYYY/MM/DD layout needs. The fifth is not.
    const reachable = join(codexDir, 'sessions', '2026', '09', '07', 'extra');
    await mkdir(reachable, { recursive: true });
    const deepest = join(reachable, 'rollout-2026-09-07T00-00-00-ok.jsonl');
    await writeFile(deepest, '{}\n', 'utf8');

    const tooDeep = join(reachable, 'deeper');
    await mkdir(tooDeep, { recursive: true });
    const beyond = join(tooDeep, 'rollout-2026-09-07T00-00-00-nope.jsonl');
    await writeFile(beyond, '{}\n', 'utf8');

    const selection = await listRollouts(codexDir);

    expect(selection.files).toContain(deepest);
    expect(selection.files).not.toContain(beyond);
    expect(selection.scanned).toBe(1);
  });
});

describe('streamLines', () => {
  it('yields each non-blank line in order', async () => {
    const codexDir = await makeCodexDir();
    const file = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T16-31-52-01a07afe.jsonl',
      lines: [
        '{"timestamp":"2026-09-07T08:31:52.001Z","type":"session_meta","payload":{}}',
        '',
        '   ',
        TOKEN_COUNT_LINE,
      ],
    });

    await expect(collect(streamLines(file))).resolves.toEqual([
      '{"timestamp":"2026-09-07T08:31:52.001Z","type":"session_meta","payload":{}}',
      TOKEN_COUNT_LINE,
    ]);
  });

  it('yields a token_count line verbatim, so JSON.parse can take it', async () => {
    const codexDir = await makeCodexDir();
    const file = await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T16-31-52-01a07afe.jsonl',
    });

    const lines = await collect(streamLines(file));
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0] ?? '') as {
      payload: { type: string; rate_limits: { primary: { window_minutes: number } } };
    };
    expect(parsed.payload.type).toBe('token_count');
    expect(parsed.payload.rate_limits.primary.window_minutes).toBe(300);
  });

  it('handles CRLF endings, a BOM, and a missing trailing newline', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'rollout-crlf.jsonl');
    await writeFile(file, '\uFEFF{"a":1}\r\n\r\n{"b":2}\r\n{"c":3}', 'utf8');

    await expect(collect(streamLines(file))).resolves.toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('yields nothing for a missing file instead of throwing', async () => {
    const dir = await makeTempDir();

    await expect(collect(streamLines(join(dir, 'gone.jsonl')))).resolves.toEqual([]);
  });

  it('yields nothing when the path is a directory', async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, 'adirectory.jsonl'));

    await expect(collect(streamLines(join(dir, 'adirectory.jsonl')))).resolves.toEqual([]);
  });

  it('yields nothing for an empty file', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'empty.jsonl');
    await writeFile(file, '', 'utf8');

    await expect(collect(streamLines(file))).resolves.toEqual([]);
  });

  it('refuses auth.json even when it exists and is readable', async () => {
    // The OAuth token store. The guard is explicit precisely because the
    // allowlist would already have excluded it - two independent refusals.
    const codexDir = await makeCodexDir();
    const authFile = join(codexDir, 'auth.json');
    await writeFile(authFile, '{"tokens":{"access_token":"secret"}}\n', 'utf8');
    // Same refusal on a case-varied name, on a filesystem that would happily
    // open it: the guard is case-insensitive, not luck.
    const shouty = join(codexDir, 'sessions', 'AUTH.JSON');
    await writeFile(shouty, '{"tokens":{"access_token":"secret"}}\n', 'utf8');

    await expect(collect(streamLines(authFile))).resolves.toEqual([]);
    await expect(collect(streamLines(shouty))).resolves.toEqual([]);

    // ...and the same file read through a name the guard does not match is
    // perfectly readable, so the empty results above are the guard at work
    // rather than an unreadable file.
    const decoy = join(codexDir, 'sessions', 'not-auth.json');
    await writeFile(decoy, '{"ok":true}\n', 'utf8');
    await expect(collect(streamLines(decoy))).resolves.toEqual(['{"ok":true}']);
  });

  it('stops cleanly when the consumer breaks out early', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'rollout-big.jsonl');
    const lines = Array.from({ length: 5000 }, (_unused, i) => `{"i":${i}}`);
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    const seen: string[] = [];
    for await (const line of streamLines(file)) {
      seen.push(line);
      if (seen.length === 3) break;
    }

    expect(seen).toEqual(['{"i":0}', '{"i":1}', '{"i":2}']);
  });

  it('streams a large file line by line', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'rollout-many.jsonl');
    const count = 5000;
    const lines = Array.from({ length: count }, (_unused, i) => `{"i":${i}}`);
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    let seen = 0;
    let last = '';
    for await (const line of streamLines(file)) {
      seen += 1;
      last = line;
    }

    expect(seen).toBe(count);
    expect(last).toBe(`{"i":${count - 1}}`);
  });

  it('reads the rollouts listRollouts hands it', async () => {
    // The two halves of this module are only useful together: list, then
    // stream the newest, which is where the winning rate_limits snapshot is.
    const codexDir = await makeCodexDir();
    await writeRollout(codexDir, {
      day: ['2026', '09', '06'],
      name: 'rollout-2026-09-06T09-00-00-older.jsonl',
      mtime: T2,
      lines: ['{"payload":{"type":"token_count","which":"older"}}'],
    });
    await writeRollout(codexDir, {
      day: ['2026', '09', '07'],
      name: 'rollout-2026-09-07T16-31-52-newest.jsonl',
      mtime: T3,
      lines: ['{"payload":{"type":"token_count","which":"newest"}}'],
    });

    const selection = await listRollouts(codexDir, { limit: 1 });
    expect(selection.files).toHaveLength(1);

    const lines = await collect(streamLines(selection.files[0] ?? ''));
    expect(lines).toEqual(['{"payload":{"type":"token_count","which":"newest"}}']);
  });
});
