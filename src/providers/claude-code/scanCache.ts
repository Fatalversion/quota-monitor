/**
 * What the last scan learned from each transcript, so the next one need not
 * read it again.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The widget polls every 60 seconds and each poll re-read every transcript the
 * windows could touch. Measured on the machine this was written for:
 *
 *     2,179 transcripts, 914 MB total
 *       575 transcripts, 389 MB modified in the last 7 days  <- re-read, every minute
 *     one read: 7-19 seconds
 *
 * That is hours of CPU a day, and a week of transcripts re-parsed 1,440 times,
 * to answer a question whose inputs almost never change: a transcript that has
 * not been written to since the last read cannot contain a call it did not
 * contain then.
 *
 * So each file's PARSED, DE-DUPLICATED events are kept here, keyed by the file
 * and its (size, mtime). A file that matches is replayed from this cache and
 * never opened; a file that does not is read as before and its result replaces
 * the entry.
 *
 * WHY (size, mtime) IS ENOUGH
 * ---------------------------
 * Transcripts are append-only files written by Claude Code as a session runs.
 * An edit that left both the size and the modification time untouched would be
 * a forgery, not a session. The pair is also what `listTranscripts` already
 * stats, so the check costs nothing beyond what the scan was doing anyway.
 *
 * The conservative direction is deliberate: a MISS costs one file read, a false
 * HIT would silently under-count someone's usage forever. Anything unexpected -
 * a file that shrank, a clock that went backwards, a cache written by another
 * version - is a miss.
 *
 * WHAT IS NOT CACHED
 * ------------------
 * A file that could not be read to the end. It is re-read every time, because
 * the next attempt may get further, and a truncated answer that never retries
 * is the kind of wrong that looks right.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ZERO_TOKENS } from '../../core/types.js';

import type { TokenCounts, UsageEvent } from '../../core/types.js';

export const CACHE_KIND = 'claude-code-scan-cache';
export const CACHE_VERSION = 1;

/** Largest cache file read back. Beyond this, start again. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Entries older than this are dropped on write.
 *
 * The widest window any read asks for is the anchor ladder's ceiling, so a file
 * untouched for longer than that cannot be opened by the next read either. It
 * is the cache's own eviction rule, and without one the file grows for the life
 * of the installation.
 */
export const CACHE_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

/** One transcript, as the last scan saw it. */
export interface CachedFile {
  size: number;
  mtimeMs: number;
  /** De-duplicated events, in the order the scan produced them. */
  events: UsageEvent[];
}

export interface ScanCache {
  root: string;
  files: Map<string, CachedFile>;
}

export function emptyCache(root: string): ScanCache {
  return { root, files: new Map() };
}

/** Beside the snapshot, in quota-monitor's own directory. */
export function scanCachePath(homeDir: string): string {
  return join(homeDir, '.config', 'quota-monitor', 'claude-code-scan.json');
}

/* -------------------------------------------------------------------------- */
/* the wire shape                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Events are written as arrays against a model table, not as objects.
 *
 * A week here is tens of thousands of events, and `{"provider":"claude-code",
 * "model":"claude-opus-5","tokens":{"input":...}}` repeated that many times is
 * a file several times larger than the thing it exists to avoid re-reading. The
 * tuple is `[atMs, modelIndex, input, output, cacheCreation, cacheRead,
 * thinking, sessionId?, requestId?, messageId?]`.
 *
 * The identity fields are kept because `dedupeEvents` upstream may still need
 * them if two files are ever folded together, and dropping them would make the
 * cache lossy in a way no test would notice until it mattered.
 */
type WireEvent = [number, number, number, number, number, number, number, string?, string?, string?];

interface WireFile {
  size: number;
  mtimeMs: number;
  events: WireEvent[];
}

function tokensOf(event: UsageEvent): TokenCounts {
  return event.tokens ?? ZERO_TOKENS;
}

export function serializeCache(cache: ScanCache, now: Date): string {
  const models: string[] = [];
  const indexOf = (model: string): number => {
    const found = models.indexOf(model);
    if (found !== -1) return found;
    models.push(model);
    return models.length - 1;
  };

  const cutoff = now.getTime() - CACHE_MAX_AGE_MS;
  const files: Record<string, WireFile> = {};
  for (const [file, entry] of cache.files) {
    if (entry.mtimeMs < cutoff) continue;
    files[file] = {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      events: entry.events.map((event): WireEvent => {
        const tokens = tokensOf(event);
        const tuple: WireEvent = [
          event.at.getTime(),
          indexOf(event.model),
          tokens.input,
          tokens.output,
          tokens.cacheCreation,
          tokens.cacheRead,
          tokens.thinking,
        ];
        // Trailing identity fields only when present, so the common case stays
        // a seven-number array.
        if (event.sessionId !== undefined || event.requestId !== undefined || event.messageId !== undefined) {
          tuple[7] = event.sessionId ?? '';
          tuple[8] = event.requestId ?? '';
          tuple[9] = event.messageId ?? '';
        }
        return tuple;
      }),
    };
  }

  return `${JSON.stringify({
    tool: 'quota-monitor',
    kind: CACHE_KIND,
    version: CACHE_VERSION,
    writtenAt: now.toISOString(),
    root: cache.root,
    models,
    files,
  })}\n`;
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read a cache back, or null.
 *
 * Tolerant in one direction only: anything it cannot fully understand is no
 * cache at all, because a half-understood cache is a wrong number. A different
 * `root` is also nothing - the entries describe another Claude installation.
 */
export function parseCache(text: string, root: string): ScanCache | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (field(parsed, 'kind') !== CACHE_KIND) return null;
  if (field(parsed, 'version') !== CACHE_VERSION) return null;
  if (field(parsed, 'root') !== root) return null;

  const models = field(parsed, 'models');
  if (!Array.isArray(models) || models.some((name) => typeof name !== 'string')) return null;

  const rawFiles = field(parsed, 'files');
  if (typeof rawFiles !== 'object' || rawFiles === null || Array.isArray(rawFiles)) return null;

  const files = new Map<string, CachedFile>();
  for (const [file, value] of Object.entries(rawFiles as Record<string, unknown>)) {
    const size = num(field(value, 'size'));
    const mtimeMs = num(field(value, 'mtimeMs'));
    const rawEvents = field(value, 'events');
    if (size === null || mtimeMs === null || !Array.isArray(rawEvents)) continue;

    const events: UsageEvent[] = [];
    let usable = true;
    for (const raw of rawEvents) {
      if (!Array.isArray(raw)) {
        usable = false;
        break;
      }
      const atMs = num(raw[0]);
      const modelIndex = num(raw[1]);
      const model = modelIndex === null ? undefined : (models as string[])[modelIndex];
      if (atMs === null || typeof model !== 'string') {
        usable = false;
        break;
      }

      const event: UsageEvent = {
        provider: 'claude-code',
        at: new Date(atMs),
        model,
        tokens: {
          input: num(raw[2]) ?? 0,
          output: num(raw[3]) ?? 0,
          cacheCreation: num(raw[4]) ?? 0,
          cacheRead: num(raw[5]) ?? 0,
          thinking: num(raw[6]) ?? 0,
        },
      };
      if (typeof raw[7] === 'string' && raw[7] !== '') event.sessionId = raw[7];
      if (typeof raw[8] === 'string' && raw[8] !== '') event.requestId = raw[8];
      if (typeof raw[9] === 'string' && raw[9] !== '') event.messageId = raw[9];
      events.push(event);
    }

    if (usable) files.set(file, { size, mtimeMs, events });
  }

  return { root, files };
}

/* -------------------------------------------------------------------------- */
/* disk                                                                       */
/* -------------------------------------------------------------------------- */

/** The cache on disk, or an empty one. Never throws. */
export async function readScanCache(file: string, root: string): Promise<ScanCache> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_CACHE_BYTES) return emptyCache(root);
    return parseCache(await readFile(file, 'utf8'), root) ?? emptyCache(root);
  } catch {
    return emptyCache(root);
  }
}

/**
 * Write it, atomically, and never fail a read over it.
 *
 * Same temp-then-rename as the snapshot: a widget killed mid-write must not
 * leave half a cache behind, because the next read would spend its time
 * discovering that rather than answering.
 */
export async function writeScanCache(file: string, cache: ScanCache, now: Date): Promise<boolean> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, serializeCache(cache, now), 'utf8');
    await rename(temp, file);
    return true;
  } catch {
    await rm(temp, { force: true }).catch(() => {
      /* Nothing to do: it is a temp file in a cache directory. */
    });
    return false;
  }
}

/**
 * Is this entry still the file on disk?
 *
 * Both halves have to match. Size alone misses an edit that replaced as much as
 * it removed; mtime alone misses a file restored from a copy with its timestamp
 * preserved.
 */
export function isFresh(entry: CachedFile | undefined, size: number, mtimeMs: number): boolean {
  if (entry === undefined) return false;
  return entry.size === size && entry.mtimeMs === mtimeMs;
}
