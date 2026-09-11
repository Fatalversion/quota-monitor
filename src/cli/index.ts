#!/usr/bin/env node
/**
 * The `quota` executable.
 *
 * Load config, build one `AdapterContext`, run every enabled adapter, print
 * the result. That is the whole program; the interesting work lives in the
 * modules it wires together.
 *
 * Three rules shape the details:
 *
 *  - NO DEPENDENCY. argv is parsed by hand below. A flag parser is not worth a
 *    supply chain.
 *  - NO NETWORK, NO TELEMETRY. Nothing in this file or anything it imports
 *    opens a socket. The only files read are the user's own config and, via
 *    the adapters, other tools' logs.
 *  - EXIT 0 UNLESS WE ARE BROKEN. A provider that failed is data, not a
 *    program error: it prints as a failed row and the exit code stays 0. Exit
 *    1 is reserved for a usage error or a crash - things where a script that
 *    called us cannot trust the output at all.
 *
 * `parseArgs` and `run` are exported so tests can drive the CLI without
 * spawning a process; `main` only fires when this file is the entry point.
 */

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../core/config.js';
import { collect, createRegistry } from '../core/registry.js';
import { defaultSecretStore } from '../core/secrets.js';
import { percentUsed } from '../core/types.js';
import { claudeCodeAdapter } from '../providers/claude-code/index.js';
import { codexAdapter } from '../providers/codex/index.js';
import { renderAll } from './render.js';

import type { AdapterResult, QuotaAdapter } from '../core/types.js';
import type { RenderOptions } from './render.js';

/** Everything went fine, including "a provider failed and we said so". */
export const EXIT_OK = 0;
/** Usage error, or a crash. The output cannot be trusted. */
export const EXIT_FAILURE = 1;

const PROGRAM = 'quota';

/** Used when package.json cannot be read. Never a made-up version number. */
const UNKNOWN_VERSION = 'unknown';

/** Config bounds, mirroring src/core/config.ts so `--width` and YAML agree. */
const MIN_WIDTH = 20;
const MAX_WIDTH = 400;

/**
 * Share of the total width given to the bar itself, the rest going to the
 * label, percentage and trailer. 48 columns x 0.29 rounds to 14, which is
 * `DEFAULT_BAR_WIDTH`, so the default config reproduces the renderer default.
 */
const BAR_SHARE = 0.29;
const MIN_BAR_WIDTH = 6;
const MAX_BAR_WIDTH = 60;

/* -------------------------------------------------------------------------- */
/* argument parsing                                                           */
/* -------------------------------------------------------------------------- */

export interface CliOptions {
  /** Emit a JSON envelope instead of the rendered widget. */
  json: boolean;
  /** Force ASCII bar glyphs. */
  ascii: boolean;
  /** Show notes, config warnings, adapter debug output and idle providers. */
  verbose: boolean;
  help: boolean;
  version: boolean;
  /** true/false force colour; undefined means "decide from the terminal". */
  color: boolean | undefined;
  /** Total render width in columns; undefined means "use the config value". */
  width: number | undefined;
  /** Config file path override; undefined means "use the default location". */
  config: string | undefined;
}

export type ParsedArgs =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string };

function emptyOptions(): CliOptions {
  return {
    json: false,
    ascii: false,
    verbose: false,
    help: false,
    version: false,
    color: undefined,
    width: undefined,
    config: undefined,
  };
}

/**
 * Parse argv (without `node` and the script path).
 *
 * Supports `--flag`, `--opt value` and `--opt=value`, plus `-h`, `-v`
 * (verbose) and `-V` (version). `--` ends option parsing. Unknown flags and
 * stray positional arguments are errors rather than being ignored: silently
 * swallowing a typo'd flag is how a user ends up believing they ran something
 * they did not.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options = emptyOptions();
  let sawTerminator = false;

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === undefined) continue;

    if (sawTerminator || !raw.startsWith('-') || raw === '-') {
      return { ok: false, error: `unexpected argument "${raw}"` };
    }

    if (raw === '--') {
      sawTerminator = true;
      continue;
    }

    // Split --opt=value once, so a value may itself contain '='.
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

    /** Take the inline value, else the next argv entry. */
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) return undefined;
      i += 1;
      return next;
    };

    const rejectInline = (): ParsedArgs | null =>
      inlineValue === undefined ? null : { ok: false, error: `${flag} takes no value` };

    switch (flag) {
      case '--json': {
        const bad = rejectInline();
        if (bad !== null) return bad;
        options.json = true;
        break;
      }
      case '--ascii': {
        const bad = rejectInline();
        if (bad !== null) return bad;
        options.ascii = true;
        break;
      }
      case '--verbose':
      case '-v': {
        const bad = rejectInline();
        if (bad !== null) return bad;
        options.verbose = true;
        break;
      }
      case '--help':
      case '-h': {
        options.help = true;
        break;
      }
      case '--version':
      case '-V': {
        options.version = true;
        break;
      }
      case '--color': {
        const bad = rejectInline();
        if (bad !== null) return bad;
        options.color = true;
        break;
      }
      case '--no-color': {
        const bad = rejectInline();
        if (bad !== null) return bad;
        options.color = false;
        break;
      }
      case '--width': {
        const value = takeValue();
        if (value === undefined) return { ok: false, error: '--width needs a number of columns' };
        const width = Number(value.trim());
        if (!Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
          return {
            ok: false,
            error: `--width must be a whole number between ${MIN_WIDTH} and ${MAX_WIDTH}, got "${value}"`,
          };
        }
        options.width = width;
        break;
      }
      case '--config': {
        const value = takeValue();
        if (value === undefined || value.trim() === '') {
          return { ok: false, error: '--config needs a path' };
        }
        options.config = value;
        break;
      }
      default:
        return { ok: false, error: `unknown option "${flag}"` };
    }
  }

  return { ok: true, options };
}

/* -------------------------------------------------------------------------- */
/* environment seam                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Everything the CLI touches outside its own logic. Injectable so tests never
 * write to the real stdout, read the real home directory, or ask the real
 * clock what time it is.
 */
export interface CliEnvironment {
  stdout(line: string): void;
  stderr(line: string): void;
  now(): Date;
  homeDir: string;
  env: Record<string, string | undefined>;
  /** Whether stdout is a terminal that can render colour. */
  colorCapable: boolean;
  /** Adapters to run. Defaults to the built-in set. */
  adapters: readonly QuotaAdapter[];
}

/**
 * The built-in adapters, in display order.
 *
 * Order is the display order and nothing else: `AdapterRegistry` preserves
 * registration order, so adding one here appends a row rather than shuffling
 * the existing ones. An adapter absent from the user's `providers` config is
 * treated as enabled, so a new entry appears for someone whose config predates
 * it instead of silently doing nothing.
 */
export function builtinAdapters(): QuotaAdapter[] {
  return [claudeCodeAdapter, codexAdapter];
}

function defaultEnvironment(): CliEnvironment {
  return {
    stdout: (line: string) => {
      process.stdout.write(line + '\n');
    },
    stderr: (line: string) => {
      process.stderr.write(line + '\n');
    },
    // The real clock. Deterministic tests inject their own.
    now: () => new Date(),
    homeDir: homedir(),
    env: process.env,
    colorCapable: process.stdout.isTTY === true,
    adapters: builtinAdapters(),
  };
}

function withDefaults(overrides?: Partial<CliEnvironment>): CliEnvironment {
  const base = defaultEnvironment();
  if (overrides === undefined) return base;
  return {
    stdout: overrides.stdout ?? base.stdout,
    stderr: overrides.stderr ?? base.stderr,
    now: overrides.now ?? base.now,
    homeDir: overrides.homeDir ?? base.homeDir,
    env: overrides.env ?? base.env,
    colorCapable: overrides.colorCapable ?? base.colorCapable,
    adapters: overrides.adapters ?? base.adapters,
  };
}

/* -------------------------------------------------------------------------- */
/* help and version                                                           */
/* -------------------------------------------------------------------------- */

function helpText(): string {
  return [
    `${PROGRAM} - how much of each AI coding subscription you have burned`,
    '',
    `Usage: ${PROGRAM} [options]`,
    '',
    'Options:',
    '  --json            print a JSON envelope instead of the widget',
    '  --ascii           draw bars with ASCII instead of block characters',
    '  -v, --verbose     show notes, config warnings and idle providers',
    '  --color           force colour on',
    '  --no-color        force colour off (also honours $NO_COLOR)',
    '  --width <cols>    total render width, ' + MIN_WIDTH + '-' + MAX_WIDTH + ' columns',
    '  --config <path>   read this config file instead of the default',
    '  -h, --help        show this help',
    '  -V, --version     print the version',
    '',
    'Reading the output:',
    '  A "~" before a percentage means the denominator is our estimate, not a',
    '  figure the provider published. Nothing in ~/.claude records a plan cap,',
    '  so every Claude Code percentage is derived from the plan table and from',
    '  whatever you set in config. Run with --verbose to see exactly where each',
    '  denominator came from, then override it with a limit you have measured.',
    '',
    '  A percentage with no "~" came from the provider itself. Codex records the',
    '  used_percent OpenAI puts in its rollout logs, so those rows are reported',
    '  rather than estimated - but they only move when you next run Codex. Use',
    '  --verbose to see how old the snapshot behind each one is.',
    '',
    'This tool is read-only, makes no network calls, and sends no telemetry.',
  ].join('\n');
}

/**
 * Global the single-executable build writes the version into.
 *
 * Nothing sets this in a normal run. See `readVersion` for why it exists.
 */
export const VERSION_STAMP = '__QUOTA_MONITOR_VERSION__';

/**
 * The published version.
 *
 * Normally read from package.json at runtime. Inside the single-file sidecar
 * binary there is no package.json on disk to read, so the build stamps the
 * version onto a global instead (scripts/lib/bundle.mjs). Without that the
 * shipped binary would honestly - and uselessly - report "unknown".
 */
async function readVersion(): Promise<string> {
  const stamped: unknown = (globalThis as Record<string, unknown>)[VERSION_STAMP];
  if (typeof stamped === 'string' && stamped.trim() !== '') return stamped.trim();

  try {
    const url = new URL('../../package.json', import.meta.url);
    const parsed: unknown = JSON.parse(await readFile(url, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const version: unknown = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version.trim() !== '') return version.trim();
    }
  } catch {
    // A missing or malformed package.json is not worth failing a run over.
  }
  return UNKNOWN_VERSION;
}

/* -------------------------------------------------------------------------- */
/* presentation helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Colour decision. `--color`/`--no-color` win; then $NO_COLOR (any non-empty
 * value disables, per the no-color.org convention); then $FORCE_COLOR; then
 * whether stdout is a terminal. JSON output is never coloured.
 */
function shouldUseColor(options: CliOptions, env: CliEnvironment): boolean {
  if (options.json) return false;
  if (options.color !== undefined) return options.color;

  const noColor = env.env['NO_COLOR'];
  if (typeof noColor === 'string' && noColor !== '') return false;

  const force = env.env['FORCE_COLOR'];
  if (typeof force === 'string' && force !== '' && force !== '0') return true;

  if (env.env['TERM'] === 'dumb') return false;
  return env.colorCapable;
}

/** Total columns -> bar columns. See BAR_SHARE. */
export function barWidthFor(totalColumns: number): number {
  if (!Number.isFinite(totalColumns)) return MIN_BAR_WIDTH;
  const scaled = Math.round(totalColumns * BAR_SHARE);
  return Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, scaled));
}

/**
 * The JSON envelope.
 *
 * Readings are emitted verbatim - they are the published contract - with one
 * added convenience field, `percentUsed`, which is null whenever the limit is
 * unknown. `confidence` sits right beside it, so a consumer can always tell
 * whether the denominator was ours.
 */
function jsonEnvelope(
  results: AdapterResult[],
  warnings: string[],
  version: string,
  now: Date,
): string {
  const payload = {
    tool: 'quota-monitor',
    version,
    generatedAt: now.toISOString(),
    warnings,
    results: results.map((result) =>
      result.ok
        ? {
            ok: true as const,
            id: result.id,
            readings: result.readings.map((reading) => ({
              ...reading,
              percentUsed: percentUsed(reading),
            })),
          }
        : { ok: false as const, id: result.id, error: result.error },
    ),
  };
  return JSON.stringify(payload, null, 2);
}

/* -------------------------------------------------------------------------- */
/* the run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run the CLI and return the process exit code. Never throws: an unexpected
 * error is reported on stderr and becomes EXIT_FAILURE.
 */
export async function run(
  argv: readonly string[],
  overrides?: Partial<CliEnvironment>,
): Promise<number> {
  const env = withDefaults(overrides);

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    env.stderr(`${PROGRAM}: ${parsed.error}`);
    env.stderr(`Try '${PROGRAM} --help'.`);
    return EXIT_FAILURE;
  }
  const options = parsed.options;

  if (options.help) {
    env.stdout(helpText());
    return EXIT_OK;
  }

  if (options.version) {
    env.stdout(await readVersion());
    return EXIT_OK;
  }

  try {
    return await report(options, env);
  } catch (error) {
    env.stderr(`${PROGRAM}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
}

async function report(options: CliOptions, env: CliEnvironment): Promise<number> {
  const loaded = await loadConfig(env.homeDir, options.config);
  const config = loaded.config;

  if (options.verbose) {
    env.stderr(
      `config: ${loaded.path}${loaded.existed ? '' : ' (not found, using defaults)'}`,
    );
    for (const warning of loaded.warnings) env.stderr(`config: ${warning}`);
  } else if (loaded.warnings.length > 0) {
    // Never silent about a config that is not doing what its author thinks -
    // dropped inline secrets show up here - but never noisy either.
    const count = loaded.warnings.length;
    env.stderr(
      `${PROGRAM}: ${count} config warning${count === 1 ? '' : 's'}; run with --verbose to see ${count === 1 ? 'it' : 'them'}`,
    );
  }

  const registry = createRegistry(env.adapters);
  const enabled = registry.enabled(config.providers);

  // One instant for the whole report. Two adapters must not land in different
  // session windows because the second one started a millisecond later.
  const now = env.now();
  const secrets = defaultSecretStore();
  const debug = options.verbose
    ? (message: string) => {
        env.stderr(message);
      }
    : () => {
        /* quiet unless asked */
      };

  const results = await collect(enabled, (adapter) => ({
    now: () => now,
    homeDir: env.homeDir,
    // Each adapter sees only its own slice of the config file.
    options: config.providers[adapter.id] ?? { enabled: true },
    secrets,
    debug,
  }));

  if (options.json) {
    env.stdout(jsonEnvelope(results, loaded.warnings, await readVersion(), now));
    return EXIT_OK;
  }

  // A detected-but-idle provider is a blank row in normal use and a real line
  // under --verbose, where "we looked and found nothing" is the answer wanted.
  const visible = options.verbose
    ? results
    : results.filter((result) => !result.ok || result.readings.length > 0);

  if (visible.length === 0) {
    env.stdout(emptyMessage(results.length, loaded.path));
    return EXIT_OK;
  }

  const renderOptions: RenderOptions = {
    width: barWidthFor(options.width ?? config.widget.width),
    ascii: options.ascii || config.widget.ascii,
    color: shouldUseColor(options, env),
    verbose: options.verbose,
  };

  env.stdout(renderAll(visible, now, renderOptions));
  return EXIT_OK;
}

function emptyMessage(checked: number, configPathUsed: string): string {
  if (checked === 0) {
    return `no providers enabled - check the "providers" section of ${configPathUsed}`;
  }
  return (
    `no usage found (${checked} provider${checked === 1 ? '' : 's'} checked) - ` +
    `run with --verbose to see why`
  );
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * True when this module was executed rather than imported.
 *
 * Both paths go through `realpath`: npm installs `bin` entries as symlinks, so
 * `process.argv[1]` is usually the link and `import.meta.url` is always the
 * target. Comparing them unresolved would mean the installed `quota` command
 * did nothing at all.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return resolve(entry) === resolve(self);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Set exitCode rather than calling process.exit(), which can truncate a
  // large --json payload still buffered in a pipe.
  process.exitCode = await run(argv);
}

if (isEntryPoint()) {
  void main();
}
