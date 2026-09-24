import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FetchStore } from '../src/data/FetchStore';
import { openEchogramStore } from '../src/data/store';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'fixture-store.zarr');

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    if (name === '/forbidden') {
      response.statusCode = 403;
      response.end();
      return;
    }
    try {
      response.end(await readFile(path.join(root, name)));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server.close();
});

describe('FetchStore', () => {
  it('returns bytes for a key that exists', async () => {
    const store = new FetchStore(origin);
    const bytes = await store.get('/zarr.json');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(bytes)).node_type).toBe('group');
  });

  it('returns undefined for a key that does not', async () => {
    const store = new FetchStore(origin);
    expect(await store.get('/0/Sv/c/9/9/9')).toBeUndefined();
  });

  it('resolves keys under a base path rather than replacing it', async () => {
    const store = new FetchStore(`${origin}0`);
    expect(await store.get('/zarr.json')).toBeInstanceOf(Uint8Array);
  });

  it('passes an abort signal through', async () => {
    const store = new FetchStore(origin);
    const controller = new AbortController();
    controller.abort();
    const aborted = store.get('/zarr.json', { signal: controller.signal });
    await expect(aborted).rejects.toThrow();
  });

  it('tolerates the options object zarrita passes with no signal in it', async () => {
    const store = new FetchStore(origin);
    expect(await store.get('/zarr.json', { signal: undefined })).toBeInstanceOf(
      Uint8Array,
    );
  });

  it('throws on a refusal rather than reporting the chunk as absent', async () => {
    // An expired token returns 403. Treating that as a missing chunk would
    // draw an echogram full of holes and report no problem.
    const store = new FetchStore(origin);
    await expect(store.get('/forbidden')).rejects.toThrow(/403/);
  });
});

describe('store', () => {
  it('reads the multiscales block', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    expect(store.multiscales.name).toBe('Sv');
    expect(store.levelCount).toBe(2);
    expect(store.multiscales.nodataThreshold).toBe(-5000);
    expect(store.multiscales.channelDim).toBe('channel');
  });

  it('reads a channel as raw float16 bits ready to upload', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    const level = await store.level(0);
    const values = await level.readChannel(1);

    expect(values.pings).toBe(level.pings);
    expect(values.samples).toBe(level.samples);
    expect(values.data).toBeInstanceOf(Uint16Array);
    expect(values.data.length).toBe(level.pings * level.samples);

    const asFloats = new Float16Array(
      values.data.buffer,
      values.data.byteOffset,
      values.data.length,
    );
    expect(asFloats[0]).toBeGreaterThan(-120);
    expect(asFloats[0]).toBeLessThan(0);
  });

  it('halves the ping count at the coarser level', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    const fine = await store.level(0);
    const coarse = await store.level(1);
    expect(coarse.pings).toBe(Math.ceil(fine.pings / 2));
    expect(coarse.samples).toBe(fine.samples);
  });

  it('reads vertical geometry per channel', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    const level = await store.level(0);
    const geometry = await level.geometry(0);

    expect(geometry.rangeStart.length).toBe(level.pings);
    expect(geometry.rangeStep.length).toBe(level.pings);
    expect(geometry.rangeStep[0]).toBeGreaterThan(0);
  });

  it('reads an int64 sidecar without choking on bigints', async () => {
    // ping_time is int64 nanoseconds, which Float64Array.from refuses outright.
    const store = await openEchogramStore(new FetchStore(origin));
    const level = await store.level(0);
    const times = await level.readSidecar('ping_time');

    expect(times?.length).toBe(level.pings);
    expect(Number.isFinite(times?.[0])).toBe(true);
    expect(times?.[1]).toBeGreaterThan(times?.[0] ?? 0);
  });

  it('reports a sidecar that is absent as absent', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    const level = await store.level(0);
    expect(await level.readSidecar('not_a_sidecar')).toBeUndefined();
  });

  it('reads a tile without reading the level around it', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    const level = await store.level(0);
    const whole = await level.readChannel(1);
    const tile = await level.readWindow(1, [2, 5], [3, 9]);

    expect(tile.pings).toBe(3);
    expect(tile.samples).toBe(6);
    expect(tile.data.length).toBe(18);
    // Row major, so the first value of the window is the fourth sample of the
    // third ping and the bits are the same ones the whole level read gives.
    expect(tile.data[0]).toBe(whole.data[2 * level.samples + 3]);
    expect(tile.data[6]).toBe(whole.data[3 * level.samples + 3]);
  });

  it('refuses a window outside the level rather than reading a short one', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    const level = await store.level(0);
    await expect(level.readWindow(0, [0, level.pings + 1], [0, 4])).rejects.toThrow(
      /ping range/,
    );
    await expect(level.readWindow(0, [5, 5], [0, 4])).rejects.toThrow(/ping range/);
    await expect(level.readWindow(0, [0, 4], [-1, 4])).rejects.toThrow(/sample range/);
  });

  it('refuses a channel outside the array', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    const level = await store.level(0);
    await expect(level.readChannel(9)).rejects.toThrow(/channel 9/);
  });

  it('reports a store with no multiscales rather than drawing nothing', async () => {
    const empty = { get: async () => undefined };
    await expect(openEchogramStore(empty)).rejects.toThrow();
  });

  it('names the url and the likely mistake when there is no zarr.json', async () => {
    // Pointing one directory too high is the ordinary way to get here, and
    // zarrita only says that a v3 array or group was not found.
    const store = new FetchStore(`${origin}0/Sv/c`);
    await expect(openEchogramStore(store)).rejects.toThrow(
      /no zarr\.json at http:.*directory that holds zarr\.json/s,
    );
  });
});
