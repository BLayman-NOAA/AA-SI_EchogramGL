/**
 * A store with a clock, for testing scheduling.
 *
 * Prefetch, abort and the upload cap are scheduling problems, and scheduling is
 * miserable to verify against a real network: the assertions come out as
 * timeouts and the failures come out as flakes. Here a request is held until
 * the test says otherwise, so what the scheduler asked for, in what order, and
 * what it gave up on are all plain values.
 *
 * Not test only by accident of where it lives. It is the piece that makes
 * milestone 6 assertable at all, so it ships with the data layer it exercises.
 */

import type { ChunkOptions, ChunkStore } from './store';

interface Waiting {
  key: string;
  due: number;
  resolve: (value: Uint8Array | undefined) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

export interface MockStoreOptions {
  /** Bytes per key. A key absent from this is answered as absent. */
  bytes?: Map<string, Uint8Array>;
  /** Milliseconds a key takes, on the virtual clock. */
  latency?: number | ((key: string) => number);
  /** Keys that fail, with the message they fail with. */
  fail?: Map<string, string>;
}

export class MockStore implements ChunkStore {
  readonly requests: string[] = [];
  readonly aborted: string[] = [];
  readonly delivered: string[] = [];
  /** Priority each key was asked at, latest wins, for asserting 4.5. */
  readonly priorities = new Map<string, string>();

  private bytes: Map<string, Uint8Array>;
  private latency: (key: string) => number;
  private failures: Map<string, string>;
  private waiting: Waiting[] = [];
  private now = 0;

  constructor(options: MockStoreOptions = {}) {
    this.bytes = options.bytes ?? new Map();
    const latency = options.latency ?? 0;
    this.latency = typeof latency === 'function' ? latency : () => latency;
    this.failures = options.fail ?? new Map();
  }

  get href(): string {
    return 'mock://store/';
  }

  /** Requests issued and not yet settled. */
  get inFlight(): number {
    return this.waiting.length;
  }

  get(key: string, options?: ChunkOptions): Promise<Uint8Array | undefined> {
    this.requests.push(key);
    if (options?.priority) this.priorities.set(key, options.priority);

    return new Promise<Uint8Array | undefined>((resolve, reject) => {
      const entry: Waiting = {
        key,
        due: this.now + this.latency(key),
        resolve,
        reject,
        cleanup: () => undefined,
      };

      const signal = options?.signal;
      if (signal?.aborted) {
        this.aborted.push(key);
        reject(abortError());
        return;
      }
      if (signal) {
        const onAbort = () => {
          this.waiting = this.waiting.filter((held) => held !== entry);
          this.aborted.push(key);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.waiting.push(entry);
    });
  }

  /**
   * Move the clock and settle everything now due.
   *
   * Returns a promise that resolves after the microtasks the settled requests
   * queue, so a test can await it and see what the scheduler did next.
   */
  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = this.waiting.filter((entry) => entry.due <= this.now);
    this.waiting = this.waiting.filter((entry) => entry.due > this.now);
    for (const entry of due) this.settleOne(entry);
    await flush();
  }

  /** Settle everything outstanding, whatever its latency. */
  async settle(): Promise<void> {
    const due = this.waiting;
    this.waiting = [];
    for (const entry of due) this.settleOne(entry);
    await flush();
  }

  /** Forget what was asked for, so a test can assert about one interaction. */
  reset() {
    this.requests.length = 0;
    this.aborted.length = 0;
    this.delivered.length = 0;
    this.priorities.clear();
  }

  private settleOne(entry: Waiting) {
    entry.cleanup();
    const failure = this.failures.get(entry.key);
    if (failure !== undefined) {
      entry.reject(new Error(failure));
      return;
    }
    this.delivered.push(entry.key);
    entry.resolve(this.bytes.get(entry.key));
  }
}

/** What fetch rejects with on abort, so callers can recognise it the same way. */
function abortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('the request was aborted', 'AbortError');
  }
  const error = new Error('the request was aborted');
  error.name = 'AbortError';
  return error;
}

/** Let queued microtasks run, so a caller sees what the settled request caused. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
