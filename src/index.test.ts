/**
 * The barrel is the published API. `tsc` catches a re-export that points at
 * nothing; only a test catches one that quietly went missing, which is the
 * failure that breaks somebody else's import.
 */
import { describe, expect, it } from 'vitest';

import * as api from './index.js';

/** Every value the package promises to export. Removing one is a breaking change. */
const EXPECTED_VALUES = [
  // core contract
  'ZERO_TOKENS',
  'percentUsed',
  // windows
  'DEFAULT_SESSION_HOURS',
  'DEFAULT_WEEK_STARTS_ON',
  'activityAnchoredWindow',
  'eventsInWindow',
  'sumTokens',
  'windowBounds',
  // pricing
  'MODEL_PRICES',
  'estimateCostUsd',
  'priceFor',
  // config
  'CONFIG_ENV_VAR',
  'DEFAULT_CONFIG',
  'configPath',
  'loadConfig',
  'parseConfig',
  // secrets
  'MemorySecretStore',
  'NullSecretStore',
  'OsKeychainSecretStore',
  'defaultSecretStore',
  // registry
  'AdapterRegistry',
  'collect',
  'createRegistry',
  // rendering
  'DEFAULT_BAR_WIDTH',
  'bar',
  'formatCountdown',
  'formatPercent',
  'formatTokens',
  'formatUsd',
  'renderAll',
  'renderReading',
  // providers
  'CLAUDE_CODE_DISPLAY_NAME',
  'CLAUDE_CODE_PERCENT_LIMIT',
  'CLAUDE_CODE_PROVIDER_ID',
  'MAX_TRANSCRIPT_FILES',
  'claudeCodeAdapter',
  'formatStatusLine',
  'parseStatusLinePayload',
  'readRateLimitSnapshot',
  'recordStatusLine',
  'statusLineSnapshotPath',
  'PLANS',
  'PLAN_IDS',
  'assertPlanTableShape',
  'planFor',
  'coerceTokens',
  'parseLine',
  'CLAUDE_CONFIG_DIR_ENV',
  'claudeHomeDir',
  'decodeProjectDir',
  'listTranscripts',
  'streamLines',
  // providers - codex
  'CODEX_DISPLAY_NAME',
  'CODEX_PERCENT_LIMIT',
  'CODEX_PROVIDER_ID',
  'MAX_ROLLOUT_FILES',
  'codexAdapter',
  'parseRateLimitLine',
  'planLabel',
  'CODEX_HOME_ENV',
  'DEFAULT_ROLLOUT_LIMIT',
  'codexHomeDir',
  'listRollouts',
] as const;

describe('public API', () => {
  it.each(EXPECTED_VALUES)('exports %s', (name) => {
    expect(api).toHaveProperty(name);
    expect((api as Record<string, unknown>)[name]).toBeDefined();
  });

  it('exports nothing beyond the documented surface', () => {
    const actual = Object.keys(api).sort();
    expect(actual).toEqual([...EXPECTED_VALUES].sort());
  });

  it('exposes the Claude Code adapter ready to register', () => {
    const registry = api.createRegistry([api.claudeCodeAdapter]);
    expect(registry.ids()).toEqual(['claude-code']);
    expect(api.CLAUDE_CODE_PROVIDER_ID).toBe('claude-code');
  });

  it('exposes the Codex adapter ready to register', () => {
    const registry = api.createRegistry([api.codexAdapter]);
    expect(registry.ids()).toEqual(['codex']);
    expect(api.CODEX_PROVIDER_ID).toBe('codex');
    expect(api.CODEX_DISPLAY_NAME).toBe('Codex');
  });

  it('registers both built-in adapters side by side, in order', () => {
    const registry = api.createRegistry([api.claudeCodeAdapter, api.codexAdapter]);
    expect(registry.ids()).toEqual(['claude-code', 'codex']);
  });

  it('does not re-export a second streamLines - the codex one stays a deep import', async () => {
    // Two adapters both stream JSONL. Only the Claude Code reader is on the
    // barrel; a name collision here would silently hand callers the wrong one.
    expect(api.streamLines).toBe(
      (await import('./providers/claude-code/transcripts.js')).streamLines,
    );
  });

  it('does not re-export the CLI entry point - `quota` is the interface to that', () => {
    expect(api).not.toHaveProperty('run');
    expect(api).not.toHaveProperty('main');
    expect(api).not.toHaveProperty('parseArgs');
  });
});
