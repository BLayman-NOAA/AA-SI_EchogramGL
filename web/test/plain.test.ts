import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type ChunkStore, StoreError, openEchogramStore } from '../src/data/store';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Reads the fixture off disk, which is all a ChunkStore has to do. */
function fixture(name: string, skip: string[] = []): ChunkStore {
  const root = path.join(here, name);
  return {
    async get(key: string) {
      const relative = key.replace(/^\/+/, '');
      if (skip.some((prefix) => relative.startsWith(prefix))) return undefined;
      try {
        return new Uint8Array(await readFile(path.join(root, relative)));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
        throw error;
      }
    },
  };
}

/** Decode a window back to numbers, which is what the texture would sample. */
function values(bits: Uint16Array): number[] {
  return Array.from(new Float16Array(bits.buffer, bits.byteOffset, bits.length));
}

describe('a plain Sv dataset', () => {
  it('opens as a one level pyramid', async () => {
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    expect(store.isPlain).toBe(true);
    expect(store.levelCount).toBe(1);
    expect(store.multiscales.name).toBe('Sv');
    // Not "linear_mean". Nothing was aggregated, and saying otherwise would
    // claim a reduction that never ran.
    expect(store.multiscales.aggregation).toBe('none');
  });

  it('reports the shape the values have', async () => {
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    const level = await store.level(0);
    expect([level.channels, level.pings, level.samples]).toEqual([3, 40, 16]);
    expect(level.entry.factors.ping).toBe(1);
  });

  it('reads the vertical by dimension name, not by position', async () => {
    // The fixture stores depth as (ping_time, channel, range_sample) while Sv
    // is (channel, ping_time, range_sample), which is what a real HB2407
    // checkpoint holds. Reading by position would take the vertical of the
    // wrong ping for every sample on screen.
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    const level = await store.level(0);

    const first = await level.geometry(0);
    const second = await level.geometry(1);
    expect(first.rangeStart[0]).toBeCloseTo(6.42, 6);
    expect(first.rangeStep[0]).toBeCloseTo(0.188037, 6);
    expect(second.rangeStep[0]).toBeCloseTo(0.179083, 6);
    expect(first.rangeStep).toHaveLength(40);
  });

  it('converts values to float16 and NaN to the sentinel', async () => {
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    const level = await store.level(0);

    // The last three samples of every ping are NaN in the fixture.
    const window = await level.readWindow(1, [0, 2], [12, 16]);
    expect(window.pings).toBe(2);
    expect(window.samples).toBe(4);

    const found = values(window.data);
    // Sample 12 is data, 13 to 15 are the masked wedge.
    expect(found[0]).toBeGreaterThan(-95);
    expect(found[0]).toBeLessThan(-35);
    for (const index of [1, 2, 3, 5, 6, 7]) {
      expect(found[index]).toBeLessThan(store.multiscales.nodataThreshold);
    }
  });

  it('tells a worker what it would need to read this itself', async () => {
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    const level = await store.level(0);
    expect(level.source).toEqual({
      order: { channel: 0, ping: 1, sample: 2 },
      convert: true,
    });
  });

  it('carries the frequencies, which is what names a channel', async () => {
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    expect(store.multiscales.channelFrequencies).toEqual([18000, 70000, 200000]);
  });

  it('serves ping_time as a sidecar, so the axes need no special case', async () => {
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    const level = await store.level(0);
    const pings = await level.readSidecar('ping_time');
    expect(pings).toHaveLength(40);
    expect(pings?.[1]).toBeGreaterThan(pings![0]);
  });

  it('has only the one level to ask for', async () => {
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    await expect(store.level(1)).rejects.toThrow(StoreError);
  });

  it('refuses a channel outside the ones it has', async () => {
    const store = await openEchogramStore(fixture('sv-dataset.zarr'));
    const level = await store.level(0);
    await expect(level.readWindow(9, [0, 2], [0, 2])).rejects.toThrow(/channel 9/);
  });
});

describe('what a plain dataset has to have', () => {
  it('says so when there is no Sv variable', async () => {
    const store = await openEchogramStore(
      fixture('sv-dataset.zarr', ['Sv/']),
    ).catch((error) => error);
    expect(store).toBeInstanceOf(StoreError);
    expect(store.message).toContain('Sv');
    // Both halves of the story: not a built store, and not a readable dataset.
    expect(store.message).toContain('multiscales');
  });

  it('says so when there is no vertical coordinate', async () => {
    const store = await openEchogramStore(
      fixture('sv-dataset.zarr', ['depth/', 'echo_range/']),
    ).catch((error) => error);
    expect(store).toBeInstanceOf(StoreError);
    expect(store.message).toMatch(/depth or echo_range/);
  });

  it('says so when there is no ping_time', async () => {
    const store = await openEchogramStore(
      fixture('sv-dataset.zarr', ['ping_time/']),
    ).catch((error) => error);
    expect(store).toBeInstanceOf(StoreError);
    expect(store.message).toContain('ping_time');
  });

  it('still opens a built store the way it always did', async () => {
    // The plain path is a fallback, not a replacement. A store with a
    // multiscales attribute must never reach it.
    const store = await openEchogramStore(fixture('fixture-store.zarr'));
    expect(store.isPlain).toBe(false);
    expect(store.levelCount).toBe(2);
  });
});
