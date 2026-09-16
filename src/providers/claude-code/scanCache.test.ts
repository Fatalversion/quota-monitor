import { describe, expect, it } from 'vitest';

import {
  CACHE_MAX_AGE_MS,
  emptyCache,
  isFresh,
  parseCache,
  serializeCache,
} from './scanCache.js';

import type { ScanCache } from './scanCache.js';
import type { UsageEvent } from '../../core/types.js';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const ROOT = '/home/x/.claude';

function event(at: string, model: string, input: number, output = 0): UsageEvent {
  return {
    provider: 'claude-code',
    at: new Date(at),
    model,
    tokens: { input, output, cacheCreation: 0, cacheRead: 0, thinking: 0 },
  };
}

function cacheWith(files: Record<string, { size: number; mtimeMs: number; events: UsageEvent[] }>): ScanCache {
  const cache = emptyCache(ROOT);
  for (const [file, entry] of Object.entries(files)) cache.files.set(file, entry);
  return cache;
}

describe('the scan cache on disk', () => {
  const sample = cacheWith({
    '/t/a.jsonl': {
      size: 120,
      mtimeMs: NOW.getTime() - 60_000,
      events: [event('2026-09-16T11:00:00.000Z', 'claude-opus-5', 100, 20)],
    },
  });

  it('round trips a file and its events', () => {
    const back = parseCache(serializeCache(sample, NOW), ROOT);
    const entry = back?.files.get('/t/a.jsonl');

    expect(entry?.size).toBe(120);
    expect(entry?.events).toHaveLength(1);
    expect(entry?.events[0]?.model).toBe('claude-opus-5');
    expect(entry?.events[0]?.tokens.input).toBe(100);
    expect(entry?.events[0]?.at.toISOString()).toBe('2026-09-16T11:00:00.000Z');
  });

  it('keeps the identity fields that make de-duplication possible', () => {
    const rich = cacheWith({
      '/t/b.jsonl': {
        size: 10,
        mtimeMs: NOW.getTime(),
        events: [{ ...event('2026-09-16T11:00:00.000Z', 'm', 1), messageId: 'msg_1', requestId: 'req_1' }],
      },
    });

    const back = parseCache(serializeCache(rich, NOW), ROOT);
    expect(back?.files.get('/t/b.jsonl')?.events[0]).toMatchObject({
      messageId: 'msg_1',
      requestId: 'req_1',
    });
  });

  it('writes the model name once however many events use it', () => {
    const many = cacheWith({
      '/t/c.jsonl': {
        size: 10,
        mtimeMs: NOW.getTime(),
        events: Array.from({ length: 50 }, () => event('2026-09-16T11:00:00.000Z', 'claude-opus-5', 1)),
      },
    });

    const text = serializeCache(many, NOW);
    expect(text.split('claude-opus-5').length - 1).toBe(1);
  });

  it('drops entries older than the widest window any read asks for', () => {
    const stale = cacheWith({
      '/t/old.jsonl': {
        size: 10,
        mtimeMs: NOW.getTime() - CACHE_MAX_AGE_MS - 1,
        events: [event('2026-08-01T00:00:00.000Z', 'm', 1)],
      },
      '/t/new.jsonl': { size: 10, mtimeMs: NOW.getTime(), events: [] },
    });

    const back = parseCache(serializeCache(stale, NOW), ROOT);
    expect([...(back?.files.keys() ?? [])]).toEqual(['/t/new.jsonl']);
  });

  it('refuses a cache written for another Claude directory', () => {
    // The entries describe someone else's transcripts. Better no cache than a
    // confident wrong one.
    expect(parseCache(serializeCache(sample, NOW), '/somewhere/else')).toBeNull();
  });

  it('refuses anything it cannot fully understand', () => {
    for (const text of [
      '',
      'not json',
      '{}',
      JSON.stringify({ kind: 'claude-code-scan-cache', version: 99, root: ROOT }),
      JSON.stringify({ kind: 'something-else', version: 1, root: ROOT }),
      // Models must be a table of strings; without it every event is unreadable.
      JSON.stringify({ kind: 'claude-code-scan-cache', version: 1, root: ROOT, models: [1], files: {} }),
    ]) {
      expect(parseCache(text, ROOT)).toBeNull();
    }
  });

  it('drops one unreadable file rather than the whole cache', () => {
    const text = JSON.stringify({
      tool: 'quota-monitor',
      kind: 'claude-code-scan-cache',
      version: 1,
      root: ROOT,
      models: ['m'],
      files: {
        '/t/good.jsonl': { size: 1, mtimeMs: NOW.getTime(), events: [[1, 0, 1, 0, 0, 0, 0]] },
        '/t/bad.jsonl': { size: 1, mtimeMs: NOW.getTime(), events: 'not an array' },
        '/t/worse.jsonl': { size: 1, mtimeMs: NOW.getTime(), events: [{ not: 'a tuple' }] },
      },
    });

    const back = parseCache(text, ROOT);
    expect([...(back?.files.keys() ?? [])]).toEqual(['/t/good.jsonl']);
  });
});

describe('isFresh', () => {
  const entry = { size: 100, mtimeMs: 1000, events: [] };

  it('needs both halves to match', () => {
    expect(isFresh(entry, 100, 1000)).toBe(true);
    // Size alone misses an edit that replaced as much as it removed; mtime
    // alone misses a file restored from a copy that kept its timestamp.
    expect(isFresh(entry, 101, 1000)).toBe(false);
    expect(isFresh(entry, 100, 1001)).toBe(false);
  });

  it('is false for a file it has never seen', () => {
    expect(isFresh(undefined, 100, 1000)).toBe(false);
  });
});
