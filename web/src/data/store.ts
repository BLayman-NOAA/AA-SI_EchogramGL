/**
 * Store access.
 *
 * The store is a zarr group with a multiscales attribute, described in
 * Software_Architecture.md section 3. This module opens one, exposes its levels
 * and reads a channel, and knows nothing about where the bytes come from.
 */

import * as zarr from 'zarrita';

import {
  type AxisOrder,
  type Axis,
  type ChannelGeometry,
  type ChannelValues,
  type ChunkOptions,
  type ChunkStore,
  type LevelEntry,
  type LevelReader,
  type LevelSource,
  type Multiscales,
  type RequestPriority,
  StoreError,
} from './contract';
import { openPlainStore } from './plain';

// Re-exported so that every existing importer of this module keeps working and
// callers have one place to reach for. The definitions live in contract.ts.
export type {
  AxisOrder,
  Axis,
  ChannelGeometry,
  ChannelValues,
  ChunkOptions,
  ChunkStore,
  LevelEntry,
  LevelReader,
  LevelSource,
  Multiscales,
  RequestPriority,
};
export { StoreError };

/**
 * Carries a request's priority past a library that will not forward it.
 *
 * zarrita builds its own options object for the store call and copies only the
 * signal across, so a priority handed to `zarr.get` never reaches the store.
 * The signal does reach it, and a signal is unique to one request, so it serves
 * as the handle: the reader tags the signal it is about to pass, and this reads
 * the tag back when the call arrives. Weakly held, so a finished request's tag
 * goes away with the controller that owned it.
 */
export class PriorityStore implements ChunkStore {
  private tags = new WeakMap<AbortSignal, RequestPriority>();

  constructor(private inner: ChunkStore) {}

  get href(): string | undefined {
    return (this.inner as { href?: string }).href;
  }

  tag(signal: AbortSignal, priority: RequestPriority) {
    this.tags.set(signal, priority);
  }

  get(key: string, options?: ChunkOptions): Promise<Uint8Array | undefined> {
    const tagged = options?.signal ? this.tags.get(options.signal) : undefined;
    const priority = options?.priority ?? tagged;
    return this.inner.get(key, priority ? { ...options, priority } : options);
  }
}

export class Level implements LevelReader {
  constructor(
    readonly index: number,
    readonly entry: LevelEntry,
    private group: zarr.Location<ChunkStore>,
    private values: zarr.Array<zarr.DataType, ChunkStore>,
    readonly valueName: string,
  ) {}

  get shape(): number[] {
    return this.values.shape;
  }

  get channels(): number {
    return this.values.shape[0];
  }

  get pings(): number {
    return this.values.shape[1];
  }

  get samples(): number {
    return this.values.shape[2];
  }

  /** Read one channel of this level in full. */
  async readChannel(channel: number): Promise<ChannelValues> {
    return this.readWindow(channel, [0, this.pings], [0, this.samples]);
  }

  /**
   * Read a rectangle of one channel, both ranges end exclusive.
   *
   * A tile at a time rather than a level at a time, so a survey larger than
   * memory is not read into memory to draw a screen of it. The store decides
   * which chunks that touches; the caller asks in level coordinates.
   */
  async readWindow(
    channel: number,
    pings: [number, number],
    samples: [number, number],
    options: ChunkOptions = {},
  ): Promise<ChannelValues> {
    if (channel < 0 || channel >= this.channels) {
      throw new StoreError(`channel ${channel} outside 0 to ${this.channels - 1}`);
    }
    check('ping', pings, this.pings);
    check('sample', samples, this.samples);

    const chunk = await zarr.get(
      this.values,
      [channel, zarr.slice(pings[0], pings[1]), zarr.slice(samples[0], samples[1])],
      // Only the signal survives the trip: zarrita rebuilds the options object
      // for the store call. PriorityStore is what carries the rest.
      { signal: options.signal },
    );
    return {
      data: asFloat16Bits(chunk.data),
      pings: chunk.shape[0],
      samples: chunk.shape[1],
    };
  }

  /** Read a sidecar array as float64, or undefined if it is not present. */
  async readSidecar(name: string): Promise<Float64Array | undefined> {
    let array;
    try {
      array = await zarr.open(this.group.resolve(name), { kind: 'array' });
    } catch (error) {
      // Only an absent sidecar is an absence. A network or metadata failure
      // has to keep its own message rather than become a missing field.
      if (error instanceof zarr.NotFoundError) return undefined;
      throw error;
    }
    const chunk = await zarr.get(array, null);
    return toFloat64(chunk.data);
  }

  /** Vertical geometry for one channel. */
  async geometry(channel: number): Promise<ChannelGeometry> {
    const start = await this.readSidecar('range_start');
    const step = await this.readSidecar('range_step');
    if (!start || !step) {
      throw new StoreError('level has no range_start or range_step sidecar');
    }
    const offset = channel * this.pings;
    return {
      rangeStart: start.slice(offset, offset + this.pings),
      rangeStep: step.slice(offset, offset + this.pings),
    };
  }
}

export class EchogramStore {
  private levels = new Map<number, LevelReader>();

  constructor(
    readonly multiscales: Multiscales,
    private root: zarr.Location<ChunkStore>,
    /** Where the per chunk summaries live, where the builder wrote any. */
    readonly summaryPath?: string,
    /**
     * The single level of a plain Sv dataset, where this is one of those.
     *
     * Its presence is also what says so, which callers use to decide what they
     * can assume: a plain store has one level, no summaries, and values that
     * were converted on the way past rather than stored ready to upload.
     */
    readonly plain?: LevelReader,
  ) {}

  /** Whether this was adapted from a plain Sv dataset rather than built. */
  get isPlain(): boolean {
    return this.plain !== undefined;
  }

  get levelCount(): number {
    return this.multiscales.datasets.length;
  }

  async level(index: number): Promise<LevelReader> {
    if (this.plain) {
      if (index !== 0) throw new StoreError(`no level ${index}: this store has one`);
      return this.plain;
    }
    const cached = this.levels.get(index);
    if (cached) return cached;

    const entry = this.multiscales.datasets[index];
    if (!entry) throw new StoreError(`no level ${index}`);
    if (entry.path.includes('://')) {
      throw new StoreError(`level ${index} lives in another store, not yet read`);
    }

    const group = this.root.resolve(entry.path);
    const values = await zarr.open(group.resolve(this.multiscales.name), {
      kind: 'array',
    });
    const level = new Level(index, entry, group, values, this.multiscales.name);
    this.levels.set(index, level);
    return level;
  }
}

/** Open a store and read its multiscales block. */
export async function openEchogramStore(store: ChunkStore): Promise<EchogramStore> {
  let root;
  try {
    root = await zarr.open(store, { kind: 'group' });
  } catch (error) {
    // zarrita says only that a v3 array or group was not found, which leaves a
    // user who mistyped a path with nothing to go on.
    if (error instanceof zarr.NotFoundError) {
      throw new StoreError(
        `no zarr.json at ${describe(store)}. A store URL points at the ` +
          `directory that holds zarr.json, not at the one above it.`,
      );
    }
    throw error;
  }

  const blocks = root.attrs.multiscales as Multiscales[] | undefined;
  if (!blocks || !blocks.length) {
    // Not a built store. It may still be a dataset holding Sv, which is worth
    // drawing even though every zoom will read the one level it has.
    const plain = await openPlainStore(root).catch((error) => {
      if (error instanceof StoreError) {
        throw new StoreError(
          `${describe(store)} has no multiscales attribute, so it was not ` +
            `written by aa-echogram build, and it could not be read as a plain ` +
            `Sv dataset either. ${error.message}`,
        );
      }
      throw error;
    });
    return new EchogramStore(plain.multiscales, root, undefined, plain.level);
  }
  const summaries = root.attrs.chunkSummaries;
  return new EchogramStore(
    blocks[0],
    root,
    typeof summaries === 'string' ? summaries : undefined,
  );
}

/** Refuse a window outside the level, rather than reading a surprising shape. */
function check(axis: string, range: [number, number], size: number) {
  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new StoreError(`${axis} range ${start} to ${end} is not whole`);
  }
  if (start < 0 || end > size || end <= start) {
    throw new StoreError(`${axis} range ${start} to ${end} outside 0 to ${size}`);
  }
}

/** Name the store in an error, when it can say where it reads from. */
function describe(store: ChunkStore): string {
  const href = (store as { href?: string }).href;
  return href ?? 'this store';
}

/**
 * Convert a decoded sidecar to float64.
 *
 * `ping_time` is int64 nanoseconds and decodes to a `BigInt64Array`, which
 * `Float64Array.from` refuses outright, so bigints are converted one at a time.
 * Nanoseconds exceed what a double holds exactly, which is why section 5.2 of
 * the architecture subtracts a per view epoch before anything reaches a shader.
 */
function toFloat64(data: zarr.TypedArray<zarr.DataType>): Float64Array {
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = Number(data[i]);
    return out;
  }
  return Float64Array.from(data as ArrayLike<number>);
}

/**
 * Reinterpret decoded values as raw float16 bits.
 *
 * The store holds float16 and the texture takes float16, so the bytes pass
 * through untouched. The contract requires that dtype, so anything else is a
 * store problem worth naming rather than converting around.
 */
function asFloat16Bits(
  data: zarr.TypedArray<zarr.DataType>,
): Uint16Array<ArrayBuffer> {
  if (!ArrayBuffer.isView(data)) {
    throw new StoreError('value array did not decode to a typed array');
  }
  const elements = (data as ArrayBufferView & { length: number }).length;
  if (data.byteLength !== elements * 2) {
    throw new StoreError('value array is not float16, which the contract requires');
  }
  return new Uint16Array(data.buffer as ArrayBuffer, data.byteOffset, elements);
}
