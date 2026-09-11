/**
 * Config loading.
 *
 * Two rules drive every decision in this file:
 *
 * 1. Fail soft. A config file is a convenience, not a contract. A missing file,
 *    an unparseable file, an unknown key or a wrong-typed value all degrade to
 *    the default value plus a warning string. Nothing in here throws.
 * 2. Never hold a secret. quota-monitor reads other tools' data; it must not
 *    become the place a credential leaks into. Any key that looks like a
 *    credential is dropped on the floor unless its value is an environment
 *    variable reference, and the dropped value is never echoed back in a
 *    warning.
 *
 * Warnings are returned, not printed - the CLI decides what to show.
 */

import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** One provider's slice of the config. Extra keys are adapter-specific. */
export type ProviderOptions = { enabled: boolean } & Record<string, unknown>;

export interface AlertThresholds {
  /** Percent used at which a reading turns amber. */
  warn: number;
  /** Percent used at which a reading turns red. */
  critical: number;
}

export interface WidgetConfig {
  /** Draw bars with plain ASCII instead of block-drawing characters. */
  ascii: boolean;
  /** Total render width in columns. */
  width: number;
}

export interface QuotaConfig {
  refreshSeconds: number;
  providers: Record<string, ProviderOptions>;
  alerts: AlertThresholds;
  widget: WidgetConfig;
}

/** Environment variable that relocates the config file. */
export const CONFIG_ENV_VAR = 'QUOTA_MONITOR_CONFIG';

const MIN_REFRESH_SECONDS = 1;
const MAX_REFRESH_SECONDS = 24 * 60 * 60;
const MIN_WIDTH = 20;
const MAX_WIDTH = 400;

/**
 * Window layouts the desktop widget knows how to run. The CLI only validates
 * this key; the shell in src-tauri is what acts on it.
 */
export const WIDGET_MODES = ['strip', 'tray', 'both'] as const;
export type WidgetMode = (typeof WIDGET_MODES)[number];
export const DEFAULT_WIDGET_MODE: WidgetMode = 'both';

function isWidgetMode(value: unknown): value is WidgetMode {
  return typeof value === 'string' && (WIDGET_MODES as readonly string[]).includes(value.trim().toLowerCase());
}

/**
 * Which screen edge the desktop widget docks to. The edge implies the shape:
 * left and right stand it up as a narrow rail, top and bottom lay it out as a
 * horizontal bar. Like `widget.mode`, this renderer never acts on it.
 */
export const WIDGET_DOCKS = ['left', 'right', 'top', 'bottom'] as const;
export type WidgetDock = (typeof WIDGET_DOCKS)[number];
export const DEFAULT_WIDGET_DOCK: WidgetDock = 'right';

function isWidgetDock(value: unknown): value is WidgetDock {
  return typeof value === 'string' && (WIDGET_DOCKS as readonly string[]).includes(value.trim().toLowerCase());
}

/**
 * The shipped defaults. Deep-frozen: `parseConfig` clones before it merges, so
 * a caller can never poison the baseline for the next call.
 */
export const DEFAULT_CONFIG: QuotaConfig = deepFreeze<QuotaConfig>({
  refreshSeconds: 60,
  providers: {
    'claude-code': { enabled: true },
    codex: { enabled: true },
    devin: { enabled: false },
    copilot: { enabled: false },
  },
  alerts: { warn: 70, critical: 90 },
  widget: { ascii: false, width: 48 },
});

/**
 * Where the config file lives.
 *
 * Precedence: explicit `override` argument, then $QUOTA_MONITOR_CONFIG, then
 * `<home>/.config/quota-monitor/config.yaml`. An override is used verbatim
 * (normalized only), so a relative path stays relative to the caller's cwd.
 */
export function configPath(homeDir: string, override?: string): string {
  const explicit = firstNonBlank(override, process.env[CONFIG_ENV_VAR]);
  if (explicit !== undefined) return normalize(explicit);
  return join(homeDir, '.config', 'quota-monitor', 'config.yaml');
}

/**
 * Parse a YAML config document and deep-merge it over {@link DEFAULT_CONFIG}.
 *
 * Never throws. Anything it cannot use becomes a warning naming the offending
 * key, and that key keeps its default.
 */
export function parseConfig(raw: string): { config: QuotaConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config = cloneDefaults();

  if (raw.trim() === '') return { config, warnings };

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    warnings.push(`config is not valid YAML (${messageOf(error)}); using defaults`);
    return { config, warnings };
  }

  // An all-comments document parses to null. That is not an error.
  if (parsed === null || parsed === undefined) return { config, warnings };

  if (!isPlainObject(parsed)) {
    warnings.push(
      `config: expected a mapping of settings at the top level, got ${describeValue(parsed)}; using defaults`,
    );
    return { config, warnings };
  }

  for (const [key, value] of Object.entries(parsed)) {
    switch (key) {
      // Both spellings, deliberately. `refresh` is the documented key and the
      // one people actually write, because the value carries its own unit
      // ("60s", "5m"); `refreshSeconds` matches the field name. Accepting only
      // the latter meant a correct, documented config produced an "unknown
      // key" warning that surfaced in the desktop widget as a permanent
      // complaint about itself.
      case 'refresh':
      case 'refreshSeconds':
        applyRefresh(value, config, warnings);
        break;
      case 'providers':
        applyProviders(value, config, warnings);
        break;
      case 'alerts':
        applyAlerts(value, config, warnings);
        break;
      case 'widget':
        applyWidget(value, config, warnings);
        break;
      default:
        if (isInlineSecret(key, value)) warnings.push(secretWarning(key, key));
        else warnings.push(`unknown key "${key}" ignored`);
        break;
    }
  }

  return { config, warnings };
}

export interface LoadedConfig {
  config: QuotaConfig;
  warnings: string[];
  /** The file we looked at, whether or not it was there. */
  path: string;
  /** False when no config file exists - that is the normal first run. */
  existed: boolean;
}

/**
 * Read and parse the config file. A missing file is not an error: you get the
 * defaults, no warnings, and `existed: false`.
 */
export async function loadConfig(homeDir: string, override?: string): Promise<LoadedConfig> {
  const file = configPath(homeDir, override);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT') {
      return { config: cloneDefaults(), warnings: [], path: file, existed: false };
    }
    return {
      config: cloneDefaults(),
      warnings: [`could not read ${file} (${messageOf(error)}); using defaults`],
      path: file,
      existed: false,
    };
  }

  const { config, warnings } = parseConfig(raw);
  return { config, warnings, path: file, existed: true };
}

/* -------------------------------------------------------------------------- */
/* section appliers                                                           */
/* -------------------------------------------------------------------------- */

function applyRefresh(value: unknown, config: QuotaConfig, warnings: string[]): void {
  const seconds = parseDurationSeconds(value);
  if (seconds === null) {
    warnings.push(
      `refreshSeconds: expected a positive number of seconds or a duration such as "60s" or "5m", ` +
        `got ${describeValue(value)}; using ${DEFAULT_CONFIG.refreshSeconds}`,
    );
    return;
  }
  if (seconds < MIN_REFRESH_SECONDS || seconds > MAX_REFRESH_SECONDS) {
    warnings.push(
      `refreshSeconds: ${seconds}s is outside the supported range ` +
        `${MIN_REFRESH_SECONDS}-${MAX_REFRESH_SECONDS}; using ${DEFAULT_CONFIG.refreshSeconds}`,
    );
    return;
  }
  config.refreshSeconds = seconds;
}

function applyAlerts(value: unknown, config: QuotaConfig, warnings: string[]): void {
  if (!isPlainObject(value)) {
    warnings.push(`alerts: expected a mapping, got ${describeValue(value)}; using defaults`);
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'warn' && key !== 'critical') {
      warnings.push(`unknown key "alerts.${key}" ignored`);
      continue;
    }
    const percent = parsePercent(entry);
    if (percent === null) {
      warnings.push(
        `alerts.${key}: expected a number between 0 and 100, got ${describeValue(entry)}; ` +
          `using ${DEFAULT_CONFIG.alerts[key]}`,
      );
      continue;
    }
    config.alerts[key] = percent;
  }

  if (config.alerts.warn > config.alerts.critical) {
    warnings.push(
      `alerts.warn (${config.alerts.warn}) is above alerts.critical (${config.alerts.critical}); ` +
        `nothing will ever be reported as merely warning`,
    );
  }
}

function applyWidget(value: unknown, config: QuotaConfig, warnings: string[]): void {
  if (!isPlainObject(value)) {
    warnings.push(`widget: expected a mapping, got ${describeValue(value)}; using defaults`);
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    switch (key) {
      case 'ascii':
        if (typeof entry === 'boolean') config.widget.ascii = entry;
        else {
          warnings.push(
            `widget.ascii: expected true or false, got ${describeValue(entry)}; ` +
              `using ${DEFAULT_CONFIG.widget.ascii}`,
          );
        }
        break;
      case 'mode':
        /*
         * Read by the desktop shell (src-tauri), never by this renderer: it
         * picks between the edge strip, the tray popover, or both. It is
         * matched here so the one config file both halves of the tool share
         * does not report a key the other half depends on as unknown - and so
         * a typo in it is caught by `quota --verbose` rather than silently
         * turning into the default at widget startup.
         */
        if (!isWidgetMode(entry)) {
          warnings.push(
            `widget.mode: expected ${WIDGET_MODES.join(', ')}, got ${describeValue(entry)}; ` +
              `the desktop widget will use ${DEFAULT_WIDGET_MODE}`,
          );
        }
        break;
      case 'dock':
        /*
         * Also the desktop shell's, and matched here for the same reason as
         * `mode`: one shared config file, so a key the other half depends on
         * must not be reported as unknown, and a typo in it should surface at
         * `quota --verbose` rather than silently becoming the default the
         * next time the widget starts.
         */
        if (!isWidgetDock(entry)) {
          warnings.push(
            `widget.dock: expected ${WIDGET_DOCKS.join(', ')}, got ${describeValue(entry)}; ` +
              `the desktop widget will use ${DEFAULT_WIDGET_DOCK}`,
          );
        }
        break;
      case 'width': {
        const width = parseIntegerInRange(entry, MIN_WIDTH, MAX_WIDTH);
        if (width === null) {
          warnings.push(
            `widget.width: expected a whole number of columns between ${MIN_WIDTH} and ${MAX_WIDTH}, ` +
              `got ${describeValue(entry)}; using ${DEFAULT_CONFIG.widget.width}`,
          );
        } else {
          config.widget.width = width;
        }
        break;
      }
      default:
        warnings.push(`unknown key "widget.${key}" ignored`);
        break;
    }
  }
}

function applyProviders(value: unknown, config: QuotaConfig, warnings: string[]): void {
  if (!isPlainObject(value)) {
    warnings.push(`providers: expected a mapping, got ${describeValue(value)}; using defaults`);
    return;
  }

  for (const [id, entry] of Object.entries(value)) {
    if (isReservedKey(id)) {
      warnings.push(`providers.${id}: ignored, "${id}" is a reserved property name`);
      continue;
    }

    const here = `providers.${id}`;
    const known = Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG.providers, id);
    if (!known) {
      warnings.push(
        `${here}: no adapter ships with the id "${id}"; the entry is kept in case a plugin provides one`,
      );
    }

    const current = config.providers[id];
    const base: ProviderOptions = current ?? { enabled: true };

    // `codex:` with an empty body means "leave it at the defaults".
    if (entry === null || entry === undefined) {
      config.providers[id] = base;
      continue;
    }

    // Shorthand: `codex: false` is the same as `codex: { enabled: false }`.
    if (typeof entry === 'boolean') {
      config.providers[id] = { ...base, enabled: entry };
      continue;
    }

    if (!isPlainObject(entry)) {
      warnings.push(`${here}: expected a mapping, got ${describeValue(entry)}; using defaults`);
      config.providers[id] = base;
      continue;
    }

    const { enabled: rawEnabled, ...rest } = entry;
    let enabled = base.enabled;
    if (rawEnabled !== undefined) {
      if (typeof rawEnabled === 'boolean') {
        enabled = rawEnabled;
      } else {
        warnings.push(
          `${here}.enabled: expected true or false, got ${describeValue(rawEnabled)}; using ${base.enabled}`,
        );
      }
    }

    const extras = sanitizeOptions(rest, here, warnings);
    config.providers[id] = { ...base, ...extras, enabled };
  }
}

/* -------------------------------------------------------------------------- */
/* secret hygiene                                                             */
/* -------------------------------------------------------------------------- */

const SECRET_KEY_PATTERN = /token|key|secret|password/i;
/** `$FOO` or `${FOO}` - a pointer to a credential, not the credential. */
const ENV_REFERENCE_PATTERN = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isEnvReference(value: unknown): boolean {
  return typeof value === 'string' && ENV_REFERENCE_PATTERN.test(value.trim());
}

/**
 * True when `key` names a credential and `value` carries one inline. Booleans
 * and empty values cannot hold a credential (`useKeychain: true` is a real
 * setting), and an environment variable reference is a pointer, not the thing.
 */
function isInlineSecret(key: string, value: unknown): boolean {
  if (!looksLikeSecretKey(key)) return false;
  if (typeof value === 'boolean' || value === null || value === undefined) return false;
  return !isEnvReference(value);
}

function secretWarning(keyPath: string, key: string): string {
  return (
    `${keyPath}: looks like an inline secret, so it was dropped and never loaded. ` +
    `Put credentials in your OS keychain, or point the key at an environment variable ` +
    `(${key}: $MY_TOKEN).`
  );
}

/**
 * Copy an adapter's option bag, minus anything that looks like a pasted-in
 * credential. Booleans and nulls under a secret-ish name are kept - they cannot
 * carry a credential and `useKeychain: true` is a legitimate setting.
 */
function sanitizeOptions(
  input: Record<string, unknown>,
  keyPath: string,
  warnings: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (isReservedKey(key)) {
      warnings.push(`${keyPath}.${key}: ignored, "${key}" is a reserved property name`);
      continue;
    }

    const here = `${keyPath}.${key}`;
    if (isInlineSecret(key, value)) {
      warnings.push(secretWarning(here, key));
      continue;
    }

    out[key] = sanitizeValue(value, here, warnings);
  }

  return out;
}

function sanitizeValue(value: unknown, keyPath: string, warnings: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown, index: number) =>
      sanitizeValue(item, `${keyPath}[${index}]`, warnings),
    );
  }
  if (isPlainObject(value)) return sanitizeOptions(value, keyPath, warnings);
  return value;
}

/* -------------------------------------------------------------------------- */
/* scalar coercion                                                            */
/* -------------------------------------------------------------------------- */

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i;

/**
 * Accepts a bare number of seconds (`60`, `"60"`) or a suffixed duration
 * (`"60s"`, `"5m"`, `"1h"`). Returns null for anything unusable.
 */
function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;

  const match = DURATION_PATTERN.exec(value.trim());
  if (match === null) return null;

  const amountText = match[1];
  if (amountText === undefined) return null;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const multiplier = secondsPerUnit(match[2] ?? '');
  if (multiplier === null) return null;

  return amount * multiplier;
}

function secondsPerUnit(unit: string): number | null {
  switch (unit.toLowerCase()) {
    case '':
    case 's':
    case 'sec':
    case 'secs':
    case 'second':
    case 'seconds':
      return 1;
    case 'm':
    case 'min':
    case 'mins':
    case 'minute':
    case 'minutes':
      return 60;
    case 'h':
    case 'hr':
    case 'hrs':
    case 'hour':
    case 'hours':
      return 3600;
    default:
      return null;
  }
}

/** A percentage, written `80` or `"80"` or `"80%"`. */
function parsePercent(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const text = value.trim().replace(/%$/, '').trim();
    if (text === '') return null;
    n = Number(text);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function parseIntegerInRange(value: unknown, min: number, max: number): number | null {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDefaults(): QuotaConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function firstNonBlank(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * A short, safe rendering of a rejected value for a warning message. Strings
 * are truncated; values under a secret-ish key never reach this function.
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'string': {
      const text = value.length > 30 ? `${value.slice(0, 30)}...` : value;
      return `the string ${JSON.stringify(text)}`;
    }
    case 'number':
    case 'bigint':
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      return 'a mapping';
    default:
      return typeof value;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
