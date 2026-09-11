import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CONFIG_ENV_VAR,
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  parseConfig,
} from './config.js';
import type { ProviderOptions, QuotaConfig } from './config.js';

/** YAML is whitespace-sensitive, so build documents from explicit lines. */
function yaml(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function providerOf(config: QuotaConfig, id: string): ProviderOptions {
  const entry = config.providers[id];
  if (entry === undefined) throw new Error(`expected a "${id}" provider entry`);
  return entry;
}

const savedEnv = process.env[CONFIG_ENV_VAR];

afterEach(() => {
  if (savedEnv === undefined) delete process.env[CONFIG_ENV_VAR];
  else process.env[CONFIG_ENV_VAR] = savedEnv;
});

describe('configPath', () => {
  const home = join('/home', 'ada');

  it('defaults to <home>/.config/quota-monitor/config.yaml', () => {
    delete process.env[CONFIG_ENV_VAR];
    expect(configPath(home)).toBe(join(home, '.config', 'quota-monitor', 'config.yaml'));
  });

  it('honours an explicit override', () => {
    delete process.env[CONFIG_ENV_VAR];
    const override = join('/etc', 'quota-monitor', 'other.yaml');
    expect(configPath(home, override)).toBe(override);
  });

  it(`honours $${CONFIG_ENV_VAR}`, () => {
    const fromEnv = join('/srv', 'quota.yaml');
    process.env[CONFIG_ENV_VAR] = fromEnv;
    expect(configPath(home)).toBe(fromEnv);
  });

  it('prefers an explicit override over the environment variable', () => {
    process.env[CONFIG_ENV_VAR] = join('/srv', 'from-env.yaml');
    const override = join('/srv', 'from-flag.yaml');
    expect(configPath(home, override)).toBe(override);
  });

  it('ignores a blank override', () => {
    delete process.env[CONFIG_ENV_VAR];
    expect(configPath(home, '   ')).toBe(join(home, '.config', 'quota-monitor', 'config.yaml'));
  });
});

describe('parseConfig', () => {
  it('returns the defaults for an empty document, with no warnings', () => {
    const { config, warnings } = parseConfig('');

    expect(warnings).toEqual([]);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config).not.toBe(DEFAULT_CONFIG);
  });

  it('treats whitespace and comment-only documents as empty', () => {
    for (const raw of ['   \n\t\n', '# nothing to see here\n']) {
      const { config, warnings } = parseConfig(raw);
      expect(warnings).toEqual([]);
      expect(config).toEqual(DEFAULT_CONFIG);
    }
  });

  it('merges a valid document over the defaults', () => {
    const { config, warnings } = parseConfig(
      yaml(
        'refreshSeconds: 120',
        'alerts:',
        '  warn: 60',
        '  critical: 85',
        'widget:',
        '  ascii: true',
        '  width: 72',
        'providers:',
        '  claude-code:',
        '    enabled: true',
        '    plan: max20x',
        '  codex:',
        '    enabled: false',
      ),
    );

    expect(warnings).toEqual([]);
    expect(config.refreshSeconds).toBe(120);
    expect(config.alerts).toEqual({ warn: 60, critical: 85 });
    expect(config.widget).toEqual({ ascii: true, width: 72 });

    const claude = providerOf(config, 'claude-code');
    expect(claude.enabled).toBe(true);
    expect(claude['plan']).toBe('max20x');
    expect(providerOf(config, 'codex').enabled).toBe(false);

    // Providers the document never mentioned keep their defaults.
    expect(providerOf(config, 'devin').enabled).toBe(false);
    expect(providerOf(config, 'copilot').enabled).toBe(false);
  });

  it('accepts "refresh", the documented spelling, without warning', () => {
    // Regression: the parser only knew `refreshSeconds`, so the shipped and
    // documented `refresh: 60s` was rejected as an unknown key. The warning
    // then rendered inside the desktop widget, which spent every launch
    // complaining about its own default configuration.
    for (const line of ['refresh: 60s', 'refresh: 5m', 'refresh: 90']) {
      const { warnings } = parseConfig(yaml(line));
      expect(warnings, `for ${line}`).toEqual([]);
    }

    expect(parseConfig(yaml('refresh: 5m')).config.refreshSeconds).toBe(300);
    expect(parseConfig(yaml('refresh: 90')).config.refreshSeconds).toBe(90);
    // The field-name spelling keeps working; neither is deprecated.
    expect(parseConfig(yaml('refreshSeconds: 120')).config.refreshSeconds).toBe(120);
  });

  it('warns about an unknown key and keeps going', () => {
    const { config, warnings } = parseConfig(yaml('refreshSeconds: 30', 'colour: purple'));

    expect(config.refreshSeconds).toBe(30);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('colour');
    expect(warnings[0]).toContain('unknown key');
  });

  it('warns about unknown keys inside a known section', () => {
    const { warnings } = parseConfig(yaml('widget:', '  colour: purple'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('widget.colour');
  });

  /*
   * widget.mode belongs to the desktop shell, not to this renderer, but both
   * read one config file. The CLI must therefore accept the key without
   * calling it unknown, and must still catch a typo in it.
   */
  it('accepts widget.mode, which only the desktop widget acts on', () => {
    for (const mode of ['strip', 'tray', 'both', 'Both']) {
      const { warnings } = parseConfig(yaml('widget:', `  mode: ${mode}`));
      expect(warnings).toEqual([]);
    }
  });

  it('warns about an unusable widget.mode', () => {
    const { warnings } = parseConfig(yaml('widget:', '  mode: sideways'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('widget.mode');
    expect(warnings[0]).toContain('both');
  });

  /* widget.dock is the desktop shell's too: which edge the widget lives on. */
  it('accepts widget.dock, which only the desktop widget acts on', () => {
    for (const dock of ['left', 'right', 'top', 'bottom', 'Bottom']) {
      const { warnings } = parseConfig(yaml('widget:', `  dock: ${dock}`));
      expect(warnings).toEqual([]);
    }
  });

  it('warns about an unusable widget.dock', () => {
    const { warnings } = parseConfig(yaml('widget:', '  dock: middle'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('widget.dock');
    expect(warnings[0]).toContain('right');
  });

  it('reports mode and dock independently', () => {
    const { warnings } = parseConfig(yaml('widget:', '  mode: sideways', '  dock: top'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('widget.mode');
  });

  it('falls back to the default and names the key on a wrong-typed value', () => {
    const { config, warnings } = parseConfig(
      yaml(
        'refreshSeconds: true',
        'alerts:',
        '  warn: high',
        'widget:',
        '  ascii: sometimes',
        '  width: -5',
      ),
    );

    expect(config.refreshSeconds).toBe(DEFAULT_CONFIG.refreshSeconds);
    expect(config.alerts.warn).toBe(DEFAULT_CONFIG.alerts.warn);
    expect(config.widget.ascii).toBe(DEFAULT_CONFIG.widget.ascii);
    expect(config.widget.width).toBe(DEFAULT_CONFIG.widget.width);

    const joined = warnings.join('\n');
    expect(joined).toContain('refreshSeconds');
    expect(joined).toContain('alerts.warn');
    expect(joined).toContain('widget.ascii');
    expect(joined).toContain('widget.width');
  });

  it('warns but never throws on malformed YAML', () => {
    const { config, warnings } = parseConfig('refreshSeconds: [1, 2\nproviders: {');

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not valid YAML');
  });

  it('warns when the document is not a mapping', () => {
    const { config, warnings } = parseConfig(yaml('- one', '- two'));

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings[0]).toContain('top level');
  });

  describe('refresh formats', () => {
    it('accepts seconds with a suffix', () => {
      const { config, warnings } = parseConfig(yaml('refreshSeconds: 60s'));
      expect(config.refreshSeconds).toBe(60);
      expect(warnings).toEqual([]);
    });

    it('accepts minutes', () => {
      const { config, warnings } = parseConfig(yaml('refreshSeconds: 5m'));
      expect(config.refreshSeconds).toBe(300);
      expect(warnings).toEqual([]);
    });

    it('accepts a bare number of seconds', () => {
      const { config, warnings } = parseConfig(yaml('refreshSeconds: 45'));
      expect(config.refreshSeconds).toBe(45);
      expect(warnings).toEqual([]);
    });

    it('accepts hours and a quoted number', () => {
      expect(parseConfig(yaml('refreshSeconds: 2h')).config.refreshSeconds).toBe(7200);
      expect(parseConfig(yaml("refreshSeconds: '90'")).config.refreshSeconds).toBe(90);
    });

    it('rejects a nonsense duration', () => {
      const { config, warnings } = parseConfig(yaml('refreshSeconds: 5 parsecs'));
      expect(config.refreshSeconds).toBe(DEFAULT_CONFIG.refreshSeconds);
      expect(warnings[0]).toContain('refreshSeconds');
    });

    it('rejects zero and negative refreshes', () => {
      expect(parseConfig(yaml('refreshSeconds: 0')).config.refreshSeconds).toBe(60);
      expect(parseConfig(yaml('refreshSeconds: -30')).config.refreshSeconds).toBe(60);
    });
  });

  describe('inline secrets', () => {
    it('drops an inline secret, keeps an env reference, and says to use the keychain', () => {
      const { config, warnings } = parseConfig(
        yaml(
          'providers:',
          '  claude-code:',
          '    enabled: true',
          '    apiKey: sk-ant-totally-not-real-0123456789',
          '    sessionToken: "$CLAUDE_SESSION"',
          '    refreshToken: "${CLAUDE_REFRESH}"',
          '    useKeychain: true',
          '    plan: max20x',
        ),
      );

      const claude = providerOf(config, 'claude-code');
      expect(claude).not.toHaveProperty('apiKey');
      expect(claude['sessionToken']).toBe('$CLAUDE_SESSION');
      expect(claude['refreshToken']).toBe('${CLAUDE_REFRESH}');
      expect(claude['useKeychain']).toBe(true);
      expect(claude['plan']).toBe('max20x');
      expect(claude.enabled).toBe(true);

      const joined = warnings.join('\n');
      expect(warnings).toHaveLength(1);
      expect(joined).toContain('providers.claude-code.apiKey');
      expect(joined).toMatch(/keychain/i);
      // The whole point: the secret must not survive anywhere, warnings included.
      expect(joined).not.toContain('sk-ant-totally-not-real-0123456789');
      expect(JSON.stringify(config)).not.toContain('sk-ant-totally-not-real-0123456789');
    });

    it('drops secrets nested inside provider options', () => {
      const { config, warnings } = parseConfig(
        yaml(
          'providers:',
          '  copilot:',
          '    enabled: true',
          '    auth:',
          '      user: ada',
          '      password: hunter2',
        ),
      );

      const auth = providerOf(config, 'copilot')['auth'];
      expect(auth).toEqual({ user: 'ada' });
      expect(warnings[0]).toContain('providers.copilot.auth.password');
      expect(JSON.stringify(config)).not.toContain('hunter2');
    });

    it('drops a top-level inline secret', () => {
      const { config, warnings } = parseConfig(yaml('apiToken: abcd-1234-secret-value'));

      expect(config).toEqual(DEFAULT_CONFIG);
      expect(warnings[0]).toContain('apiToken');
      expect(warnings[0]).toMatch(/keychain/i);
      expect(warnings[0]).not.toContain('abcd-1234-secret-value');
    });
  });

  describe('providers', () => {
    it('keeps defaults for a provider with an empty body', () => {
      const { config, warnings } = parseConfig(yaml('providers:', '  codex:'));

      expect(providerOf(config, 'codex').enabled).toBe(true);
      expect(warnings).toEqual([]);
    });

    it('accepts the boolean shorthand', () => {
      const { config, warnings } = parseConfig(yaml('providers:', '  codex: false'));

      expect(providerOf(config, 'codex').enabled).toBe(false);
      expect(warnings).toEqual([]);
    });

    it('warns about an unrecognised provider id but keeps the entry', () => {
      const { config, warnings } = parseConfig(
        yaml('providers:', '  claude_code:', '    enabled: false'),
      );

      expect(providerOf(config, 'claude_code').enabled).toBe(false);
      expect(warnings[0]).toContain('claude_code');
    });

    it('warns and keeps the default when enabled is not a boolean', () => {
      const { config, warnings } = parseConfig(
        yaml('providers:', '  devin:', '    enabled: yes please'),
      );

      expect(providerOf(config, 'devin').enabled).toBe(DEFAULT_CONFIG.providers['devin']?.enabled);
      expect(warnings[0]).toContain('providers.devin.enabled');
    });
  });

  it('warns when warn is above critical', () => {
    const { config, warnings } = parseConfig(yaml('alerts:', '  warn: 95', '  critical: 80'));

    expect(config.alerts).toEqual({ warn: 95, critical: 80 });
    expect(warnings.join('\n')).toContain('alerts.warn');
  });

  it('never mutates DEFAULT_CONFIG', () => {
    parseConfig(
      yaml(
        'refreshSeconds: 5m',
        'widget:',
        '  width: 100',
        'providers:',
        '  codex:',
        '    enabled: false',
      ),
    );

    expect(DEFAULT_CONFIG.refreshSeconds).toBe(60);
    expect(DEFAULT_CONFIG.widget.width).toBe(48);
    expect(DEFAULT_CONFIG.providers['codex']?.enabled).toBe(true);
  });
});

describe('loadConfig', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'quota-monitor-config-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the defaults when no config file exists', async () => {
    delete process.env[CONFIG_ENV_VAR];
    const home = join(dir, 'empty-home');

    const result = await loadConfig(home);

    expect(result.existed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.path).toBe(join(home, '.config', 'quota-monitor', 'config.yaml'));
  });

  it('reads and parses the file named by an override', async () => {
    delete process.env[CONFIG_ENV_VAR];
    const file = join(dir, 'override.yaml');
    await writeFile(file, yaml('refreshSeconds: 5m', 'widget:', '  ascii: true'), 'utf8');

    const result = await loadConfig(join(dir, 'empty-home'), file);

    expect(result.existed).toBe(true);
    expect(result.path).toBe(file);
    expect(result.warnings).toEqual([]);
    expect(result.config.refreshSeconds).toBe(300);
    expect(result.config.widget.ascii).toBe(true);
  });

  it('reads the file named by the environment variable and surfaces its warnings', async () => {
    const file = join(dir, 'from-env.yaml');
    await writeFile(file, yaml('refreshSeconds: 30', 'colour: purple'), 'utf8');
    process.env[CONFIG_ENV_VAR] = file;

    const result = await loadConfig(join(dir, 'empty-home'));

    expect(result.existed).toBe(true);
    expect(result.path).toBe(file);
    expect(result.config.refreshSeconds).toBe(30);
    expect(result.warnings.join('\n')).toContain('colour');
  });
});
