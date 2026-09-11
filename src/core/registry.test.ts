import { describe, expect, it } from 'vitest';

import { AdapterRegistry, collect, createRegistry } from './registry.js';
import { MemorySecretStore } from './secrets.js';

import type { AdapterContext, QuotaAdapter, QuotaReading } from './types.js';

/** Fixed instant. Nothing in this file may consult the wall clock. */
const NOW = new Date('2026-09-11T03:00:00.000Z');

function makeContext(options: Record<string, unknown> = {}): AdapterContext {
  return {
    now: () => NOW,
    homeDir: '/home/test',
    options,
    secrets: new MemorySecretStore(),
    debug: () => {},
  };
}

function reading(provider: string, used = 1): QuotaReading {
  return {
    provider,
    label: 'Test',
    window: 'session',
    used,
    limit: 10,
    unit: 'tokens',
    windowStart: NOW.toISOString(),
    resetsAt: NOW.toISOString(),
    confidence: 'derived',
  };
}

interface FakeOptions {
  detect?: boolean | (() => boolean | Promise<boolean>);
  read?: () => QuotaReading[] | Promise<QuotaReading[]>;
}

function fake(id: string, opts: FakeOptions = {}): QuotaAdapter {
  const detect = opts.detect ?? true;
  return {
    id,
    displayName: id,
    detect: async () => (typeof detect === 'function' ? detect() : detect),
    read: async () => (opts.read === undefined ? [reading(id)] : opts.read()),
  };
}

describe('AdapterRegistry', () => {
  it('holds adapters and returns them in registration order', () => {
    const registry = new AdapterRegistry();
    registry.register(fake('b')).register(fake('a')).register(fake('c'));

    expect(registry.ids()).toEqual(['b', 'a', 'c']);
    expect(registry.size).toBe(3);
    expect(registry.list().map((a) => a.id)).toEqual(['b', 'a', 'c']);
  });

  it('is iterable, so it can be handed straight to collect', () => {
    const registry = createRegistry([fake('a'), fake('b')]);
    expect([...registry].map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('gets and tests membership by id', () => {
    const adapter = fake('a');
    const registry = createRegistry([adapter]);

    expect(registry.get('a')).toBe(adapter);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.has('a')).toBe(true);
    expect(registry.has('missing')).toBe(false);
  });

  it('replaces an adapter in place, keeping its position', () => {
    const registry = createRegistry([fake('a'), fake('b'), fake('c')]);
    const replacement = fake('b');
    registry.register(replacement);

    expect(registry.ids()).toEqual(['a', 'b', 'c']);
    expect(registry.get('b')).toBe(replacement);
  });

  it('removes and clears', () => {
    const registry = createRegistry([fake('a'), fake('b')]);

    expect(registry.remove('a')).toBe(true);
    expect(registry.remove('a')).toBe(false);
    expect(registry.ids()).toEqual(['b']);

    registry.clear();
    expect(registry.size).toBe(0);
  });

  it('returns a fresh array from list(), so a caller cannot mutate the registry', () => {
    const registry = createRegistry([fake('a')]);
    registry.list().push(fake('b'));
    expect(registry.ids()).toEqual(['a']);
  });

  it('rejects a malformed adapter loudly - that is a wiring bug, not bad data', () => {
    const registry = new AdapterRegistry();

    expect(() => registry.register({} as unknown as QuotaAdapter)).toThrow(TypeError);
    expect(() => registry.register({ ...fake('a'), id: '' })).toThrow(/id/);
    expect(() => registry.register({ ...fake('a'), displayName: '' })).toThrow(/displayName/);
    expect(() =>
      registry.register({ ...fake('a'), detect: undefined } as unknown as QuotaAdapter),
    ).toThrow(/detect/);
    expect(() =>
      registry.register({ ...fake('a'), read: null } as unknown as QuotaAdapter),
    ).toThrow(/read/);
    expect(registry.size).toBe(0);
  });

  describe('enabled', () => {
    it('filters out providers switched off in config', () => {
      const registry = createRegistry([fake('a'), fake('b'), fake('c')]);
      const enabled = registry.enabled({
        a: { enabled: true },
        b: { enabled: false },
        c: { enabled: true },
      });
      expect(enabled.map((x) => x.id)).toEqual(['a', 'c']);
    });

    it('treats an adapter missing from config as enabled', () => {
      const registry = createRegistry([fake('brand-new')]);
      expect(registry.enabled({}).map((x) => x.id)).toEqual(['brand-new']);
    });
  });
});

describe('collect', () => {
  it('returns one result per adapter, in input order', async () => {
    const results = await collect([fake('a'), fake('b')], makeContext());

    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('returns an empty array for no adapters', async () => {
    expect(await collect([], makeContext())).toEqual([]);
  });

  it('carries the readings through untouched', async () => {
    const only = reading('a', 42);
    const results = await collect([fake('a', { read: () => [only] })], makeContext());

    expect(results[0]).toEqual({ ok: true, id: 'a', readings: [only] });
  });

  it('runs adapters concurrently', async () => {
    // Each adapter blocks until BOTH have started. Sequential execution would
    // deadlock and time the test out, which is exactly the regression signal.
    let release = (): void => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;

    const gated = (id: string): QuotaAdapter =>
      fake(id, {
        read: async () => {
          started += 1;
          if (started === 2) release();
          await barrier;
          return [reading(id)];
        },
      });

    const results = await collect([gated('a'), gated('b')], makeContext());
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(started).toBe(2);
  });

  it('reports an undetected adapter as ok with no readings, and never calls read', async () => {
    let readCalled = false;
    const adapter = fake('absent', {
      detect: false,
      read: () => {
        readCalled = true;
        return [];
      },
    });

    const results = await collect([adapter], makeContext());

    expect(results[0]).toEqual({ ok: true, id: 'absent', readings: [] });
    expect(readCalled).toBe(false);
  });

  it('treats a non-boolean detect() as "not detected" rather than truthy', async () => {
    const adapter: QuotaAdapter = {
      ...fake('weird'),
      detect: async () => 'yes' as unknown as boolean,
    };
    const results = await collect([adapter], makeContext());
    expect(results[0]).toEqual({ ok: true, id: 'weird', readings: [] });
  });

  it('catches a throw from detect and names which half failed', async () => {
    const adapter: QuotaAdapter = {
      ...fake('boom'),
      detect: async () => {
        throw new Error('disk on fire');
      },
    };

    const results = await collect([adapter], makeContext());

    expect(results[0]).toEqual({
      ok: false,
      id: 'boom',
      error: 'detect() failed: disk on fire',
    });
  });

  it('catches a throw from read', async () => {
    const results = await collect(
      [
        fake('boom', {
          read: () => {
            throw new Error('bad transcript');
          },
        }),
      ],
      makeContext(),
    );

    expect(results[0]).toEqual({ ok: false, id: 'boom', error: 'read() failed: bad transcript' });
  });

  it('catches a rejected read', async () => {
    const adapter: QuotaAdapter = {
      ...fake('boom'),
      read: async () => Promise.reject(new Error('async blew up')),
    };

    const results = await collect([adapter], makeContext());
    expect(results[0]).toMatchObject({ ok: false, id: 'boom' });
    expect(results[0]?.ok === false && results[0].error).toContain('async blew up');
  });

  it('catches a thrown non-Error', async () => {
    const adapter: QuotaAdapter = {
      ...fake('rude'),
      read: async () => {
        throw 'just a string';
      },
    };

    const results = await collect([adapter], makeContext());
    expect(results[0]).toEqual({ ok: false, id: 'rude', error: 'read() failed: just a string' });
  });

  it('flattens a multi-line error onto one line', async () => {
    const adapter: QuotaAdapter = {
      ...fake('multi'),
      read: async () => {
        throw new Error('line one\n  line two');
      },
    };

    const results = await collect([adapter], makeContext());
    expect(results[0]?.ok === false && results[0].error).toBe('read() failed: line one line two');
  });

  it('truncates an enormous error', async () => {
    const adapter: QuotaAdapter = {
      ...fake('long'),
      read: async () => {
        throw new Error('x'.repeat(5000));
      },
    };

    const results = await collect([adapter], makeContext());
    const error = results[0]?.ok === false ? results[0].error : '';
    expect(error.length).toBeLessThanOrEqual(520);
    expect(error.endsWith('...')).toBe(true);
  });

  it('fails the adapter when read() does not return an array', async () => {
    const adapter: QuotaAdapter = {
      ...fake('wrong'),
      read: async () => ({ nope: true }) as unknown as QuotaReading[],
    };

    const results = await collect([adapter], makeContext());
    expect(results[0]).toEqual({
      ok: false,
      id: 'wrong',
      error: 'read() did not return an array of readings',
    });
  });

  it('drops junk entries inside an otherwise good readings array', async () => {
    const good = reading('messy');
    const adapter = fake('messy', {
      read: () => [good, null as unknown as QuotaReading, 'nope' as unknown as QuotaReading],
    });

    const results = await collect([adapter], makeContext());
    expect(results[0]).toEqual({ ok: true, id: 'messy', readings: [good] });
  });

  it('fails only the broken adapter, never the batch', async () => {
    const results = await collect(
      [
        fake('good-1'),
        fake('bad', {
          read: () => {
            throw new Error('nope');
          },
        }),
        fake('good-2'),
      ],
      makeContext(),
    );

    expect(results.map((r) => [r.id, r.ok])).toEqual([
      ['good-1', true],
      ['bad', false],
      ['good-2', true],
    ]);
  });

  it('reports a malformed adapter without taking down its neighbours', async () => {
    const broken = { id: 'broken', displayName: 'Broken' } as unknown as QuotaAdapter;
    const results = await collect([broken, fake('fine')], makeContext());

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.id).toBe('broken');
    expect(results[1]?.ok).toBe(true);
  });

  describe('context factory', () => {
    it('hands each adapter its own options slice', async () => {
      const seen = new Map<string, unknown>();
      const spy = (id: string): QuotaAdapter =>
        fake(id, {
          read: () => [reading(id)],
        });

      const providers: Record<string, Record<string, unknown>> = {
        a: { enabled: true, plan: 'pro' },
        b: { enabled: true, plan: 'max-20x' },
      };

      const recording = (id: string): QuotaAdapter => {
        const base = spy(id);
        return {
          ...base,
          read: async (ctx) => {
            seen.set(id, ctx.options['plan']);
            return [reading(id)];
          },
        };
      };

      await collect([recording('a'), recording('b')], (adapter) => ({
        now: () => NOW,
        homeDir: '/home/test',
        options: providers[adapter.id] ?? { enabled: true },
        secrets: new MemorySecretStore(),
        debug: () => {},
      }));

      expect(seen.get('a')).toBe('pro');
      expect(seen.get('b')).toBe('max-20x');
    });

    it('contains a throwing factory', async () => {
      const results = await collect([fake('a')], () => {
        throw new Error('no config for you');
      });

      expect(results[0]).toEqual({
        ok: false,
        id: 'a',
        error: 'building the adapter context failed: no config for you',
      });
    });
  });

  it('passes a shared context straight through when given one', async () => {
    const ctx = makeContext({ shared: true });
    let seen: unknown;
    const adapter: QuotaAdapter = {
      ...fake('a'),
      read: async (received) => {
        seen = received;
        return [];
      },
    };

    await collect([adapter], ctx);
    expect(seen).toBe(ctx);
  });
});
