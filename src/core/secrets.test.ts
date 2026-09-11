import { describe, it, expect } from 'vitest';

import {
  MemorySecretStore,
  NullSecretStore,
  OsKeychainSecretStore,
  defaultSecretStore,
} from './secrets.js';

/**
 * Await a promise that is expected to reject and hand back the Error.
 * Fails loudly if it resolves instead, so a broken guard cannot pass silently.
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/** A value that must never show up in an error message or a key listing. */
const SECRET = 'sk-ant-do-not-leak-me';

describe('MemorySecretStore', () => {
  it('returns undefined for a key it does not hold', async () => {
    const store = new MemorySecretStore();
    await expect(store.get('anthropic.apiKey')).resolves.toBeUndefined();
  });

  it('round-trips a value through set and get', async () => {
    const store = new MemorySecretStore();
    await store.set('anthropic.apiKey', SECRET);
    await expect(store.get('anthropic.apiKey')).resolves.toBe(SECRET);
  });

  it('overwrites an existing key rather than appending', async () => {
    const store = new MemorySecretStore();
    await store.set('openai.apiKey', 'first');
    await store.set('openai.apiKey', 'second');
    await expect(store.get('openai.apiKey')).resolves.toBe('second');
    expect(store.size).toBe(1);
  });

  it('keeps keys independent of one another', async () => {
    const store = new MemorySecretStore();
    await store.set('a', '1');
    await store.set('b', '2');
    await expect(store.get('a')).resolves.toBe('1');
    await expect(store.get('b')).resolves.toBe('2');
    expect(store.size).toBe(2);
  });

  it('deletes a key it holds', async () => {
    const store = new MemorySecretStore();
    await store.set('devin.token', SECRET);
    await store.delete('devin.token');
    await expect(store.get('devin.token')).resolves.toBeUndefined();
    expect(store.has('devin.token')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('treats deleting an absent key as success', async () => {
    const store = new MemorySecretStore();
    await expect(store.delete('never.stored')).resolves.toBeUndefined();
  });

  it('seeds from a plain object', async () => {
    const store = new MemorySecretStore({ 'copilot.token': 'gho_x', 'devin.token': 'dv_y' });
    await expect(store.get('copilot.token')).resolves.toBe('gho_x');
    await expect(store.get('devin.token')).resolves.toBe('dv_y');
    expect(store.size).toBe(2);
  });

  it('seeds from an iterable of entries', async () => {
    const store = new MemorySecretStore(
      new Map([
        ['a', '1'],
        ['b', '2'],
      ]),
    );
    expect(store.keys()).toEqual(['a', 'b']);
    await expect(store.get('b')).resolves.toBe('2');
  });

  it('seeds from an array of tuples', async () => {
    const store = new MemorySecretStore([['a', '1']]);
    await expect(store.get('a')).resolves.toBe('1');
  });

  it('lists key names in insertion order and never exposes values in bulk', async () => {
    const store = new MemorySecretStore();
    await store.set('second', SECRET);
    await store.set('first', SECRET);
    expect(store.keys()).toEqual(['second', 'first']);
    expect(JSON.stringify(store.keys())).not.toContain(SECRET);
  });

  it('clears everything', async () => {
    const store = new MemorySecretStore({ a: '1', b: '2' });
    store.clear();
    expect(store.size).toBe(0);
    expect(store.keys()).toEqual([]);
    await expect(store.get('a')).resolves.toBeUndefined();
  });

  it('does not share state between instances', async () => {
    const one = new MemorySecretStore({ shared: 'one' });
    const two = new MemorySecretStore();
    await expect(two.get('shared')).resolves.toBeUndefined();
    await expect(one.get('shared')).resolves.toBe('one');
  });

  it('rejects an empty or blank key on every operation', async () => {
    const store = new MemorySecretStore();
    expect((await rejection(store.get(''))).message).toMatch(/non-empty string/);
    expect((await rejection(store.set('   ', SECRET))).message).toMatch(/non-empty string/);
    expect((await rejection(store.delete(''))).message).toMatch(/non-empty string/);
    expect(store.size).toBe(0);
  });

  it('rejects a blank key when seeding', () => {
    expect(() => new MemorySecretStore({ '': 'x' })).toThrow(/non-empty string/);
  });
});

describe('NullSecretStore', () => {
  it('reads as undefined for any key', async () => {
    const store = new NullSecretStore();
    await expect(store.get('anthropic.apiKey')).resolves.toBeUndefined();
    await expect(store.get('anything.else')).resolves.toBeUndefined();
  });

  it('refuses to write, citing that no keychain is configured', async () => {
    const store = new NullSecretStore();
    const err = await rejection(store.set('anthropic.apiKey', SECRET));
    expect(err.message).toContain('no keychain configured');
  });

  it('names the key but never the value in the write failure', async () => {
    const store = new NullSecretStore();
    const err = await rejection(store.set('anthropic.apiKey', SECRET));
    expect(err.message).toContain('anthropic.apiKey');
    expect(err.message).not.toContain(SECRET);
    expect(String(err.stack ?? '')).not.toContain(SECRET);
  });

  it('stays empty after a refused write', async () => {
    const store = new NullSecretStore();
    await rejection(store.set('anthropic.apiKey', SECRET));
    await expect(store.get('anthropic.apiKey')).resolves.toBeUndefined();
  });

  it('treats delete as a no-op that succeeds', async () => {
    const store = new NullSecretStore();
    await expect(store.delete('anthropic.apiKey')).resolves.toBeUndefined();
  });

  it('surfaces a caller-supplied reason on write', async () => {
    const store = new NullSecretStore('no keychain configured (running in CI)');
    expect(store.reason).toBe('no keychain configured (running in CI)');
    const err = await rejection(store.set('k', SECRET));
    expect(err.message).toContain('running in CI');
  });

  it('rejects an empty key on every operation', async () => {
    const store = new NullSecretStore();
    expect((await rejection(store.get(''))).message).toMatch(/non-empty string/);
    expect((await rejection(store.set('', SECRET))).message).toMatch(/non-empty string/);
    expect((await rejection(store.delete(''))).message).toMatch(/non-empty string/);
  });
});

describe('defaultSecretStore', () => {
  it('returns a non-writable store on every platform in v0.1', async () => {
    for (const platform of ['win32', 'darwin', 'linux', 'freebsd'] as const) {
      const store = defaultSecretStore(platform);
      await expect(store.get('anthropic.apiKey')).resolves.toBeUndefined();
      const err = await rejection(store.set('anthropic.apiKey', SECRET));
      expect(err.message).toContain('no keychain configured');
      expect(err.message).not.toContain(SECRET);
    }
  });

  it('names the tool each supported platform will use in v0.2', async () => {
    expect((await rejection(defaultSecretStore('win32').set('k', SECRET))).message).toContain(
      'Windows Credential Manager',
    );
    expect((await rejection(defaultSecretStore('darwin').set('k', SECRET))).message).toContain(
      '/usr/bin/security',
    );
    expect((await rejection(defaultSecretStore('linux').set('k', SECRET))).message).toContain(
      'secret-tool',
    );
  });

  it('says so plainly when a platform has no planned backend', async () => {
    const err = await rejection(defaultSecretStore('aix').set('k', SECRET));
    expect(err.message).toContain('no supported keychain backend');
    expect(err.message).toContain('aix');
  });

  it('defaults to the running platform without throwing', async () => {
    const store = defaultSecretStore();
    await expect(store.get('anthropic.apiKey')).resolves.toBeUndefined();
  });

  it('hands out a fresh store per call', () => {
    expect(defaultSecretStore('linux')).not.toBe(defaultSecretStore('linux'));
  });
});

describe('OsKeychainSecretStore', () => {
  it('throws "not implemented in v0.1" from every operation', async () => {
    const store = new OsKeychainSecretStore('quota-monitor', 'darwin');
    // Thunks, not promises: a rejected promise sitting in an array while the
    // loop works through the earlier entries is an unhandled rejection.
    const calls: Array<() => Promise<unknown>> = [
      () => store.get('anthropic.apiKey'),
      () => store.set('anthropic.apiKey', SECRET),
      () => store.delete('anthropic.apiKey'),
    ];
    for (const call of calls) {
      const err = await rejection(call());
      expect(err.message).toContain('not implemented in v0.1');
      expect(err.message).not.toContain(SECRET);
    }
  });

  it('reports the planned backend for each supported platform', () => {
    expect(OsKeychainSecretStore.backendFor('win32')?.command).toBe('powershell.exe');
    expect(OsKeychainSecretStore.backendFor('darwin')?.command).toBe('/usr/bin/security');
    expect(OsKeychainSecretStore.backendFor('linux')?.command).toBe('secret-tool');
    expect(OsKeychainSecretStore.backendFor('win32')?.platform).toBe('win32');
  });

  it('has no backend for an unsupported platform, and still refuses to work', async () => {
    expect(OsKeychainSecretStore.backendFor('sunos')).toBeUndefined();
    const store = new OsKeychainSecretStore('quota-monitor', 'sunos');
    expect(store.backend).toBeUndefined();
    const err = await rejection(store.get('k'));
    expect(err.message).toContain('not implemented in v0.1');
    expect(err.message).toContain('no keychain backend is planned');
  });

  it('keeps the service namespace it was constructed with', () => {
    const store = new OsKeychainSecretStore('quota-monitor-dev', 'linux');
    expect(store.service).toBe('quota-monitor-dev');
    expect(store.platform).toBe('linux');
    expect(store.backend?.displayName).toBe('Secret Service');
  });

  it('defaults the service namespace to quota-monitor', () => {
    expect(new OsKeychainSecretStore(undefined, 'linux').service).toBe('quota-monitor');
  });

  it('validates the key before reporting the stub', async () => {
    const store = new OsKeychainSecretStore('quota-monitor', 'linux');
    expect((await rejection(store.get(''))).message).toMatch(/non-empty string/);
  });
});
