/**
 * The adapter registry, and the fan-out that runs them.
 *
 * Two jobs, both small:
 *
 *   1. `AdapterRegistry` holds adapters by id and hands them back in a stable
 *      order. Registration order is preserved, so the widget's rows do not
 *      shuffle between refreshes.
 *   2. `collect` runs every adapter concurrently and returns one
 *      `AdapterResult` per adapter, in input order.
 *
 * THE CONTAINMENT RULE. `collect` never rejects and never lets one adapter
 * take down a refresh. A `detect` that throws, a `read` that throws, a `read`
 * that rejects, a `read` that returns something that is not an array, an
 * adapter object that is malformed - all of it becomes `{ ok: false, id,
 * error }` for that adapter alone. The renderer already knows how to print a
 * failed row; a thrown exception here would print nothing at all.
 *
 * An adapter whose `detect` returns false yields `{ ok: true, id, readings: []
 * }` rather than being dropped. "Codex is not installed" and "Codex is
 * installed and idle" are different facts, and the caller - not this module -
 * decides which of them is worth a row.
 */

/**
 * How `collect` gets a context for one adapter.
 *
 * A plain `AdapterContext` is shared by every adapter, which is only correct
 * when they all want the same `options`. Since `AdapterContext.options` is
 * defined as *this adapter's* slice of the config, real callers pass a
 * function and hand each adapter its own slice. Adapters run concurrently, so
 * a single mutated context would race; a factory cannot.
 */
export type AdapterContextFactory = (adapter: QuotaAdapter) => AdapterContext;

import type { AdapterContext, AdapterResult, QuotaAdapter, QuotaReading } from './types.js';

/** Longest error text we keep. Adapter errors are untrusted, unbounded text. */
const MAX_ERROR_LENGTH = 500;

/**
 * An ordered, id-keyed set of adapters.
 *
 * Iterable, so it can be handed straight to `collect`. Re-registering an id
 * replaces the adapter in place and keeps its original position, which means a
 * plugin overriding a built-in cannot reorder the display.
 */
export class AdapterRegistry implements Iterable<QuotaAdapter> {
  readonly #adapters = new Map<string, QuotaAdapter>();

  constructor(adapters?: Iterable<QuotaAdapter>) {
    if (adapters === undefined) return;
    for (const adapter of adapters) this.register(adapter);
  }

  /**
   * Add or replace an adapter.
   *
   * @throws TypeError if the adapter does not satisfy the `QuotaAdapter`
   * shape. This is the one place that throws, deliberately: a malformed
   * adapter is a programming error at wiring time, not a runtime data problem,
   * and it should surface loudly at startup rather than as a mystery row.
   */
  register(adapter: QuotaAdapter): this {
    assertAdapter(adapter);
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): QuotaAdapter | undefined {
    return this.#adapters.get(id);
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  /** Remove an adapter. Returns false when the id was not registered. */
  remove(id: string): boolean {
    return this.#adapters.delete(id);
  }

  clear(): void {
    this.#adapters.clear();
  }

  get size(): number {
    return this.#adapters.size;
  }

  /** Registered ids, in registration order. */
  ids(): string[] {
    return [...this.#adapters.keys()];
  }

  /** Every adapter, in registration order. A fresh array; safe to mutate. */
  list(): QuotaAdapter[] {
    return [...this.#adapters.values()];
  }

  /**
   * The adapters enabled by config, in registration order.
   *
   * An id absent from `providers` is treated as enabled: a new adapter should
   * appear for someone whose config predates it, rather than silently doing
   * nothing.
   */
  enabled(providers: Readonly<Record<string, { enabled: boolean } | undefined>>): QuotaAdapter[] {
    return this.list().filter((adapter) => providers[adapter.id]?.enabled !== false);
  }

  [Symbol.iterator](): Iterator<QuotaAdapter> {
    return this.#adapters.values();
  }
}

/** Convenience constructor, for `createRegistry([claudeCodeAdapter])`. */
export function createRegistry(adapters?: Iterable<QuotaAdapter>): AdapterRegistry {
  return new AdapterRegistry(adapters);
}

/**
 * Run every adapter and return one result each, in input order.
 *
 * Adapters run concurrently: they are I/O bound on different directories, and
 * a refresh should cost about as long as the slowest one rather than the sum.
 * `Promise.allSettled` is used rather than `Promise.all` so that even a
 * pathological adapter that manages to reject outside the per-adapter guard
 * cannot abort the batch.
 *
 * `ctx` is either one context shared by every adapter, or an
 * {@link AdapterContextFactory} called once per adapter - use the factory when
 * each adapter needs its own `options` slice, which is the normal case.
 *
 * Never rejects. Duplicate ids in the input produce duplicate results, in
 * order - deduplication is the registry's job, not this function's.
 */
export async function collect(
  adapters: Iterable<QuotaAdapter>,
  ctx: AdapterContext | AdapterContextFactory,
): Promise<AdapterResult[]> {
  const list = [...adapters];
  const settled = await Promise.allSettled(list.map((adapter) => runOne(adapter, ctx)));

  return settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    // Unreachable in practice - runOne catches everything - but a promise that
    // rejects here would otherwise become an unhandled rejection.
    return failure(idOf(list[index], index), outcome.reason);
  });
}

/**
 * One adapter's full lifecycle, with every failure mode contained.
 *
 * `detect` and `read` are guarded separately so the error message can say
 * which half broke; "claude-code detect() failed" and "claude-code read()
 * failed" send a maintainer to very different code.
 */
async function runOne(
  adapter: QuotaAdapter,
  source: AdapterContext | AdapterContextFactory,
): Promise<AdapterResult> {
  let id = 'unknown';
  try {
    assertAdapter(adapter);
    id = adapter.id;
  } catch (error) {
    return failure(
      typeof (adapter as { id?: unknown } | undefined)?.id === 'string'
        ? String((adapter as { id: string }).id)
        : id,
      error,
    );
  }

  // A factory is caller code too, so it is inside the guard.
  let ctx: AdapterContext;
  try {
    ctx = typeof source === 'function' ? source(adapter) : source;
  } catch (error) {
    return failure(id, error, 'building the adapter context failed');
  }

  let detected: boolean;
  try {
    detected = (await adapter.detect(ctx)) === true;
  } catch (error) {
    return failure(id, error, 'detect() failed');
  }

  if (!detected) {
    ctx.debug(`${id}: not detected, skipping read`);
    return { ok: true, id, readings: [] };
  }

  try {
    const readings = await adapter.read(ctx);
    if (!Array.isArray(readings)) {
      return { ok: false, id, error: 'read() did not return an array of readings' };
    }
    // Drop holes and non-objects rather than handing the renderer something it
    // would have to defend against on every field access.
    const clean = readings.filter((reading): reading is QuotaReading => isReading(reading));
    return { ok: true, id, readings: clean };
  } catch (error) {
    return failure(id, error, 'read() failed');
  }
}

function isReading(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(id: string, error: unknown, prefix?: string): AdapterResult {
  const text = messageOf(error);
  return { ok: false, id, error: prefix === undefined ? text : `${prefix}: ${text}` };
}

/**
 * A printable message for anything that was thrown.
 *
 * Errors are stringified, not inspected: a `cause` chain can carry data an
 * adapter never meant to display, and this string goes to a terminal.
 */
function messageOf(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    text = error.message.trim() === '' ? error.name : error.message;
  } else if (typeof error === 'string') {
    text = error;
  } else {
    try {
      text = String(error);
    } catch {
      text = 'unstringifiable error';
    }
  }

  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'unknown error';
  return flat.length <= MAX_ERROR_LENGTH ? flat : flat.slice(0, MAX_ERROR_LENGTH - 3) + '...';
}

function assertAdapter(adapter: QuotaAdapter): void {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new TypeError(`adapter must be an object, got ${typeof adapter}`);
  }
  if (typeof adapter.id !== 'string' || adapter.id.trim() === '') {
    throw new TypeError('adapter.id must be a non-empty string');
  }
  if (typeof adapter.displayName !== 'string' || adapter.displayName.trim() === '') {
    throw new TypeError(`adapter "${adapter.id}": displayName must be a non-empty string`);
  }
  if (typeof adapter.detect !== 'function') {
    throw new TypeError(`adapter "${adapter.id}": detect must be a function`);
  }
  if (typeof adapter.read !== 'function') {
    throw new TypeError(`adapter "${adapter.id}": read must be a function`);
  }
}

function idOf(adapter: QuotaAdapter | undefined, index: number): string {
  const id: unknown = adapter?.id;
  return typeof id === 'string' && id.trim() !== '' ? id : `adapter[${index}]`;
}
