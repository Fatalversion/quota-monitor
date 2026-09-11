import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_CONFIG_DIR_ENV,
  MAX_LINE_LENGTH,
  claudeHomeDir,
  decodeProjectDir,
  listTranscripts,
  newStreamStatus,
  streamLines,
} from './transcripts.js';

/**
 * A seam for the one failure that cannot be produced from the filesystem in a
 * portable test: a read that dies PART WAY THROUGH a file, which on Windows is
 * a routine EBUSY against a transcript Claude Code is still appending to. When
 * `hooks.createReadStream` is null - which is every test but two - the real
 * `node:fs` implementation runs.
 */
const hooks = vi.hoisted(() => ({ createReadStream: null as (() => Readable) | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patched = (...args: Parameters<typeof actual.createReadStream>): unknown =>
    hooks.createReadStream === null ? actual.createReadStream(...args) : hooks.createReadStream();
  return { ...actual, createReadStream: patched };
});

/** Run `fn` with `createReadStream` replaced, restoring it afterwards. */
async function withReadStream(make: () => Readable, fn: () => Promise<void>): Promise<void> {
  hooks.createReadStream = make;
  try {
    await fn();
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

// Fixed instants. Nothing in this file may consult the wall clock.
const OLD_MTIME = new Date('2025-01-01T00:00:00.000Z');
const CUTOFF = new Date('2025-03-01T00:00:00.000Z');
const NEW_MTIME = new Date('2025-06-01T00:00:00.000Z');

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp directory, cleaned up after the suite. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-transcripts-'));
  created.push(dir);
  return dir;
}

/** Build `<tmp>/projects` and return the Claude home that contains it. */
async function makeClaudeDir(): Promise<string> {
  const claudeDir = await makeTempDir();
  await mkdir(join(claudeDir, 'projects'));
  return claudeDir;
}

async function writeTranscript(
  claudeDir: string,
  project: string,
  file: string,
  lines: readonly string[],
  mtime?: Date,
): Promise<string> {
  const dir = join(claudeDir, 'projects', project);
  await mkdir(dir, { recursive: true });
  const full = join(dir, file);
  await writeFile(full, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
  if (mtime !== undefined) await utimes(full, mtime, mtime);
  return full;
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** Run `fn` with CLAUDE_CONFIG_DIR set to `value`, or unset when undefined. */
async function withConfigDirEnv(
  value: string | undefined,
  fn: () => void | Promise<void>,
): Promise<void> {
  const previous = process.env[CLAUDE_CONFIG_DIR_ENV];
  if (value === undefined) delete process.env[CLAUDE_CONFIG_DIR_ENV];
  else process.env[CLAUDE_CONFIG_DIR_ENV] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[CLAUDE_CONFIG_DIR_ENV];
    else process.env[CLAUDE_CONFIG_DIR_ENV] = previous;
  }
}

describe('claudeHomeDir', () => {
  it('defaults to <homeDir>/.claude', async () => {
    await withConfigDirEnv(undefined, () => {
      expect(claudeHomeDir('/home/ada')).toBe(join('/home/ada', '.claude'));
    });
  });

  it('prefers an explicit override over the environment', async () => {
    await withConfigDirEnv('/from/env', () => {
      expect(claudeHomeDir('/home/ada', '/custom/claude')).toBe(resolve('/custom/claude'));
    });
  });

  it('falls back to CLAUDE_CONFIG_DIR when no override is passed', async () => {
    await withConfigDirEnv('/from/env', () => {
      expect(claudeHomeDir('/home/ada')).toBe(resolve('/from/env'));
    });
  });

  it('ignores a blank override and a blank environment value', async () => {
    await withConfigDirEnv('   ', () => {
      expect(claudeHomeDir('/home/ada')).toBe(join('/home/ada', '.claude'));
      expect(claudeHomeDir('/home/ada', '  ')).toBe(join('/home/ada', '.claude'));
    });
  });

  it('expands a leading ~ in the override against homeDir', async () => {
    await withConfigDirEnv(undefined, () => {
      expect(claudeHomeDir('/home/ada', '~/elsewhere')).toBe(
        resolve(join('/home/ada', 'elsewhere')),
      );
      expect(claudeHomeDir('/home/ada', '~')).toBe(resolve('/home/ada'));
    });
  });
});

describe('listTranscripts', () => {
  it('returns [] when the Claude directory does not exist', async () => {
    const parent = await makeTempDir();
    await expect(listTranscripts(join(parent, 'nope'))).resolves.toEqual([]);
  });

  it('returns [] when projects/ exists but is empty', async () => {
    const claudeDir = await makeClaudeDir();
    await expect(listTranscripts(claudeDir)).resolves.toEqual([]);
  });

  it('finds one transcript in each of two project directories', async () => {
    const claudeDir = await makeClaudeDir();
    const a = await writeTranscript(claudeDir, '-home-ada-alpha', 'aaa.jsonl', ['{"a":1}']);
    const b = await writeTranscript(claudeDir, 'l--Open-Source-beta', 'bbb.jsonl', ['{"b":2}']);

    const found = await listTranscripts(claudeDir);

    expect(found).toEqual([a, b].sort());
  });

  it('ignores everything that is not a *.jsonl file', async () => {
    const claudeDir = await makeClaudeDir();
    const keep = await writeTranscript(claudeDir, 'proj', 'session.jsonl', ['{"ok":true}']);
    const projectDir = join(claudeDir, 'projects', 'proj');
    // Nothing below may ever be opened: no secrets, no dotfiles, no bare ext.
    await writeFile(join(projectDir, '.credentials.json'), '{"token":"nope"}', 'utf8');
    await writeFile(join(projectDir, 'agent.key'), 'nope', 'utf8');
    await writeFile(join(projectDir, 'notes.txt'), 'nope', 'utf8');
    await writeFile(join(projectDir, '.jsonl'), 'nope', 'utf8');
    // A loose file directly under projects/ is not a transcript either.
    await writeFile(join(claudeDir, 'projects', 'stray.jsonl'), '{"stray":true}', 'utf8');
    // A directory that merely looks like a transcript.
    await mkdir(join(projectDir, 'decoy.jsonl'));

    await expect(listTranscripts(claudeDir)).resolves.toEqual([keep]);
  });

  it('accepts an uppercase extension', async () => {
    const claudeDir = await makeClaudeDir();
    const upper = await writeTranscript(claudeDir, 'proj', 'SESSION.JSONL', ['{"u":1}']);

    await expect(listTranscripts(claudeDir)).resolves.toEqual([upper]);
  });

  it('skips files older than opts.since and keeps the boundary', async () => {
    const claudeDir = await makeClaudeDir();
    const stale = await writeTranscript(claudeDir, 'proj-a', 'stale.jsonl', ['{}'], OLD_MTIME);
    const fresh = await writeTranscript(claudeDir, 'proj-a', 'fresh.jsonl', ['{}'], NEW_MTIME);
    const exact = await writeTranscript(claudeDir, 'proj-b', 'exact.jsonl', ['{}'], CUTOFF);

    const all = await listTranscripts(claudeDir);
    expect(all).toEqual([stale, fresh, exact].sort());

    const recent = await listTranscripts(claudeDir, { since: CUTOFF });
    expect(recent).toEqual([fresh, exact].sort());
    expect(recent).not.toContain(stale);

    const none = await listTranscripts(claudeDir, { since: new Date('2030-01-01T00:00:00.000Z') });
    expect(none).toEqual([]);
  });

  it('treats an invalid since as no filter rather than hiding everything', async () => {
    const claudeDir = await makeClaudeDir();
    const file = await writeTranscript(claudeDir, 'proj', 'a.jsonl', ['{}'], OLD_MTIME);

    await expect(listTranscripts(claudeDir, { since: new Date(Number.NaN) })).resolves.toEqual([
      file,
    ]);
  });

  it('returns a sorted, stable list', async () => {
    const claudeDir = await makeClaudeDir();
    await writeTranscript(claudeDir, 'zeta', 'z.jsonl', ['{}']);
    await writeTranscript(claudeDir, 'alpha', 'a.jsonl', ['{}']);
    await writeTranscript(claudeDir, 'alpha', 'b.jsonl', ['{}']);

    const first = await listTranscripts(claudeDir);
    const second = await listTranscripts(claudeDir);

    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
    expect(first).toHaveLength(3);
  });
});

describe('streamLines', () => {
  it('yields each non-blank line in order', async () => {
    const claudeDir = await makeClaudeDir();
    const file = await writeTranscript(claudeDir, 'proj', 'a.jsonl', [
      '{"type":"assistant","n":1}',
      '',
      '   ',
      '{"type":"assistant","n":2}',
    ]);

    await expect(collect(streamLines(file))).resolves.toEqual([
      '{"type":"assistant","n":1}',
      '{"type":"assistant","n":2}',
    ]);
  });

  it('handles CRLF endings, a BOM, and a missing trailing newline', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'crlf.jsonl');
    await writeFile(file, '\uFEFF{"a":1}\r\n{"b":2}\r\n{"c":3}', 'utf8');

    await expect(collect(streamLines(file))).resolves.toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
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

  it('stops cleanly when the consumer breaks out early', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'big.jsonl');
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
    const file = join(dir, 'many.jsonl');
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
});

describe('decodeProjectDir', () => {
  it('restores a Windows drive prefix', () => {
    expect(decodeProjectDir('l--Open-Source-quota-monitor')).toBe(
      'l:\\Open\\Source\\quota\\monitor',
    );
    expect(decodeProjectDir('C--Users-ada-src')).toBe('C:\\Users\\ada\\src');
  });

  it('restores a POSIX absolute path', () => {
    expect(decodeProjectDir('-home-ada-src-widget')).toBe('/home/ada/src/widget');
  });

  it('collapses runs of dashes, which encode adjacent punctuation', () => {
    expect(decodeProjectDir('-home-ada--config-app')).toBe('/home/ada/config/app');
  });

  it('leaves a relative-looking name as slash-joined segments', () => {
    expect(decodeProjectDir('home-ada')).toBe('home/ada');
    expect(decodeProjectDir('single')).toBe('single');
  });

  it('returns an empty string for an empty name', () => {
    expect(decodeProjectDir('')).toBe('');
  });

  it('is lossy: spaces and literal hyphens are indistinguishable', () => {
    // "l:\Open Source\quota-monitor" and "l:\Open\Source\quota\monitor" both
    // mangle to the same directory name, so the decode cannot recover either.
    const mangled = 'l--Open-Source-quota-monitor';
    expect(decodeProjectDir(mangled)).not.toBe('l:\\Open Source\\quota-monitor');
    expect(decodeProjectDir(mangled)).toBe('l:\\Open\\Source\\quota\\monitor');
  });
});

/* -------------------------------------------------------------------------- */
/* regressions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The real subagent line at
 * projects/l--Open-Source-frameforge/82087e29-.../subagents/workflows/
 *   wf_0a765196-414/agent-a20beb8bee51569a8.jsonl
 * with the content blocks elided. Real, billable assistant usage that a
 * one-level scan never sees.
 */
const SUBAGENT_LINE =
  '{"type":"assistant","timestamp":"2026-09-01T04:43:17.337Z","requestId":"req_011Cec6nH7EgqNfUpiWiCEWJ","message":{"id":"msg_011Cec6nJP8pWzbyrnrv9Fde","role":"assistant","model":"claude-opus-5","usage":{"input_tokens":2,"cache_creation_input_tokens":247711,"output_tokens":26069,"output_tokens_details":{"thinking_tokens":6966}}}}';

describe('listTranscripts (regression: nested subagent transcripts)', () => {
  it('descends into the <session-uuid>/subagents/workflows/<wf> layout', async () => {
    const claudeDir = await makeClaudeDir();

    // The exact on-disk shape: a session transcript beside a directory named
    // for the same session, holding the subagent transcripts it spawned.
    const top = await writeTranscript(
      claudeDir,
      'l--Open-Source-frameforge',
      '82087e29-8809-4b9a-b10e-a2a8f7444051.jsonl',
      ['{"type":"assistant"}'],
    );
    const nestedDir = join(
      claudeDir,
      'projects',
      'l--Open-Source-frameforge',
      '82087e29-8809-4b9a-b10e-a2a8f7444051',
      'subagents',
      'workflows',
      'wf_0a765196-414',
    );
    await mkdir(nestedDir, { recursive: true });
    const nested = join(nestedDir, 'agent-a20beb8bee51569a8.jsonl');
    await writeFile(nested, `${SUBAGENT_LINE}\n`, 'utf8');

    const found = await listTranscripts(claudeDir);

    expect(found).toContain(nested);
    expect(found).toEqual([top, nested].sort());
  });

  it('applies the mtime filter to nested transcripts too', async () => {
    const claudeDir = await makeClaudeDir();
    const deepDir = join(claudeDir, 'projects', 'proj', 'sess', 'subagents');
    await mkdir(deepDir, { recursive: true });

    const stale = join(deepDir, 'stale.jsonl');
    await writeFile(stale, '{}\n', 'utf8');
    await utimes(stale, OLD_MTIME, OLD_MTIME);

    const fresh = join(deepDir, 'fresh.jsonl');
    await writeFile(fresh, '{}\n', 'utf8');
    await utimes(fresh, NEW_MTIME, NEW_MTIME);

    await expect(listTranscripts(claudeDir, { since: CUTOFF })).resolves.toEqual([fresh]);
  });

  it('still refuses a loose *.jsonl sitting directly under projects/', async () => {
    // The walk starts inside a project directory, so widening it must not
    // widen what counts as a project.
    const claudeDir = await makeClaudeDir();
    await writeFile(join(claudeDir, 'projects', 'stray.jsonl'), '{"stray":true}', 'utf8');

    await expect(listTranscripts(claudeDir)).resolves.toEqual([]);
  });

  it('does not enter hidden directories or open non-transcripts below them', async () => {
    const claudeDir = await makeClaudeDir();
    const keep = await writeTranscript(claudeDir, 'proj', 'session.jsonl', ['{}']);
    const hidden = join(claudeDir, 'projects', 'proj', '.secrets');
    await mkdir(hidden, { recursive: true });
    await writeFile(join(hidden, 'stash.jsonl'), '{"token":"nope"}', 'utf8');
    const deep = join(claudeDir, 'projects', 'proj', 'sub');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, '.credentials.json'), '{"token":"nope"}', 'utf8');
    await writeFile(join(deep, 'agent.key'), 'nope', 'utf8');

    await expect(listTranscripts(claudeDir)).resolves.toEqual([keep]);
  });

  it('stops descending at a bounded depth', async () => {
    const claudeDir = await makeClaudeDir();
    // Eight levels below the project directory is reachable; the ninth is not.
    const levels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const reachable = join(claudeDir, 'projects', 'proj', ...levels);
    await mkdir(reachable, { recursive: true });
    const deepest = join(reachable, 'ok.jsonl');
    await writeFile(deepest, '{}', 'utf8');

    const tooDeep = join(reachable, 'i');
    await mkdir(tooDeep, { recursive: true });
    const beyond = join(tooDeep, 'nope.jsonl');
    await writeFile(beyond, '{}', 'utf8');

    const found = await listTranscripts(claudeDir);
    expect(found).toContain(deepest);
    expect(found).not.toContain(beyond);
  });
});

describe('streamLines (regression: an unbounded line and a partial read)', () => {
  it('reports a clean read to end of file', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'clean.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n', 'utf8');

    const status = newStreamStatus();
    await expect(collect(streamLines(file, status))).resolves.toEqual(['{"a":1}', '{"b":2}']);
    expect(status).toEqual({ complete: true, reason: null, oversizedLines: 0 });
  });

  it('reports a file it could not open at all', async () => {
    const dir = await makeTempDir();
    const status = newStreamStatus();

    await expect(collect(streamLines(join(dir, 'gone.jsonl'), status))).resolves.toEqual([]);
    expect(status.complete).toBe(false);
    expect(status.reason).not.toBeNull();
  });

  it('leaves complete false when the consumer stops early', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'early.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":3}\n', 'utf8');

    const status = newStreamStatus();
    for await (const line of streamLines(file, status)) {
      expect(line).toBe('{"a":1}');
      break;
    }

    expect(status.complete).toBe(false);
  });

  it('drops a line past the cap, counts it, and keeps reading the file', async () => {
    // A torn append, or one record carrying a very large inline attachment.
    // Before the cap this became one string as long as the file, and past
    // ~512 MB V8 throws a RangeError that is not an fs error code, so the
    // whole transcript was lost rather than the one line.
    const dir = await makeTempDir();
    const file = join(dir, 'torn.jsonl');
    const monster = `{"pad":"${'x'.repeat(MAX_LINE_LENGTH)}"}`;
    expect(monster.length).toBeGreaterThan(MAX_LINE_LENGTH);
    await writeFile(file, `{"a":1}\n${monster}\n{"b":2}\n`, 'utf8');

    const status = newStreamStatus();
    const seen = await collect(streamLines(file, status));

    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
    expect(status.oversizedLines).toBe(1);
    // Read to the end, but not all of it made it out: the caller must be able
    // to see that and say so.
    expect(status.complete).toBe(true);
  }, 30_000);

  it('counts an oversized final line with no trailing newline', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'torn-tail.jsonl');
    await writeFile(file, `{"a":1}\n{"pad":"${'x'.repeat(MAX_LINE_LENGTH)}"}`, 'utf8');

    const status = newStreamStatus();
    const seen = await collect(streamLines(file, status));

    expect(seen).toEqual(['{"a":1}']);
    expect(status.oversizedLines).toBe(1);
  }, 30_000);

  it('keeps a line just under the cap', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'big-but-fine.jsonl');
    // Comfortably above the largest real line on disk (1,359,550 bytes).
    const pad = 'x'.repeat(4 * 1024 * 1024);
    await writeFile(file, `{"pad":"${pad}"}\n`, 'utf8');

    const status = newStreamStatus();
    const seen = await collect(streamLines(file, status));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`{"pad":"${pad}"}`);
    expect(status.oversizedLines).toBe(0);
    expect(status.complete).toBe(true);
  }, 30_000);

  it('says so when a skippable error stops the read part way through', async () => {
    // EBUSY or EACCES on Windows against a transcript Claude Code is actively
    // appending to. The generator yields a valid prefix and then simply ends,
    // so without a status the caller sums 40,000 of 90,000 lines and reports
    // it as a complete count.
    const dir = await makeTempDir();
    const file = join(dir, 'locked.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":3}\n', 'utf8');

    await withReadStream(
      () =>
        failingStream(['{"a":1}\n', '{"b":2}\n'], Object.assign(new Error('EBUSY: resource busy'), {
          code: 'EBUSY',
        })),
      async () => {
        const status = newStreamStatus();
        const seen = await collect(streamLines(file, status));

        expect(seen).toEqual(['{"a":1}', '{"b":2}']);
        expect(status.complete).toBe(false);
        expect(status.reason).toContain('EBUSY');
      },
    );
  });

  it('still rethrows an error that is not a skippable fs error', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'broken.jsonl');
    await writeFile(file, '{"a":1}\n', 'utf8');

    await withReadStream(
      () => failingStream(['{"a":1}\n'], new Error('decoder blew up')),
      async () => {
        await expect(collect(streamLines(file))).rejects.toThrow('decoder blew up');
      },
    );
  });
});
