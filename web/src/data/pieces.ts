/**
 * Datasets described by a header, laid side by side in time.
 *
 * A dataset a processing step wrote carries coordinates rather than the
 * geometry sidecars a pyramid has, in whatever shape the step left them. A
 * server works the geometry out and sends it as a header, so here there is
 * nothing to derive: the header becomes a one level store, and only the value
 * chunks are read through zarr.
 *
 * A `PieceSetSpec` is how a host hands over many of them: where each one's
 * header and values are, and where it sits in time. How the host found them,
 * from a recipe, a cache or a list of paths, is its own business.
 */

import * as zarr from 'zarrita';

import {
  type AxisOrder,
  type ChunkStore,
  type LevelEntry,
  type Multiscales,
  StoreError,
} from './contract';
import { PlainLevel } from './plain';
import { EchogramStore } from './store';

/** One dataset of a piece set: where it is, and where it sits in time. */
export interface PieceSpec {
  /** Unique within its set; it names the piece's store. */
  id: string;
  /** What to call it, such as the raw file it came from. */
  label?: string;
  /** First and last ping, nanoseconds since 1970. */
  start: number;
  end: number;
  pings: number;
  channels: number;
  samples: number;
  /** Stored bytes of its values, compressed, every channel, where known. */
  bytes?: number | null;
  /** URL of its header, which `fetchJson` reads as a `Header`. */
  header: string;
  /** URL of the zarr group holding its values. */
  store: string;
}

/** Many datasets laid side by side in time, opened as one source. */
export interface PieceSetSpec {
  /** What to call the set in messages, such as the step that wrote it. */
  name: string;
  pieces: PieceSpec[];
}

/** Whether a value is a piece set rather than a store. */
export function isPieceSet(value: unknown): value is PieceSetSpec {
  const spec = value as Partial<PieceSetSpec> | null | undefined;
  return (
    typeof spec === 'object' &&
    spec !== null &&
    typeof spec.name === 'string' &&
    Array.isArray(spec.pieces)
  );
}

/** A sidecar as the header carries it: little endian float64, base64. */
interface EncodedArray {
  shape: number[];
  data: string;
}

/** What `/api/describe/<mount>` answers for one dataset. */
export interface Header {
  var: string;
  kind: 'sv' | 'mvbs' | 'labels';
  dims: string[];
  order: { channel: number | null; ping: number; sample: number };
  shape: number[];
  chunks: number[];
  dtype: string;
  channels: number;
  pings: number;
  samples: number;
  dataType: string;
  verticalRef: 'range' | 'depth';
  rangeVar: string;
  gridded: boolean;
  hasGps: boolean;
  channelNames?: string[] | null;
  channelFrequencies?: number[] | null;
  nodata: number;
  nodataThreshold: number;
  sidecars: Record<string, EncodedArray>;
}

/** Read a JSON answer from the server, or say what it reported. */
export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StoreError(`${response.status} from ${url}: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? response.statusText;
    throw new StoreError(message);
  }
  return body as T;
}

/** Decode one sidecar. */
export function decodeArray(encoded: EncodedArray): Float64Array {
  const text = atob(encoded.data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return new Float64Array(bytes.buffer);
}

/** The multiscales block a described dataset stands in for. */
export function multiscalesOf(header: Header): Multiscales {
  return {
    name: header.var,
    axes: [
      { name: 'channel', type: 'channel', indexable: true },
      { name: 'ping', type: 'time' },
      { name: 'sample', type: 'range' },
    ],
    datasets: [levelEntry(header)],
    aggregation: 'none',
    nodata: header.nodata,
    nodataThreshold: header.nodataThreshold,
    dataType: header.dataType,
    channelDim: header.order.channel === null ? null : header.dims[header.order.channel],
    verticalRef: header.verticalRef,
    rangeVar: header.rangeVar,
    channelNames: header.channelNames ?? undefined,
    channelFrequencies: header.channelFrequencies ?? undefined,
  };
}

function levelEntry(header: Header): LevelEntry {
  return { path: '', factors: { ping: 1, sample: 1 }, chunks: header.chunks };
}

/**
 * Open a described dataset as a one level store.
 *
 * One request beyond the header: the value array's own metadata, which zarr
 * needs for its codecs. The geometry comes from the header.
 */
export async function describedStore(
  header: Header,
  chunks: ChunkStore,
): Promise<EchogramStore> {
  if (header.order.ping > header.order.sample) {
    throw new StoreError(
      `${header.var} stores its samples before its pings, which the viewer ` +
        'cannot read without a transpose.',
    );
  }
  const root = zarr.root(chunks);
  const array = await zarr.open(root.resolve(header.var), { kind: 'array' });
  const order: AxisOrder = {
    channel: header.order.channel ?? -1,
    ping: header.order.ping,
    sample: header.order.sample,
  };
  const sidecars: Record<string, Float64Array> = {};
  for (const [name, encoded] of Object.entries(header.sidecars)) {
    sidecars[name] = decodeArray(encoded);
  }
  const start = sidecars.range_start;
  const step = sidecars.range_step;
  if (!start || !step || !sidecars.ping_time) {
    throw new StoreError(`the header for ${header.var} carries no geometry`);
  }
  const level = new PlainLevel(
    levelEntry(header),
    array as zarr.Array<zarr.DataType, ChunkStore>,
    header.var,
    { channels: header.channels, pings: header.pings, samples: header.samples },
    order,
    { start, step },
    sidecars,
  );
  return new EchogramStore(multiscalesOf(header), root, undefined, level);
}
