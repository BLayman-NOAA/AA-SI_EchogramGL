/**
 * What is in flight, and what stops being worth waiting for.
 *
 * The view says what it wants on every pointer move; this decides what that
 * means for the network. A tile already held is not asked for, a tile the
 * summaries say is empty is never asked for, a tile in the cache is delivered
 * without a request, and a tile in flight that the new viewport no longer wants
 * is aborted rather than allowed to complete.
 *
 * Aborting matters more than it looks. A drag across a survey names a different
 * set of tiles every frame, and without abort each of those sets is still on
 * the wire when the next one goes out, so the request that would draw the
 * screen the user is actually looking at queues behind thirty that would not.
 *
 * Kept apart from the view because scheduling is the part worth asserting and
 * the view needs a GPU to exist. Everything here is a callback.
 */

import type { ArrayCache } from './cache';
import type { Priority } from './prefetch';

/** One tile of one channel at one level. */
export interface TileKey {
  level: number;
  channel: number;
  row: number;
  column: number;
}

export interface TileWant extends TileKey {
  priority: Priority;
}

export interface SchedulerHooks<T> {
  /** Read one tile, rejecting with an AbortError when the signal fires. */
  read(key: TileKey, options: { signal: AbortSignal; priority: Priority }): Promise<T>;
  /** Bytes a value occupies, which is what the cache budget is spent against. */
  weigh(value: T): number;
  /** Hand a tile to the consumer. */
  deliver(key: TileKey, value: T, priority: Priority): void;
  /** Whether the consumer already holds it, in which case nothing is asked. */
  held(key: TileKey): boolean;
  /** Whether the store already says the tile holds nothing worth fetching. */
  empty?(key: TileKey): boolean;
  onError?(error: unknown, key: TileKey): void;
}

export interface SchedulerOptions<T> {
  cache: ArrayCache<T>;
  /**
   * What distinguishes this store's tiles in the cache.
   *
   * The cache is shared across views, and level 3 row 7 of one store is not
   * level 3 row 7 of another. Without this, two views on different surveys hand
   * each other tiles and each one draws the other's water with no error
   * anywhere. The store URL is the obvious value.
   */
  namespace: string;
  hooks: SchedulerHooks<T>;
}

export class TileScheduler<T> {
  private cache: ArrayCache<T>;
  private namespace: string;
  private hooks: SchedulerHooks<T>;
  private inflight = new Map<string, AbortController>();
  private failed = new Set<string>();
  private empty = new Set<string>();

  constructor(options: SchedulerOptions<T>) {
    this.cache = options.cache;
    this.namespace = options.namespace;
    this.hooks = options.hooks;
  }

  /** Cache key, which is the tile within the store it came from. */
  private cacheKey(key: TileKey): string {
    return `${this.namespace}|${tileKey(key)}`;
  }

  get inFlight(): number {
    return this.inflight.size;
  }

  /** Tiles known to hold nothing, which is a saving worth reporting. */
  get skipped(): number {
    return this.empty.size;
  }

  get failures(): number {
    return this.failed.size;
  }

  /**
   * Ask for exactly this set.
   *
   * Ordered, so the visible tiles at the head of the list go out before the
   * speculative ones behind them. Anything in flight and not named here is
   * abandoned, which is the abort on viewport change.
   */
  request(wants: TileWant[]) {
    const named = new Set(wants.map(identify));
    for (const [key, controller] of this.inflight) {
      if (named.has(key)) continue;
      this.inflight.delete(key);
      controller.abort();
    }

    for (const want of wants) {
      const key = identify(want);
      if (this.inflight.has(key) || this.failed.has(key) || this.empty.has(key)) continue;
      if (this.hooks.held(want)) continue;
      if (this.hooks.empty?.(want)) {
        this.empty.add(key);
        continue;
      }
      const cached = this.cache.get(want.level, this.cacheKey(want));
      if (cached !== undefined) {
        this.hooks.deliver(want, cached, want.priority);
        continue;
      }
      this.start(want, key);
    }
  }

  /**
   * Forget the failures at a level, so the next request asks again.
   *
   * A gesture does not retry a read that failed, because request runs on every
   * pointer move. Changing a control does, which is the deliberate act.
   */
  retry(level: number) {
    const prefix = `${level}:`;
    for (const key of [...this.failed]) if (key.startsWith(prefix)) this.failed.delete(key);
  }

  /** Give up on everything, as when the store is replaced. */
  abortAll() {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  /**
   * Forget a level.
   *
   * The failures go with it. A level reloaded after a channel change is reading
   * different arrays, and a failure remembered from the old one would keep a
   * tile blank that has nothing wrong with it.
   *
   * The cached tiles do not go with it. The cache is shared and holds tiles by
   * store and channel, so nothing in it goes stale when a level is let go, and
   * another view may be reading the very entries this one would drop. Its own
   * budget decides when they leave.
   */
  dropLevel(level: number) {
    const prefix = `${level}:`;
    for (const [key, controller] of this.inflight) {
      if (!key.startsWith(prefix)) continue;
      this.inflight.delete(key);
      controller.abort();
    }
    for (const set of [this.failed, this.empty]) {
      for (const key of [...set]) if (key.startsWith(prefix)) set.delete(key);
    }
  }

  private start(want: TileWant, key: string) {
    const controller = new AbortController();
    this.inflight.set(key, controller);
    const { priority, ...tile } = want;

    this.hooks
      .read(tile, { signal: controller.signal, priority })
      .then((value) => {
        // Still wanted, rather than merely arrived. An abort races the answer,
        // and installing a tile the view has moved off puts a texture on the
        // budget for water nobody is looking at.
        if (this.inflight.get(key) !== controller) return;
        this.inflight.delete(key);
        this.cache.set(want.level, this.cacheKey(want), value, this.hooks.weigh(value));
        this.hooks.deliver(tile, value, priority);
      })
      .catch((error) => {
        if (this.inflight.get(key) === controller) this.inflight.delete(key);
        if (isAbort(error)) return;
        // Remembered rather than retried. request runs on every pointer move,
        // so asking again straight away turns a drag across a tile that cannot
        // be read into a stream of requests and error reports.
        this.failed.add(key);
        this.hooks.onError?.(error, tile);
      });
  }
}

/** Cache key within a level, which is the tile and the channel it belongs to. */
export function tileKey(key: { channel: number; row: number; column: number }): string {
  return `${key.channel}:${key.row}:${key.column}`;
}

function identify(key: TileKey): string {
  return `${key.level}:${key.channel}:${key.row}:${key.column}`;
}

/** Whether a rejection is a cancellation rather than something to report. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
