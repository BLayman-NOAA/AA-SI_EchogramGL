/**
 * Per chunk summaries, from the sidecar the builder writes.
 *
 * Architecture section 3.7. The client uses them for one thing: a chunk marked
 * `allNodata` is never requested. On seafloor masked data the array below the
 * bottom is sentinel all the way down, and `read_seafloor_line` masks whole
 * pings away, so the chunks covering that water hold nothing worth a round trip.
 *
 * A tile is skipped only when every chunk it touches is empty. A tile spans
 * whatever chunks it spans, and one live chunk anywhere inside it means the
 * tile has something to draw.
 */

import type { ChunkStore } from './store';

/** What the builder records per chunk. Only `allNodata` is read here. */
export interface ChunkSummary {
  allNodata: boolean;
  min?: number;
  max?: number;
  count?: number;
  hist?: number[];
}

/** Chunk coordinate 'channel.ping.sample' to its summary, for one level. */
export type LevelSummaries = Record<string, ChunkSummary>;

/** Level name to its chunk summaries, which is the file's shape. */
export type SummaryDocument = Record<string, LevelSummaries>;

export class Summaries {
  constructor(private document: SummaryDocument) {}

  /** Whether the sidecar says anything about a level at all. */
  has(level: number): boolean {
    return this.document[String(level)] !== undefined;
  }

  /**
   * Whether every chunk covering a window is entirely nodata.
   *
   * False whenever the answer is not certain: an absent sidecar, an absent
   * level, or a chunk the builder did not describe. Skipping a fetch on a guess
   * draws a hole and reports no problem, so the uncertain answer has to be the
   * one that fetches.
   *
   * Args:
   *   level: Level index, which names a block in the document.
   *   channel: Channel index.
   *   chunks: Chunk shape as (channel, ping, sample).
   *   pings: Ping range of the window, end exclusive.
   *   samples: Sample range of the window, end exclusive.
   */
  allNodata(
    level: number,
    channel: number,
    chunks: number[],
    pings: [number, number],
    samples: [number, number],
  ): boolean {
    const block = this.document[String(level)];
    if (!block) return false;
    if (chunks.length !== 3 || chunks.some((size) => !(size > 0))) return false;
    if (pings[1] <= pings[0] || samples[1] <= samples[0]) return false;

    const channelChunk = Math.floor(channel / chunks[0]);
    for (const p of indices(pings, chunks[1])) {
      for (const s of indices(samples, chunks[2])) {
        const summary = block[`${channelChunk}.${p}.${s}`];
        if (!summary?.allNodata) return false;
      }
    }
    return true;
  }

  /** Share of a level's chunks that hold nothing, as a measurement. */
  emptyShare(level: number): number | undefined {
    const block = this.document[String(level)];
    if (!block) return undefined;
    const entries = Object.values(block);
    if (!entries.length) return undefined;
    return entries.filter((entry) => entry.allNodata).length / entries.length;
  }
}

/**
 * Read the summary sidecar, or nothing if the store has none.
 *
 * An absent or unreadable sidecar is not an error. It only ever removes work,
 * so a store built before it existed simply fetches every chunk.
 */
export async function loadSummaries(
  store: ChunkStore,
  key: string,
): Promise<Summaries | undefined> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await store.get(key);
  } catch {
    return undefined;
  }
  if (!bytes) return undefined;
  try {
    const text = new TextDecoder().decode(bytes);
    return new Summaries(JSON.parse(text) as SummaryDocument);
  } catch {
    return undefined;
  }
}

/** Chunk indices a range falls in, both ends inclusive of the chunks touched. */
function indices(range: [number, number], size: number): number[] {
  const first = Math.floor(range[0] / size);
  const last = Math.floor((range[1] - 1) / size);
  const out: number[] = [];
  for (let index = first; index <= last; index += 1) out.push(index);
  return out;
}
