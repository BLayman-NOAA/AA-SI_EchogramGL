/**
 * Fetch and decode in a worker pool.
 *
 * Architecture section 4.5. Fetching is asynchronous and costs the main thread
 * nothing, but decompressing is not: a tile is blosc or zstd compressed and
 * inflating it happens on whatever thread asks. During a pan that lands in the
 * middle of a frame, and section 4.5 expects this to be the largest frame time
 * win after level of detail itself.
 *
 * The pool owns the protocol; the worker owns the zarr reading. Workers are
 * addressed by store href, because a worker opens the array itself rather than
 * being handed one: an open zarr array is a closure over a store and does not
 * survive structured cloning.
 *
 * A pool is optional everywhere. Where there is no Worker, or the store is not
 * one a worker can reopen from a URL, the caller reads on the main thread and
 * the only thing lost is the frame time.
 */

/** What the pool asks a worker for. One tile of one channel. */
export interface DecodeRequest {
  id: number;
  href: string;
  /** Level path within the store, as the multiscales entry names it. */
  path: string;
  valueName: string;
  channel: number;
  pings: [number, number];
  samples: [number, number];
  /**
   * Where each axis sits, for a store that is not in the contract's order.
   *
   * Absent means (channel, ping, sample), which is what a built store holds.
   * A plain Sv dataset records its own order and the main thread reads it once
   * when the store opens, so this is a fact carried across rather than a
   * discovery repeated per tile.
   */
  order?: { channel: number; ping: number; sample: number };
  /**
   * Whether the values need converting rather than reinterpreting.
   *
   * A built store is float16 already and the bytes pass through. A plain
   * dataset is float32 or float64 with NaN, and converting it is the most
   * expensive thing on this path, which is exactly why it belongs here.
   */
  convert?: boolean;
  /**
   * What the fetch inside the worker asks at.
   *
   * Carried across rather than applied on this side. The worker opens its own
   * store, so the priority the main thread tagged a signal with belongs to a
   * request the worker never makes.
   */
  priority?: 'high' | 'low' | 'auto';
}

/** What a worker sends back, with the values transferred rather than copied. */
export interface DecodeResult {
  id: number;
  data?: Uint16Array<ArrayBuffer>;
  pings?: number;
  samples?: number;
  error?: string;
}

export type DecodeMessage = DecodeRequest | { cancel: number };

/** The part of Worker this uses, so a test can supply one without a DOM. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: DecodeResult }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DecodePoolOptions {
  /** Workers to run. More than the link can feed is queue, not throughput. */
  size?: number;
  spawn: () => WorkerLike;
}

/** Workers to run when nothing says otherwise. */
export const DEFAULT_POOL_SIZE = 2;

interface Pending {
  request: DecodeRequest;
  resolve: (value: { data: Uint16Array<ArrayBuffer>; pings: number; samples: number }) => void;
  reject: (error: unknown) => void;
  worker?: WorkerLike;
}

export class DecodePool {
  private workers: WorkerLike[] = [];
  private idle: WorkerLike[] = [];
  private pending = new Map<number, Pending>();
  private queue: Pending[] = [];
  private nextId = 1;
  private destroyed = false;

  constructor(options: DecodePoolOptions) {
    const size = Math.max(1, options.size ?? DEFAULT_POOL_SIZE);
    for (let i = 0; i < size; i += 1) {
      const worker = options.spawn();
      worker.onmessage = (event) => this.receive(worker, event.data);
      // A worker that dies takes its request with it. Reported to the caller
      // rather than retried, so a broken bundle is one error and not a loop.
      worker.onerror = () => this.fail(worker, 'the decode worker failed');
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** Requests issued to a worker and not yet answered. */
  get inFlight(): number {
    return this.pending.size;
  }

  get queued(): number {
    return this.queue.length;
  }

  read(
    request: Omit<DecodeRequest, 'id'>,
    signal?: AbortSignal,
  ): Promise<{ data: Uint16Array<ArrayBuffer>; pings: number; samples: number }> {
    if (this.destroyed) return Promise.reject(new Error('the decode pool is gone'));
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const entry: Pending = { request: { ...request, id }, resolve, reject };
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('the request was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => this.cancel(id), { once: true });
      }
      this.queue.push(entry);
      this.drain();
    });
  }

  /**
   * Give up on a request.
   *
   * A queued one never goes out. One already with a worker is told to abort,
   * and the worker answers with an error that nobody is waiting for, which is
   * what returns it to the idle list.
   */
  cancel(id: number) {
    const queued = this.queue.findIndex((entry) => entry.request.id === id);
    if (queued >= 0) {
      const [entry] = this.queue.splice(queued, 1);
      entry.reject(new DOMException('the request was aborted', 'AbortError'));
      return;
    }
    const held = this.pending.get(id);
    if (!held) return;
    held.reject(new DOMException('the request was aborted', 'AbortError'));
    held.worker?.postMessage({ cancel: id });
  }

  destroy() {
    this.destroyed = true;
    for (const worker of this.workers) worker.terminate();
    for (const entry of this.queue) {
      entry.reject(new DOMException('the request was aborted', 'AbortError'));
    }
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }

  private drain() {
    while (this.queue.length && this.idle.length) {
      const worker = this.idle.pop()!;
      const entry = this.queue.shift()!;
      entry.worker = worker;
      this.pending.set(entry.request.id, entry);
      worker.postMessage(entry.request);
    }
  }

  private receive(worker: WorkerLike, result: DecodeResult) {
    const entry = this.pending.get(result.id);
    this.pending.delete(result.id);
    // Once. A worker that reported an error and then answered anyway would
    // otherwise appear in the idle list twice, and take two requests it can
    // only run one at a time.
    if (!this.idle.includes(worker)) this.idle.push(worker);
    if (entry) {
      if (result.error !== undefined) entry.reject(new Error(result.error));
      else if (result.data && result.pings !== undefined && result.samples !== undefined) {
        entry.resolve({ data: result.data, pings: result.pings, samples: result.samples });
      } else entry.reject(new Error('the decode worker sent no values'));
    }
    this.drain();
  }

  private fail(worker: WorkerLike, message: string) {
    for (const [id, entry] of this.pending) {
      if (entry.worker !== worker) continue;
      this.pending.delete(id);
      entry.reject(new Error(message));
    }
    if (!this.idle.includes(worker)) this.idle.push(worker);
    this.drain();
  }
}

/**
 * How a host supplies its own worker.
 *
 * `new URL('./decodeWorker.ts', import.meta.url)` is resolved by the bundler
 * that compiles it, so the reference below belongs to this project's build and
 * not to a copy of this library sitting inside somebody else's. An embedding
 * application passes its own, written against its own bundler:
 *
 *     spawnWorker: () =>
 *       new Worker(new URL('./echogramDecode.js', import.meta.url), {
 *         type: 'module',
 *       })
 */
export type SpawnWorker = () => WorkerLike;

/**
 * A pool over a worker the caller knows how to start, or nothing.
 *
 * No default. `new URL('./decodeWorker.ts', import.meta.url)` is resolved by
 * whichever bundler compiles the file containing it, so a default here would be
 * a path that is correct for this project's own build and wrong inside every
 * application that embeds the library. Worse, it would drag the worker and the
 * two decompressors it carries into the library bundle, where they are more
 * than a megabyte of code the host cannot use.
 *
 * So the reference lives in `shell/`, next to the build that resolves it, and
 * a host supplies its own. Returns undefined rather than throwing: every caller
 * has a main thread path to fall back to, and a viewer that refuses to open a
 * store because it could not start a worker is worse than one that decodes a
 * little slower.
 */
export function createDecodePool(
  size?: number,
  spawn?: SpawnWorker,
): DecodePool | undefined {
  // No check for a Worker global. That mattered while there was a built in
  // spawn to protect; now the caller supplies one, and what it returns only has
  // to be WorkerLike. Testing for a global here would refuse a host that has a
  // perfectly good worker of its own.
  if (!spawn) return undefined;
  try {
    return new DecodePool({ size, spawn });
  } catch {
    return undefined;
  }
}
