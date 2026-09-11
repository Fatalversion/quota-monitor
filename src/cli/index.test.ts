import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  VERSION_STAMP,
  barWidthFor,
  builtinAdapters,
  parseArgs,
  run,
} from './index.js';

import type { CliEnvironment } from './index.js';
import type { QuotaAdapter, QuotaReading } from '../core/types.js';

/** Fixed instant. Nothing in this file may consult the wall clock. */
const NOW = new Date('2026-09-11T03:00:00.000Z');

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-monitor-cli-'));
  created.push(dir);
  return dir;
}

/**
 * A config path that does not exist, so `loadConfig` returns the shipped
 * defaults. Passing it explicitly also stops an ambient $QUOTA_MONITOR_CONFIG
 * on the machine running these tests from reaching the CLI.
 */
const NO_CONFIG = join(tmpdir(), 'quota-monitor-no-such-config-4b1c.yaml');

function reading(overrides: Partial<QuotaReading> = {}): QuotaReading {
  return {
    provider: 'fake',
    label: 'Test plan',
    window: 'session',
    used: 50,
    limit: 100,
    unit: 'tokens',
    windowStart: '2026-09-11T00:00:00.000Z',
    resetsAt: '2026-09-11T05:00:00.000Z',
    confidence: 'derived',
    ...overrides,
  };
}

function fakeAdapter(id: string, readings: QuotaReading[]): QuotaAdapter {
  return {
    id,
    displayName: id,
    detect: async () => true,
    read: async (ctx) => {
      ctx.debug(`${id}: debug line`);
      return readings;
    },
  };
}

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function invoke(
  argv: readonly string[],
  overrides: Partial<CliEnvironment> = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];

  const code = await run(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => NOW,
    homeDir: '/home/test',
    env: {},
    colorCapable: false,
    adapters: [fakeAdapter('fake', [reading()])],
    ...overrides,
  });

  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('parseArgs', () => {
  it('defaults everything off', () => {
    const parsed = parseArgs([]);
    expect(parsed).toEqual({
      ok: true,
      options: {
        json: false,
        ascii: false,
        verbose: false,
        help: false,
        version: false,
        color: undefined,
        width: undefined,
        config: undefined,
      },
    });
  });

  it('reads the boolean flags', () => {
    const parsed = parseArgs(['--json', '--ascii', '--verbose']);
    expect(parsed.ok && parsed.options.json).toBe(true);
    expect(parsed.ok && parsed.options.ascii).toBe(true);
    expect(parsed.ok && parsed.options.verbose).toBe(true);
  });

  it('accepts the short aliases', () => {
    const verbose = parseArgs(['-v']);
    expect(verbose.ok && verbose.options.verbose).toBe(true);

    const help = parseArgs(['-h']);
    expect(help.ok && help.options.help).toBe(true);

    const version = parseArgs(['-V']);
    expect(version.ok && version.options.version).toBe(true);
  });

  it('reads --width in both spellings', () => {
    const spaced = parseArgs(['--width', '30']);
    expect(spaced.ok && spaced.options.width).toBe(30);

    const inline = parseArgs(['--width=30']);
    expect(inline.ok && inline.options.width).toBe(30);
  });

  it('reads --config in both spellings', () => {
    const spaced = parseArgs(['--config', '/etc/quota.yaml']);
    expect(spaced.ok && spaced.options.config).toBe('/etc/quota.yaml');

    const inline = parseArgs(['--config=/etc/quota.yaml']);
    expect(inline.ok && inline.options.config).toBe('/etc/quota.yaml');
  });

  it('keeps an "=" inside a config path', () => {
    const parsed = parseArgs(['--config=/tmp/a=b.yaml']);
    expect(parsed.ok && parsed.options.config).toBe('/tmp/a=b.yaml');
  });

  it('handles the colour flags', () => {
    const on = parseArgs(['--color']);
    expect(on.ok && on.options.color).toBe(true);

    const off = parseArgs(['--no-color']);
    expect(off.ok && off.options.color).toBe(false);
  });

  it('rejects an unknown option rather than ignoring a typo', () => {
    expect(parseArgs(['--jsno'])).toEqual({ ok: false, error: 'unknown option "--jsno"' });
  });

  it('rejects a stray positional argument', () => {
    expect(parseArgs(['report'])).toEqual({ ok: false, error: 'unexpected argument "report"' });
  });

  it('rejects a value attached to a boolean flag', () => {
    expect(parseArgs(['--json=yes'])).toEqual({ ok: false, error: '--json takes no value' });
  });

  it('rejects a missing or malformed --width', () => {
    expect(parseArgs(['--width'])).toMatchObject({ ok: false });
    expect(parseArgs(['--width', 'wide'])).toMatchObject({ ok: false });
    expect(parseArgs(['--width', '4'])).toMatchObject({ ok: false });
    expect(parseArgs(['--width', '4000'])).toMatchObject({ ok: false });
    expect(parseArgs(['--width', '30.5'])).toMatchObject({ ok: false });
  });

  it('rejects a missing --config path', () => {
    expect(parseArgs(['--config'])).toEqual({ ok: false, error: '--config needs a path' });
  });

  it('treats everything after -- as a positional, and so as an error', () => {
    expect(parseArgs(['--', '--json'])).toEqual({
      ok: false,
      error: 'unexpected argument "--json"',
    });
  });

  it('does not swallow the next flag as a value', () => {
    expect(parseArgs(['--width', '--json'])).toMatchObject({ ok: false });
  });
});

describe('barWidthFor', () => {
  it('reproduces the renderer default at the default config width', () => {
    expect(barWidthFor(48)).toBe(14);
  });

  it('clamps to a usable range', () => {
    expect(barWidthFor(20)).toBe(6);
    expect(barWidthFor(400)).toBe(60);
    expect(barWidthFor(Number.NaN)).toBe(6);
  });
});

describe('builtinAdapters', () => {
  it('ships the Claude Code and Codex adapters, in display order', () => {
    expect(builtinAdapters().map((a) => a.id)).toEqual(['claude-code', 'codex']);
  });

  it('uses ids that the shipped config knows about, so neither is a stranger', () => {
    for (const adapter of builtinAdapters()) {
      expect(DEFAULT_CONFIG.providers).toHaveProperty(adapter.id);
      expect(DEFAULT_CONFIG.providers[adapter.id]?.enabled).toBe(true);
    }
  });
});

describe('run', () => {
  it('prints help and exits 0', async () => {
    const { code, out } = await invoke(['--help']);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('Usage: quota');
    expect(out).toContain('--json');
    expect(out).toContain('no network calls');
  });

  it('prints the package version and exits 0', async () => {
    const { code, out } = await invoke(['--version']);
    expect(code).toBe(EXIT_OK);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prefers the build-time version stamp, so the SEA binary is not "unknown"', async () => {
    // The single-file sidecar has no package.json to read; scripts/lib/bundle.mjs
    // stamps the version onto this global instead.
    const globals = globalThis as Record<string, unknown>;
    const before = globals[VERSION_STAMP];
    globals[VERSION_STAMP] = '9.9.9-stamped';
    try {
      const { code, out } = await invoke(['--version']);
      expect(code).toBe(EXIT_OK);
      expect(out.trim()).toBe('9.9.9-stamped');
    } finally {
      if (before === undefined) delete globals[VERSION_STAMP];
      else globals[VERSION_STAMP] = before;
    }
  });

  it('exits 1 on a usage error and points at --help', async () => {
    const { code, out, err } = await invoke(['--nope']);
    expect(code).toBe(EXIT_FAILURE);
    expect(out).toBe('');
    expect(err).toContain('unknown option "--nope"');
    expect(err).toContain('--help');
  });

  it('renders a row per reading', async () => {
    const { code, out } = await invoke(['--config', NO_CONFIG]);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('fake session');
    expect(out).toContain('Test plan');
    // Derived denominators always carry the '~'.
    expect(out).toContain('~50%');
  });

  it('renders a provider-reported percentage with no ~ and no used/limit pair', async () => {
    // End to end for the distinction the whole library turns on: Codex hands
    // us OpenAI's own used_percent, so the row must not be dressed as an
    // estimate of ours.
    const reported = reading({
      provider: 'codex',
      label: 'Plus',
      used: 42.7,
      limit: 100,
      unit: 'percent',
      confidence: 'reported',
    });
    const { code, out } = await invoke(['--config', NO_CONFIG], {
      adapters: [fakeAdapter('codex', [reported])],
    });
    expect(code).toBe(EXIT_OK);
    expect(out).toContain(' 42%');
    expect(out).not.toContain('~');
    expect(out).not.toContain('/100');
    expect(out).not.toContain('percent');
  });

  it('explains both kinds of percentage in --help', async () => {
    const { out } = await invoke(['--help']);
    expect(out).toContain('A "~" before a percentage means the denominator is our estimate');
    expect(out).toContain('came from the provider itself');
    expect(out).toContain('only move when you next run Codex');
  });

  it('emits no ANSI escapes when the terminal is not colour capable', async () => {
    const { out } = await invoke(['--config', NO_CONFIG]);
    expect(out).not.toContain(String.fromCharCode(27));
  });

  it('honours --ascii', async () => {
    const { out } = await invoke(['--ascii', '--config', NO_CONFIG]);
    expect(out).toContain('#');
    expect(out).not.toContain('█');
  });

  it('exits 0 and prints a failed row when an adapter throws', async () => {
    const broken: QuotaAdapter = {
      id: 'broken',
      displayName: 'Broken',
      detect: async () => true,
      read: async () => {
        throw new Error('transcripts unreadable');
      },
    };

    const { code, out } = await invoke(['--config', NO_CONFIG], { adapters: [broken] });

    expect(code).toBe(EXIT_OK);
    expect(out).toContain('failed:');
    expect(out).toContain('transcripts unreadable');
  });

  it('says so, helpfully, when nothing reported any usage', async () => {
    const idle = fakeAdapter('idle', []);
    const { code, out } = await invoke(['--config', NO_CONFIG], { adapters: [idle] });

    expect(code).toBe(EXIT_OK);
    expect(out).toContain('no usage found');
    expect(out).toContain('--verbose');
  });

  it('reports when no provider is enabled at all', async () => {
    const { out } = await invoke(['--config', NO_CONFIG], { adapters: [] });
    expect(out).toContain('no providers enabled');
  });

  it('shows idle providers under --verbose', async () => {
    const idle = fakeAdapter('idle', []);
    const { out } = await invoke(['--verbose', '--config', NO_CONFIG], { adapters: [idle] });
    expect(out).toContain('idle');
    expect(out).toContain('no data');
  });

  it('keeps notes out of normal output and shows them under --verbose', async () => {
    const noted = fakeAdapter('fake', [reading({ note: 'denominator came from the plan table' })]);

    const quiet = await invoke(['--config', NO_CONFIG], { adapters: [noted] });
    expect(quiet.out).not.toContain('denominator came from');

    const loud = await invoke(['--verbose', '--config', NO_CONFIG], { adapters: [noted] });
    expect(loud.out).toContain('denominator came from the plan table');
  });

  it('routes adapter debug output to stderr, and only under --verbose', async () => {
    const quiet = await invoke(['--config', NO_CONFIG]);
    expect(quiet.err).not.toContain('debug line');

    const loud = await invoke(['--verbose', '--config', NO_CONFIG]);
    expect(loud.err).toContain('fake: debug line');
    expect(loud.out).not.toContain('debug line');
  });

  it('gives each adapter its own slice of the config', async () => {
    const dir = await makeTempDir();
    const configFile = join(dir, 'config.yaml');
    await writeFile(
      configFile,
      ['providers:', '  fake:', '    plan: max-20x', '  other:', '    plan: pro', ''].join('\n'),
      'utf8',
    );

    const seen: Record<string, unknown> = {};
    const spy = (id: string): QuotaAdapter => ({
      id,
      displayName: id,
      detect: async () => true,
      read: async (ctx) => {
        seen[id] = ctx.options['plan'];
        return [];
      },
    });

    await invoke(['--config', configFile], { adapters: [spy('fake'), spy('other')] });

    expect(seen['fake']).toBe('max-20x');
    expect(seen['other']).toBe('pro');
  });

  it('skips a provider disabled in config', async () => {
    const dir = await makeTempDir();
    const configFile = join(dir, 'config.yaml');
    await writeFile(configFile, ['providers:', '  fake: false', ''].join('\n'), 'utf8');

    let ran = false;
    const adapter: QuotaAdapter = {
      id: 'fake',
      displayName: 'fake',
      detect: async () => {
        ran = true;
        return true;
      },
      read: async () => [],
    };

    const { out } = await invoke(['--config', configFile], { adapters: [adapter] });

    expect(ran).toBe(false);
    expect(out).toContain('no providers enabled');
  });

  it('summarises config warnings without printing them, then prints them under --verbose', async () => {
    const dir = await makeTempDir();
    const configFile = join(dir, 'config.yaml');
    await writeFile(configFile, 'nonsenseKey: 1\n', 'utf8');

    const quiet = await invoke(['--config', configFile]);
    expect(quiet.err).toContain('1 config warning');
    expect(quiet.err).toContain('--verbose');
    expect(quiet.err).not.toContain('nonsenseKey');

    const loud = await invoke(['--verbose', '--config', configFile]);
    expect(loud.err).toContain('nonsenseKey');
    expect(loud.err).toContain(configFile);
  });

  it('stays silent about a config file that simply is not there', async () => {
    const { err } = await invoke(['--config', NO_CONFIG]);
    expect(err).toBe('');
  });

  describe('--json', () => {
    it('emits a parseable envelope', async () => {
      const { code, out } = await invoke(['--json', '--config', NO_CONFIG]);
      expect(code).toBe(EXIT_OK);

      const payload: unknown = JSON.parse(out);
      expect(payload).toMatchObject({
        tool: 'quota-monitor',
        generatedAt: '2026-09-11T03:00:00.000Z',
        warnings: [],
        results: [
          {
            ok: true,
            id: 'fake',
            readings: [{ provider: 'fake', used: 50, limit: 100, confidence: 'derived' }],
          },
        ],
      });
    });

    it('adds percentUsed beside the confidence that qualifies it', async () => {
      const { out } = await invoke(['--json', '--config', NO_CONFIG]);
      const payload = JSON.parse(out) as {
        results: Array<{ readings: Array<{ percentUsed: number | null; confidence: string }> }>;
      };

      expect(payload.results[0]?.readings[0]?.percentUsed).toBe(50);
      expect(payload.results[0]?.readings[0]?.confidence).toBe('derived');
    });

    it('reports percentUsed as null when the limit is unknown', async () => {
      const uncapped = fakeAdapter('fake', [reading({ limit: null })]);
      const { out } = await invoke(['--json', '--config', NO_CONFIG], { adapters: [uncapped] });
      const payload = JSON.parse(out) as {
        results: Array<{ readings: Array<{ percentUsed: number | null }> }>;
      };

      expect(payload.results[0]?.readings[0]?.percentUsed).toBeNull();
    });

    it('carries a failed adapter through as data, still exiting 0', async () => {
      const broken: QuotaAdapter = {
        id: 'broken',
        displayName: 'Broken',
        detect: async () => true,
        read: async () => {
          throw new Error('nope');
        },
      };

      const { code, out } = await invoke(['--json', '--config', NO_CONFIG], {
        adapters: [broken],
      });

      expect(code).toBe(EXIT_OK);
      const payload = JSON.parse(out) as { results: Array<{ ok: boolean; error?: string }> };
      expect(payload.results[0]?.ok).toBe(false);
      expect(payload.results[0]?.error).toContain('nope');
    });

    it('includes config warnings so a machine consumer can see them too', async () => {
      const dir = await makeTempDir();
      const configFile = join(dir, 'config.yaml');
      await writeFile(configFile, 'nonsenseKey: 1\n', 'utf8');

      const { out } = await invoke(['--json', '--config', configFile]);
      const payload = JSON.parse(out) as { warnings: string[] };
      expect(payload.warnings.join(' ')).toContain('nonsenseKey');
    });

    it('never colours JSON, even when asked to', async () => {
      const { out } = await invoke(['--json', '--color', '--config', NO_CONFIG]);
      expect(out).not.toContain(String.fromCharCode(27));
      expect(() => JSON.parse(out) as unknown).not.toThrow();
    });
  });

  describe('colour', () => {
    it('colours a TTY', async () => {
      const { out } = await invoke(['--config', NO_CONFIG], { colorCapable: true });
      expect(out).toContain(String.fromCharCode(27));
    });

    it('honours $NO_COLOR', async () => {
      const { out } = await invoke(['--config', NO_CONFIG], {
        colorCapable: true,
        env: { NO_COLOR: '1' },
      });
      expect(out).not.toContain(String.fromCharCode(27));
    });

    it('honours TERM=dumb', async () => {
      const { out } = await invoke(['--config', NO_CONFIG], {
        colorCapable: true,
        env: { TERM: 'dumb' },
      });
      expect(out).not.toContain(String.fromCharCode(27));
    });

    it('lets --no-color beat $FORCE_COLOR', async () => {
      const { out } = await invoke(['--no-color', '--config', NO_CONFIG], {
        colorCapable: true,
        env: { FORCE_COLOR: '1' },
      });
      expect(out).not.toContain(String.fromCharCode(27));
    });

    it('lets --color beat a non-TTY', async () => {
      const { out } = await invoke(['--color', '--config', NO_CONFIG], { colorCapable: false });
      expect(out).toContain(String.fromCharCode(27));
    });
  });

  it('widens the bar with --width', async () => {
    const narrow = await invoke(['--width', '20', '--ascii', '--config', NO_CONFIG]);
    const wide = await invoke(['--width', '200', '--ascii', '--config', NO_CONFIG]);

    const bars = (text: string): number => (text.match(/[#-]/g) ?? []).length;
    expect(bars(wide.out)).toBeGreaterThan(bars(narrow.out));
  });
});
