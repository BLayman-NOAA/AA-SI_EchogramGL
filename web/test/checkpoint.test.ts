import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FetchStore } from '../src/data/FetchStore';
import { openEchogramStore } from '../src/data/store';
import { Summaries } from '../src/data/summaries';
import { parseTimeUnits, toNanoseconds } from '../src/data/time';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'checkpoint-store.zarr');
const JUNE = Date.parse('2024-06-01T00:00:00Z') * 1e6;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
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

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('time units', () => {
  it('reads the forms the recipe caches hold', () => {
    expect(parseTimeUnits('nanoseconds since 1970-01-01T00:00:00+00:00')).toEqual({
      scale: 1,
      epoch: 0,
    });
    const spaced = parseTimeUnits('seconds since 2016-07-25 20:35:20');
    const joined = parseTimeUnits('seconds since 2016-07-25T20:35:20');
    expect(spaced).toEqual(joined);
    expect(spaced!.scale).toBe(1e9);
    expect(spaced!.epoch).toBe(Date.parse('2016-07-25T20:35:20Z') * 1e6);
    expect(parseTimeUnits('milliseconds since 2024-06-01')!.epoch).toBe(JUNE);
  });

  it('leaves values with no units as nanoseconds', () => {
    const values = Float64Array.from([1.7e18]);
    expect(toNanoseconds(values, undefined)).toBe(values);
    expect(toNanoseconds(values, 'metres')).toBe(values);
  });

  it('converts a count from an origin', () => {
    const found = toNanoseconds(Float64Array.from([0, 10]), 'seconds since 2024-06-01');
    expect([...found]).toEqual([JUNE, JUNE + 10e9]);
  });
});

describe('a pyramid written as a recipe checkpoint', () => {
  it('reads its times through their units, whatever each level chose', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    const first = await (await store.level(0)).readSidecar('ping_time');
    const second = await (await store.level(1)).readSidecar('ping_time');
    expect(first![0]).toBe(JUNE);
    expect(first![1]).toBe(JUNE + 1e9);
    // Level one's cells are the midpoint of two pings, which seconds cannot
    // hold, so xarray wrote that level in milliseconds.
    expect(second![0]).toBe(JUNE + 0.5e9);
  });

  it('finds summaries kept in the root attributes', async () => {
    const store = await openEchogramStore(new FetchStore(origin));
    expect(store.summaryPath).toBeUndefined();
    expect(store.inlineSummaries).toBeDefined();
    expect(new Summaries(store.inlineSummaries!).has(0)).toBe(true);
  });
});
