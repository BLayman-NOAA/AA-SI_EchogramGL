/**
 * The decode worker.
 *
 * Opens the level array itself and reads one window per message. An open zarr
 * array is a closure over a store and a codec pipeline, so it cannot be handed
 * across from the main thread; what crosses is the store URL and the window,
 * and the array is opened here once per level and kept.
 *
 * The decoded values go back as a transfer rather than a copy, so the buffer
 * moves and the worker gives up its reference. That is the whole point of
 * doing this here: a copy of a two megabyte tile on the main thread is the
 * cost the worker was meant to avoid.
 *
 * A plain Sv dataset is converted here too, which is the more valuable half.
 * Its chunks are written for processing rather than for drawing, and one of
 * them can be tens of megabytes of float64 to answer a request for a single
 * channel. Decompressing that and rounding it to float16 is the most expensive
 * thing the viewer does, and it is exactly what a worker is for.
 */

import * as zarr from 'zarrita';

import { FetchStore } from './FetchStore';
import type { DecodeMessage, DecodeRequest, DecodeResult } from './decode';
import { PriorityStore } from './store';
import { NODATA, toFloat16Bits } from './values';

const arrays = new Map<string, Promise<zarr.Array<zarr.DataType, PriorityStore>>>();
const stores = new Map<string, PriorityStore>();
const running = new Map<number, AbortController>();

self.onmessage = (event: MessageEvent<DecodeMessage>) => {
  const message = event.data;
  if ('cancel' in message) {
    running.get(message.cancel)?.abort();
    running.delete(message.cancel);
    return;
  }
  void handle(message);
};

async function handle(request: DecodeRequest) {
  const controller = new AbortController();
  running.set(request.id, controller);
  try {
    const array = await open(request);
    stores.get(request.href)?.tag(controller.signal, request.priority ?? 'auto');

    // Indexing the channel rather than slicing it drops that axis, so the
    // answer is two dimensional wherever the axis happened to sit.
    const order = request.order ?? { channel: 0, ping: 1, sample: 2 };
    const selection: (number | zarr.Slice)[] = [];
    if (order.channel >= 0) selection[order.channel] = request.channel;
    selection[order.ping] = zarr.slice(request.pings[0], request.pings[1]);
    selection[order.sample] = zarr.slice(request.samples[0], request.samples[1]);

    const chunk = await zarr.get(array, selection, { signal: controller.signal });
    const data = request.convert
      ? toFloat16Bits(chunk.data as ArrayLike<number | bigint>, NODATA)
      : asBits(chunk.data);
    const result: DecodeResult = {
      id: request.id,
      data,
      pings: request.pings[1] - request.pings[0],
      samples: request.samples[1] - request.samples[0],
    };
    post(result, [data.buffer]);
  } catch (error) {
    // An abort is the main thread having lost interest, and it is already not
    // waiting. Reported all the same, so the pool frees the slot either way.
    post({ id: request.id, error: describe(error) });
  } finally {
    running.delete(request.id);
  }
}

/**
 * Stores and arrays a worker keeps open.
 *
 * Bounded, because a view laying out a mapped step reads from one store per
 * file and can pass through thousands of them in a session.
 */
const OPEN_LIMIT = 64;

function open(request: DecodeRequest) {
  let store = touch(stores, request.href);
  if (!store) {
    store = new PriorityStore(new FetchStore(request.href));
    keep(stores, request.href, store);
  }
  const key = `${request.href}|${request.path}|${request.valueName}`;
  let found = touch(arrays, key);
  if (!found) {
    // An empty path is the root, which is where a plain dataset keeps its
    // values. Resolving against it would append a slash and miss.
    const group = request.path ? zarr.root(store).resolve(request.path) : zarr.root(store);
    found = zarr.open(group.resolve(request.valueName), { kind: 'array' });
    keep(arrays, key, found);
    // A failed open is not kept, so the next request asks again.
    found.catch(() => arrays.delete(key));
  }
  return found;
}

/** Read an entry and mark it most recently used. */
function touch<T>(map: Map<string, T>, key: string): T | undefined {
  const found = map.get(key);
  if (found === undefined) return undefined;
  map.delete(key);
  map.set(key, found);
  return found;
}

/** Add an entry, dropping the least recently used past the limit. */
function keep<T>(map: Map<string, T>, key: string, value: T) {
  map.set(key, value);
  while (map.size > OPEN_LIMIT) map.delete(map.keys().next().value!);
}

function post(result: DecodeResult, transfer: Transferable[] = []) {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(
    result,
    transfer,
  );
}

/** The store holds float16 and the texture takes float16, so the bytes pass through. */
function asBits(data: zarr.TypedArray<zarr.DataType>): Uint16Array<ArrayBuffer> {
  if (!ArrayBuffer.isView(data)) throw new Error('values did not decode to an array');
  const elements = (data as ArrayBufferView & { length: number }).length;
  if (data.byteLength !== elements * 2) {
    throw new Error('value array is not float16, which the contract requires');
  }
  return new Uint16Array(data.buffer as ArrayBuffer, data.byteOffset, elements);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
