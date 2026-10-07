import { describe, expect, it } from 'vitest';

import { resolveLayers } from '../src/app/layers';
import { PyramidSource, type SourceHost } from '../src/app/Source';
import { ArrayCache } from '../src/data/cache';
import type { ChannelValues, LevelReader, Multiscales } from '../src/data/contract';
import { EchogramStore, PriorityStore } from '../src/data/store';
import { Uploader } from '../src/data/uploader';

const PINGS = 100;
const SAMPLES = 50;

/** What the fake store holds: nodata in sample 0, a value set by position elsewhere. */
function valueAt(ping: number, sample: number): number {
  return sample === 0 ? -9999 : -40 - sample - (ping % 4) * 0.25;
}

/** One level of zeros, read on the main thread. */
function reader(): LevelReader {
  return {
    index: 0,
    entry: { path: '', factors: { ping: 1, sample: 1 } },
    valueName: 'Sv',
    channels: 1,
    pings: PINGS,
    samples: SAMPLES,
    async readWindow(_channel, pings, samples): Promise<ChannelValues> {
      const rows = pings[1] - pings[0];
      const columns = samples[1] - samples[0];
      const half = new Float16Array(rows * columns);
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          half[row * columns + column] = valueAt(pings[0] + row, samples[0] + column);
        }
      }
      return { data: new Uint16Array(half.buffer), pings: rows, samples: columns };
    },
    async readChannel() {
      return this.readWindow(0, [0, PINGS], [0, SAMPLES]);
    },
    async readSidecar(name) {
      if (name !== 'ping_time') return undefined;
      return Float64Array.from({ length: PINGS }, (_, i) => i * 1e9);
    },
    async geometry() {
      return {
        rangeStart: new Float64Array(PINGS),
        rangeStep: new Float64Array(PINGS).fill(1),
      };
    },
  };
}

const multiscales: Multiscales = {
  name: 'Sv',
  axes: [],
  datasets: [{ path: '', factors: { ping: 1, sample: 1 } }],
  aggregation: 'none',
  nodata: -9999,
  nodataThreshold: -5000,
  dataType: 'Sv',
  channelDim: 'channel',
  verticalRef: 'depth',
};

/** A host with a pool that never runs out and a device that writes nowhere. */
function host(uploader: Uploader) {
  const pool = {
    share: 1e9,
    inUse: 0,
    acquire: (width: number, height: number) => ({ width, height }),
    release() {},
  };
  const state = {
    context: {
      pool,
      tiles: new ArrayCache({ budget: 1e9 }),
      device: { queue: { writeTexture() {} } },
      limits: { maxTextureDimension2D: 8192 },
    },
    decode: undefined,
    uploader,
    layer: undefined,
    viewport: { x: [-1, PINGS + 1], y: [-1, SAMPLES + 1], panel: { width: 800, height: 600 } },
    xUnit: 'seconds',
    yUnit: 'meters',
    levelChoice: 'auto',
    pixelsPerPing: 2,
    generation: 0,
    clock: 1,
    destroyed: false,
    motion: { velocity: 0, moving: false },
    sourceCount: 1,
    epoch: (first: number) => first,
    levelLoaded() {},
    onError(error: unknown) {
      throw error;
    },
  };
  return state as unknown as SourceHost & { clock: number };
}

async function resident(pins: boolean, held = host(new Uploader())) {
  const uploader = (held as unknown as { uploader: Uploader }).uploader;
  const store = new EchogramStore(multiscales, undefined as never, undefined, reader());
  const chunks = new PriorityStore({ get: async () => undefined });
  let plane = 0;
  const allocate = (count: number) => (plane += count) - count;
  const source = PyramidSource.fromStore(
    'piece',
    store,
    chunks,
    false,
    undefined,
    allocate,
    held,
    pins,
  );
  await source.ensureLevel(0);
  const layer = resolveLayers([{ channel: 0 }], {
    color: { colormap: 'viridis' },
    clim: [-80, -20],
    opacity: 1,
    filter: 'nearest',
  })[0];
  source.refresh([layer], [0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  uploader.drain();
  // A later refresh, so nothing is marked as wanted on this one.
  held.clock = 2;
  return source;
}

describe('eviction of a single level source', () => {
  it('holds the coarsest level of a pyramid survey wide', async () => {
    const source = await resident(true);
    expect(source.status.resident).toBeGreaterThan(0);
    expect(source.spare(performance.now() + 60_000, 1)).toHaveLength(0);
  });

  it('offers every tile of a piece, whose one level is not pinned', async () => {
    const source = await resident(false);
    const count = source.status.resident;
    expect(count).toBeGreaterThan(0);
    const spare = source.spare(performance.now() + 60_000, 1);
    expect(spare).toHaveLength(count);
    for (const tile of spare) tile.release();
    expect(source.status.resident).toBe(0);
  });
});

describe('what is under a point', () => {
  it('reads the cell drawn there and its value from the cached tile', async () => {
    const source = await resident(false);
    // Pings sit one second apart from the first, samples one metre apart.
    const found = source.probe(10.2, 7.1, 0)!;
    expect(found.ping).toBe(10);
    expect(found.sample).toBe(7);
    expect(found.level).toBe(0);
    expect(found.factor).toBe(1);
    expect(found.x).toEqual([9.5, 10.5]);
    expect(found.y).toEqual([6.5, 7.5]);
    expect(found.value).toBe(valueAt(10, 7));
  });

  it('says no data rather than a sentinel', async () => {
    const source = await resident(false);
    expect(source.probe(3, 0.2, 0)!.value).toBeNull();
  });

  it('gives nothing below the deepest sample', async () => {
    const source = await resident(false);
    expect(source.probe(3, SAMPLES + 2, 0)).toBeUndefined();
  });

  it('has a cell but no value once the cache has let the values go', async () => {
    const held = host(new Uploader());
    const source = await resident(false, held);
    (held.context.tiles as ArrayCache<ChannelValues>).clear();
    const found = source.probe(10, 7, 0)!;
    expect(found.ping).toBe(10);
    expect(found.value).toBeUndefined();
    // Where to read it back from the texture being drawn instead.
    expect(found.texel).toMatchObject({ x: 7, y: 10 });
    expect(found.texel!.held()).toBe(true);
    for (const tile of source.spare(performance.now() + 60_000, 1)) tile.release();
    expect(found.texel!.held()).toBe(false);
  });

  it('gives nothing where no tile is resident', async () => {
    const source = await resident(false);
    for (const tile of source.spare(performance.now() + 60_000, 1)) tile.release();
    expect(source.probe(10, 7, 0)).toBeUndefined();
  });
});
