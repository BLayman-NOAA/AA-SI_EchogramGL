/**
 * The shape of a store, with nothing that reads one.
 *
 * Split out because two modules need these and each other would otherwise be a
 * cycle: store.ts falls back to the plain adapter when a group has no
 * multiscales attribute, and the plain adapter builds the very types store.ts
 * defines. Types alone would not have been enough to break it, since the layer
 * check counts a type import as a dependency, and it is right to.
 */

/** Options a reader may pass with a request. Shaped as zarrita passes them. */
export interface ChunkOptions {
  signal?: AbortSignal;
  /** Visible tiles ahead of speculative ones, per architecture section 4.5. */
  priority?: RequestPriority;
}

export type RequestPriority = 'high' | 'low' | 'auto';

/** Everything the viewer needs from a byte source. */
export interface ChunkStore {
  get(key: string, options?: ChunkOptions): Promise<Uint8Array | undefined>;
}

export interface Axis {
  name: string;
  type: string;
  unit?: string;
  indexable?: boolean;
}

export interface LevelEntry {
  path: string;
  factors: Record<string, number>;
  chunks?: number[];
}

export interface Multiscales {
  name: string;
  axes: Axis[];
  datasets: LevelEntry[];
  aggregation: string;
  nodata: number;
  nodataThreshold: number;
  dataType: string;
  channelDim: string | null;
  verticalRef: 'range' | 'depth';
  rangeVar?: string;
  validXAxes?: string[];
  validYAxes?: string[];
  /** Lowest and highest value the chunk summaries binned, which the viewport
   *  histogram reuses so the two are comparable. */
  histRange?: [number, number];
  histBins?: number;
  /** Channel names, in channel order, where the builder could find them. */
  channelNames?: string[];
  /** Nominal frequency per channel in hertz, which names a layer best. */
  channelFrequencies?: number[];
}

export interface ChannelValues {
  /** Raw float16 bits, ping major, ready to upload without conversion. */
  data: Uint16Array<ArrayBuffer>;
  pings: number;
  samples: number;
}

/** Vertical geometry for one channel, as written by the builder. */
export interface ChannelGeometry {
  rangeStart: Float64Array;
  rangeStep: Float64Array;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/**
 * What the view needs of one level, however it is backed.
 *
 * A pyramid level is a stored array that already meets the contract. A plain Sv
 * dataset is the same shape of answer computed on the way past: converted from
 * whatever dtype it holds, with its geometry derived rather than read. Both
 * satisfy this, and nothing above the data layer can tell which it has.
 */
/** Where each of the three axes sits in an array's own dimension list. */
export interface AxisOrder {
  channel: number;
  ping: number;
  sample: number;
}

/**
 * How to read this level somewhere other than here.
 *
 * The decode worker opens the array itself, so it needs the two facts the main
 * thread worked out when the store opened: which axis is which, and whether the
 * values are float16 already or have to be converted. Absent means the
 * contract's answer to both, which is what a built store holds.
 */
export interface LevelSource {
  order: AxisOrder;
  convert: boolean;
}

export interface LevelReader {
  readonly index: number;
  /** Present where reading needs more than the contract's assumptions. */
  readonly source?: LevelSource;
  readonly entry: LevelEntry;
  readonly valueName: string;
  readonly channels: number;
  readonly pings: number;
  readonly samples: number;
  readWindow(
    channel: number,
    pings: [number, number],
    samples: [number, number],
    options?: ChunkOptions,
  ): Promise<ChannelValues>;
  /** One channel in full, which only a level small enough to hold is asked for. */
  readChannel(channel: number): Promise<ChannelValues>;
  readSidecar(name: string): Promise<Float64Array | undefined>;
  geometry(channel: number): Promise<ChannelGeometry>;
}
