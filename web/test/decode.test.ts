import { describe, expect, it, vi } from 'vitest';

import {
  DecodePool,
  createDecodePool,
  type DecodeRequest,
  type DecodeResult,
  type WorkerLike,
} from '../src/data/decode';

/**
 * A worker that records what it was sent and answers when told to.
 *
 * The pool's job is which worker gets which request and what happens when one
 * is cancelled, so the decoding itself is out of the way here.
 */
class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  sent: (DecodeRequest | { cancel: number })[] = [];
  terminated = false;
  onmessage: ((event: { data: DecodeResult }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(message: unknown) {
    this.sent.push(message as DecodeRequest);
  }

  terminate() {
    this.terminated = true;
  }

  /** Answer the request at the head of what it was sent. */
  answer(id: number, values = 4) {
    this.onmessage?.({
      data: { id, data: new Uint16Array(values), pings: 2, samples: 2 },
    });
  }

  fail(id: number, message: string) {
    this.onmessage?.({ data: { id, error: message } });
  }
}

function pool(size = 2) {
  FakeWorker.all = [];
  return new DecodePool({ size, spawn: () => new FakeWorker() });
}

const window = {
  href: 'http://example/store/',
  path: '0',
  valueName: 'Sv',
  channel: 0,
  pings: [0, 2048] as [number, number],
  samples: [0, 512] as [number, number],
};

describe('decode pool', () => {
  it('spreads requests across workers', () => {
    const decode = pool(2);
    void decode.read(window);
    void decode.read(window);
    expect(FakeWorker.all[0].sent).toHaveLength(1);
    expect(FakeWorker.all[1].sent).toHaveLength(1);
    expect(decode.inFlight).toBe(2);
  });

  it('queues past the pool size and drains as workers free up', () => {
    const decode = pool(1);
    void decode.read(window);
    void decode.read(window);
    expect(decode.inFlight).toBe(1);
    expect(decode.queued).toBe(1);

    const worker = FakeWorker.all[0];
    worker.answer((worker.sent[0] as DecodeRequest).id);
    expect(decode.queued).toBe(0);
    expect(worker.sent).toHaveLength(2);
  });

  it('resolves with the values the worker sent', async () => {
    const decode = pool(1);
    const pending = decode.read(window);
    const worker = FakeWorker.all[0];
    worker.answer((worker.sent[0] as DecodeRequest).id, 8);

    const found = await pending;
    expect(found.data).toHaveLength(8);
    expect(found.pings).toBe(2);
  });

  it('rejects a request the worker could not read', async () => {
    const decode = pool(1);
    const pending = decode.read(window);
    const worker = FakeWorker.all[0];
    worker.fail((worker.sent[0] as DecodeRequest).id, 'no such chunk');

    await expect(pending).rejects.toThrow('no such chunk');
  });

  it('never sends a request abandoned before a worker took it', async () => {
    const decode = pool(1);
    void decode.read(window);
    const controller = new AbortController();
    const second = decode.read(window, controller.signal);
    controller.abort();

    await expect(second).rejects.toThrow(/abort/i);
    expect(FakeWorker.all[0].sent).toHaveLength(1);
  });

  it('tells a worker to stop on a request already with it', async () => {
    const decode = pool(1);
    const controller = new AbortController();
    const pending = decode.read(window, controller.signal);
    const worker = FakeWorker.all[0];
    const id = (worker.sent[0] as DecodeRequest).id;
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(worker.sent[1]).toEqual({ cancel: id });
  });

  it('frees the worker when a cancelled request finally answers', () => {
    // The worker answers with an error nobody is waiting for. That is what
    // returns it to the idle list, so a cancel does not leak a slot.
    const decode = pool(1);
    const controller = new AbortController();
    const pending = decode.read(window, controller.signal);
    pending.catch(() => undefined);
    const worker = FakeWorker.all[0];
    const id = (worker.sent[0] as DecodeRequest).id;
    controller.abort();
    worker.fail(id, 'aborted');

    void decode.read(window);
    expect(decode.inFlight).toBe(1);
    expect(decode.queued).toBe(0);
  });

  it('reports a worker that died rather than hanging on it', async () => {
    const decode = pool(1);
    const pending = decode.read(window);
    FakeWorker.all[0].onerror?.({});
    await expect(pending).rejects.toThrow(/worker/);
  });

  it('refuses a rejected request quietly once destroyed', async () => {
    const decode = pool(2);
    const spy = vi.fn();
    decode.destroy();
    expect(FakeWorker.all.every((worker) => worker.terminated)).toBe(true);
    await decode.read(window).catch(spy);
    expect(spy).toHaveBeenCalled();
  });
});

describe('starting a pool', () => {
  it('gives nothing without a way to start a worker', () => {
    // No default. The URL of the worker file is resolved by whichever bundler
    // compiles the line containing it, so a default in the library would be a
    // path correct for this project and wrong inside every host embedding it.
    expect(createDecodePool(2)).toBeUndefined();
  });

  it('uses the spawn a host supplies', () => {
    FakeWorker.all = [];
    const pool = createDecodePool(3, () => new FakeWorker());
    expect(pool?.size).toBe(3);
    expect(FakeWorker.all).toHaveLength(3);
  });

  it('is an absence rather than an error when spawning throws', () => {
    // A host whose worker will not build still gets a working viewer, decoding
    // on the main thread.
    expect(
      createDecodePool(1, () => {
        throw new Error('no worker here');
      }),
    ).toBeUndefined();
  });
});
