/**
 * Drawing a plain Sv dataset, with no pyramid.
 *
 * The viewer is built for a store `aa-echogram build` wrote: levels, per level
 * geometry sidecars, float16 with a sentinel. This reads the other thing people
 * have, which is the zarr an echopype pipeline produced, holding `Sv` or
 * `Sv_corrected` and its coordinates and nothing else.
 *
 * The whole approach is to make one of those look like a one level pyramid.
 * Everything above the data layer works off `Multiscales` and a `LevelReader`,
 * so synthesising both means tiles, layers, differences and statistics need no
 * idea any of this happened.
 *
 * **It is the slow path and is meant to be.** A pyramid exists so that an
 * overview reads a small array; without one, every zoom reads level zero. Worse,
 * a dataset written for processing is chunked for processing: a real one
 * measured here holds 5 channels by 2000 pings by 391 samples in a chunk, which
 * is 31 MB of float64 decompressed to answer a request for one channel. Nothing
 * here can fix that, and nothing here pretends to. Build a pyramid when the
 * survey matters; use this to look at what you have.
 *
 * **Derived, not read.** `range_start` and `range_step` come from the first
 * samples of `depth` or `echo_range`, which is a linear ramp per ping. The ramp
 * is checked rather than assumed, because a store where it does not hold would
 * otherwise be drawn at confidently wrong depths.
 */

import * as zarr from 'zarrita';

import {
  type AxisOrder,
  type ChannelGeometry,
  type ChannelValues,
  type ChunkOptions,
  type ChunkStore,
  type LevelEntry,
  type LevelReader,
  type LevelSource,
  type Multiscales,
  StoreError,
} from './contract';
import { NODATA, canConvert, toFloat16Bits } from './values';

/** Value variables looked for, best first. */
const VALUE_NAMES = ['Sv_corrected', 'Sv_Corrected', 'Sv'];

/** Vertical coordinates looked for, best first. */
const RANGE_NAMES = ['depth', 'echo_range'];

/** Dimension names, in the order the viewer needs them. */
const CHANNEL_DIM = 'channel';
const PING_DIM = 'ping_time';
const SAMPLE_DIM = 'range_sample';

/** Samples read to fit the ramp. Three, so the fit can be checked. */
const RAMP_SAMPLES = 3;

/**
 * How far the third sample may sit from where the first two put it.
 *
 * A fraction of one sample spacing. Generous, since the values are float64
 * differences of similar magnitudes, but tight enough that a genuinely curved
 * or irregular vertical is refused rather than flattened.
 */
const RAMP_TOLERANCE = 0.01;

type Array3 = zarr.Array<zarr.DataType, ChunkStore>;

/** What a plain store turned out to hold. */
export interface PlainStore {
  multiscales: Multiscales;
  level: LevelReader;
}

/**
 * Read a plain Sv dataset as a one level pyramid, or say what is missing.
 *
 * Every failure names the variable it wanted and what it found, because the
 * likeliest cause is a dataset from a step earlier or later in a pipeline than
 * the one that produces Sv.
 */
export async function openPlainStore(
  root: zarr.Location<ChunkStore>,
): Promise<PlainStore> {
  if (!canConvert()) {
    throw new StoreError(
      'this browser has no Float16Array, which reading a plain Sv dataset ' +
        'needs in order to convert it for the value texture. A store built by ' +
        'aa-echogram build is already float16 and opens without it.',
    );
  }

  const values = await openFirst(root, VALUE_NAMES);
  if (!values) {
    throw new StoreError(
      `no multiscales attribute and no ${VALUE_NAMES.join(', ')} variable, so ` +
        'this is neither a store built by aa-echogram build nor a dataset ' +
        'holding Sv.',
    );
  }

  const order = dimensionsOf(values.array, values.name);
  const shape = axes(values.array, order, values.name);

  const range = await openFirst(root, RANGE_NAMES);
  if (!range) {
    throw new StoreError(
      `${values.name} has no vertical coordinate beside it. One of ` +
        `${RANGE_NAMES.join(' or ')} is needed to know what depth a sample is at.`,
    );
  }

  const geometry = await readRamp(range.array, range.name, shape);
  const pingTime = await readCoordinate(root, PING_DIM);
  if (!pingTime) {
    throw new StoreError(`${values.name} has no ${PING_DIM} coordinate.`);
  }
  if (pingTime.length !== shape.pings) {
    throw new StoreError(
      `${PING_DIM} has ${pingTime.length} entries and ${values.name} has ` +
        `${shape.pings} pings, so they do not describe the same data.`,
    );
  }

  const frequencies = await readCoordinate(root, 'frequency_nominal');
  const names = await readChannelNames(root);

  const entry: LevelEntry = {
    path: '',
    factors: { ping: 1, sample: 1 },
    chunks: [...(values.array.chunks ?? [])],
  };

  const multiscales: Multiscales = {
    name: values.name,
    axes: [
      { name: CHANNEL_DIM, type: 'channel', indexable: true },
      { name: 'ping', type: 'time' },
      { name: 'sample', type: 'range' },
    ],
    datasets: [entry],
    // Named for what it is. Nothing was aggregated, because there is only the
    // one level, and a host reporting "linear_mean" here would be claiming a
    // reduction that never ran.
    aggregation: 'none',
    nodata: NODATA,
    nodataThreshold: NODATA / 2,
    dataType: 'Sv',
    channelDim: CHANNEL_DIM,
    verticalRef: range.name === 'depth' ? 'depth' : 'range',
    rangeVar: range.name,
    channelNames: names,
    channelFrequencies: frequencies ? [...frequencies] : undefined,
  };

  return {
    multiscales,
    level: new PlainLevel(entry, values.array, values.name, shape, order, geometry, {
      ping_time: pingTime,
      range_start: geometry.start,
      range_step: geometry.step,
    }),
  };
}

interface Shape {
  channels: number;
  pings: number;
  samples: number;
}

interface Ramp {
  /** Metres to the first sample, per channel then ping. */
  start: Float64Array;
  /** Metres between samples, per channel then ping. */
  step: Float64Array;
}

/** One level over a plain array, converting on the way past. */
class PlainLevel implements LevelReader {
  readonly index = 0;

  /** float64 or float32 with NaN, in whatever order the writer chose. */
  readonly source: LevelSource;

  constructor(
    readonly entry: LevelEntry,
    private array: Array3,
    readonly valueName: string,
    private shape: Shape,
    private order: AxisOrder,
    private ramp: Ramp,
    private sidecars: Record<string, Float64Array>,
  ) {
    this.source = { order, convert: true };
  }

  get channels(): number {
    return this.shape.channels;
  }

  get pings(): number {
    return this.shape.pings;
  }

  get samples(): number {
    return this.shape.samples;
  }

  async readWindow(
    channel: number,
    pings: [number, number],
    samples: [number, number],
    options: ChunkOptions = {},
  ): Promise<ChannelValues> {
    if (channel < 0 || channel >= this.channels) {
      throw new StoreError(`channel ${channel} outside 0 to ${this.channels - 1}`);
    }
    const selection = select(this.order, channel, pings, samples);
    const chunk = await zarr.get(this.array, selection, { signal: options.signal });
    return {
      data: toFloat16Bits(chunk.data as ArrayLike<number>, NODATA),
      pings: pings[1] - pings[0],
      samples: samples[1] - samples[0],
    };
  }

  /**
   * One channel in full.
   *
   * Here for the interface rather than because it is a good idea on this path:
   * a plain dataset has one level, so this is the whole survey at full
   * resolution and nothing in the viewer asks for it.
   */
  async readChannel(channel: number): Promise<ChannelValues> {
    return this.readWindow(channel, [0, this.pings], [0, this.samples]);
  }

  async readSidecar(name: string): Promise<Float64Array | undefined> {
    return this.sidecars[name];
  }

  async geometry(channel: number): Promise<ChannelGeometry> {
    const offset = channel * this.pings;
    return {
      rangeStart: this.ramp.start.slice(offset, offset + this.pings),
      rangeStep: this.ramp.step.slice(offset, offset + this.pings),
    };
  }
}

/**
 * A selection that always comes back as (ping, sample).
 *
 * The channel axis is indexed rather than sliced, which drops it, so whichever
 * of the three positions it occupies the answer is two dimensional in the order
 * the remaining axes appear. A store whose ping and sample axes are the other
 * way round is refused at open rather than transposed here.
 */
function select(
  order: AxisOrder,
  channel: number,
  pings: [number, number],
  samples: [number, number],
): (number | zarr.Slice)[] {
  const selection: (number | zarr.Slice)[] = [];
  selection[order.channel] = channel;
  selection[order.ping] = zarr.slice(pings[0], pings[1]);
  selection[order.sample] = zarr.slice(samples[0], samples[1]);
  return selection;
}

async function openFirst(
  root: zarr.Location<ChunkStore>,
  names: string[],
): Promise<{ name: string; array: Array3 } | undefined> {
  for (const name of names) {
    try {
      const array = await zarr.open(root.resolve(name), { kind: 'array' });
      return { name, array: array as Array3 };
    } catch (error) {
      if (error instanceof zarr.NotFoundError) continue;
      throw error;
    }
  }
  return undefined;
}

/**
 * Which axis is which, from the names the writer recorded.
 *
 * Not by position. A real store measured here holds `Sv` as
 * (channel, ping_time, range_sample) and `depth` as
 * (ping_time, channel, range_sample), in the same group, so assuming an order
 * would read the vertical of the wrong ping for every sample on screen.
 */
function dimensionsOf(array: Array3, name: string): AxisOrder {
  const listed = dimensionNames(array);
  if (!listed) {
    throw new StoreError(
      `${name} does not record its dimension names, so which axis is the ` +
        'channel and which the ping cannot be known. xarray writes these as ' +
        '_ARRAY_DIMENSIONS in zarr v2 and as dimension_names in v3.',
    );
  }
  const order = {
    channel: listed.indexOf(CHANNEL_DIM),
    ping: listed.indexOf(PING_DIM),
    sample: listed.indexOf(SAMPLE_DIM),
  };
  const missing = Object.entries(order)
    .filter(([, index]) => index < 0)
    .map(([axis]) => axis);
  if (missing.length) {
    throw new StoreError(
      `${name} has dimensions (${listed.join(', ')}), which is missing ` +
        `${missing.join(' and ')}. Expected ${CHANNEL_DIM}, ${PING_DIM} and ` +
        `${SAMPLE_DIM}.`,
    );
  }
  return order;
}

function dimensionNames(array: Array3): string[] | undefined {
  // zarr v2 as xarray writes it, then v3, where it is array metadata rather
  // than an attribute.
  const attribute = (array.attrs as { _ARRAY_DIMENSIONS?: unknown })._ARRAY_DIMENSIONS;
  if (Array.isArray(attribute)) return attribute.map(String);
  const declared = (array as { dimension_names?: unknown }).dimension_names;
  if (Array.isArray(declared) && declared.every((name) => typeof name === 'string')) {
    return declared as string[];
  }
  return undefined;
}

function axes(array: Array3, order: AxisOrder, name: string): Shape {
  if (array.shape.length !== 3) {
    throw new StoreError(
      `${name} has ${array.shape.length} dimensions and three are needed: ` +
        `${CHANNEL_DIM}, ${PING_DIM} and ${SAMPLE_DIM}.`,
    );
  }
  return {
    channels: array.shape[order.channel],
    pings: array.shape[order.ping],
    samples: array.shape[order.sample],
  };
}

/**
 * Fit each ping's vertical to a straight line, and check that it is one.
 *
 * Three samples per ping rather than two. Two always fit a line and would make
 * the check vacuous; the third is what catches a vertical that is not evenly
 * spaced, which the rest of the viewer assumes everywhere.
 */
async function readRamp(
  array: Array3,
  name: string,
  shape: Shape,
): Promise<Ramp> {
  const order = dimensionsOf(array, name);
  const held = axes(array, order, name);
  if (held.channels !== shape.channels || held.pings !== shape.pings) {
    throw new StoreError(
      `${name} covers ${held.channels} channels by ${held.pings} pings and the ` +
        `values cover ${shape.channels} by ${shape.pings}.`,
    );
  }
  const wanted = Math.min(RAMP_SAMPLES, held.samples);
  if (wanted < 2) {
    throw new StoreError(`${name} has ${held.samples} samples, so it has no spacing.`);
  }

  const start = new Float64Array(shape.channels * shape.pings);
  const step = new Float64Array(shape.channels * shape.pings);
  let checked = 0;

  for (let channel = 0; channel < shape.channels; channel += 1) {
    const chunk = await zarr.get(
      array,
      select(order, channel, [0, shape.pings], [0, wanted]),
    );
    const values = chunk.data as ArrayLike<number>;
    for (let ping = 0; ping < shape.pings; ping += 1) {
      const base = ping * wanted;
      const first = values[base];
      const second = values[base + 1];
      const spacing = second - first;
      const at = channel * shape.pings + ping;
      // A ping with no vertical at all is left at zero and masked away by its
      // values, which are nodata for the same reason.
      if (!Number.isFinite(first) || !Number.isFinite(spacing)) continue;
      start[at] = first;
      step[at] = spacing;

      if (wanted < 3 || checked > 4096) continue;
      const third = values[base + 2];
      if (!Number.isFinite(third)) continue;
      checked += 1;
      const predicted = first + 2 * spacing;
      if (Math.abs(third - predicted) > Math.abs(spacing) * RAMP_TOLERANCE) {
        throw new StoreError(
          `${name} is not evenly spaced at ping ${ping} of channel ${channel}: ` +
            `samples are ${first}, ${second}, ${third}, and an even ramp would ` +
            `put the third at ${predicted}. The viewer positions every sample ` +
            'from a start and a step, so it cannot draw this correctly.',
        );
      }
    }
  }
  return { start, step };
}

async function readCoordinate(
  root: zarr.Location<ChunkStore>,
  name: string,
): Promise<Float64Array | undefined> {
  const found = await openFirst(root, [name]);
  if (!found) return undefined;
  const chunk = await zarr.get(found.array, null);
  const data = chunk.data;
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = Number(data[i]);
    return out;
  }
  return Float64Array.from(data as ArrayLike<number>);
}

/** Channel names, where the coordinate holds strings rather than numbers. */
async function readChannelNames(
  root: zarr.Location<ChunkStore>,
): Promise<string[] | undefined> {
  const found = await openFirst(root, [CHANNEL_DIM]);
  if (!found) return undefined;
  try {
    const chunk = await zarr.get(found.array, null);
    // Through the iterator, not by index. A fixed width unicode column decodes
    // to zarrita's UnicodeStringArray, which stores its characters packed and
    // has no indexed properties: reading data[i] gives undefined for every
    // entry, and String() of that is the word "undefined" in every label.
    const names = Array.from(chunk.data as Iterable<unknown>, (value) => String(value));
    if (!names.length || names.some((name) => !name || name === 'undefined')) {
      return undefined;
    }
    return names;
  } catch {
    // A dtype this build cannot decode is a missing label, not a failure to
    // open the store: the channels are still there and still indexable.
    return undefined;
  }
}
