import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo, Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FetchStore } from '../src/data/FetchStore';
import { type LevelReader, openEchogramStore } from '../src/data/store';
import {
  type VerticalGeometry,
  buildXAxis,
  cellEdges,
  medianSpacing,
  pingsInRange,
  rangeToSample,
  remapRange,
  sampleToRange,
  verticalExtent,
  verticalFor,
} from '../src/geometry/coords';
import reference from './geometry.reference.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'geometry-store.zarr');

let server: Server;
let origin: string;
let level: LevelReader;

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
  const store = await openEchogramStore(new FetchStore(origin));
  level = await store.level(0);
});

afterAll(() => {
  server.close();
});

async function geometryFor(channel: number): Promise<VerticalGeometry> {
  const vertical = await level.geometry(channel);
  return { ...vertical, samples: level.samples };
}

describe('vertical geometry against the Python side', () => {
  it('reproduces depths taken from the dataset itself', async () => {
    // The reference depths come from the vertical coordinate, not from
    // range_start and range_step, so agreeing with them tests the affine model
    // rather than one formula against itself.
    const cache = new Map<number, VerticalGeometry>();
    let worst = 0;
    for (const point of reference.depths) {
      let geometry = cache.get(point.channel);
      if (!geometry) {
        geometry = await geometryFor(point.channel);
        cache.set(point.channel, geometry);
      }
      const ours = sampleToRange(geometry, point.ping, point.sample);
      worst = Math.max(worst, Math.abs(ours - point.depth));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('round trips depth back to a sample index', async () => {
    const geometry = await geometryFor(1);
    for (const sample of [0, 3, 17, 31]) {
      const depth = sampleToRange(geometry, 5, sample);
      expect(rangeToSample(geometry, 5, depth)).toBeCloseTo(sample, 9);
    }
  });

  it('has a vertical extent wider than any one ping, because of heave', async () => {
    const geometry = await geometryFor(0);
    const [top, bottom] = verticalExtent(geometry);
    const first = sampleToRange(geometry, 0, 0);
    const spread = Math.max(...geometry.rangeStart) - Math.min(...geometry.rangeStart);

    expect(spread).toBeGreaterThan(0);
    expect(top).toBeLessThanOrEqual(first);
    expect(bottom).toBeGreaterThan(top);
  });

  it('reads a different sample interval on each channel', async () => {
    const steps = [];
    for (let channel = 0; channel < level.channels; channel += 1) {
      steps.push((await geometryFor(channel)).rangeStep[0]);
    }
    expect(new Set(steps.map((s) => s.toFixed(6))).size).toBe(level.channels);
  });

  it('varies the sample interval along the ping axis too', async () => {
    const geometry = await geometryFor(0);
    const first = geometry.rangeStep[0];
    const later = geometry.rangeStep[geometry.rangeStep.length - 1];
    expect(Math.abs(later - first)).toBeGreaterThan(0);
  });
});

describe('x axis', () => {
  const pingTime = Float64Array.from([0, 1, 2, 3, 10, 11], (s) => s * 1e9);

  it('places pings at seconds from the first, not at nanoseconds', () => {
    const axis = buildXAxis('seconds', { pingTime });
    expect(Array.from(axis.centre)).toEqual([0, 1, 2, 3, 10, 11]);
  });

  it('gives datetime the same data space as seconds', () => {
    const seconds = buildXAxis('seconds', { pingTime });
    const datetime = buildXAxis('datetime', { pingTime });
    expect(Array.from(datetime.centre)).toEqual(Array.from(seconds.centre));
  });

  it('uses the index for pings and bins', () => {
    const axis = buildXAxis('pings', { pingTime });
    expect(Array.from(axis.centre)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('refuses a distance axis with no x_distance sidecar', () => {
    expect(() => buildXAxis('meters', { pingTime })).toThrow(/x_distance/);
  });

  it('leaves a gap open rather than widening a cell across it', () => {
    // Pings 3 and 4 are seven seconds apart against a one second median. A cell
    // that spanned the gap would assert data over a stretch with none.
    const axis = buildXAxis('seconds', { pingTime });
    expect(medianSpacing(axis.centre)).toBe(1);
    expect(axis.right[3]).toBeLessThan(axis.left[4]);
    expect(axis.right[3] - axis.left[3]).toBeLessThanOrEqual(2);
  });

  it('keeps neighbouring cells touching where there is no gap', () => {
    const axis = buildXAxis('seconds', { pingTime });
    expect(axis.right[1]).toBeCloseTo(axis.left[2], 12);
  });

  it('handles one ping without dividing by an empty spacing', () => {
    const single = cellEdges(Float64Array.from([4]));
    expect(single.left[0]).toBeLessThan(single.right[0]);
  });

  it('reports no pings for a range that falls inside a gap', () => {
    const axis = buildXAxis('seconds', { pingTime });
    expect(pingsInRange(axis, 5, 8)).toBeUndefined();
    expect(pingsInRange(axis, 0.2, 2.6)).toEqual([0, 3]);
  });

  it('does not read a change of speed as a gap on a distance axis', () => {
    // Every ping a second apart, but the vessel sprints between pings 2 and 3.
    // Spacing on a distance axis is speed times interval, and on real data it
    // varies by a factor of eighty, so capping on it draws open water as
    // absent. Whether a ping was missed is a question about time.
    const times = Float64Array.from([0, 1, 2, 3, 4, 5], (s) => s * 1e9);
    const axis = buildXAxis('meters', {
      pingTime: times,
      xDistance: Float64Array.from([0, 5, 10, 30, 35, 40]),
    });

    expect(axis.right[2]).toBeCloseTo(axis.left[3], 12);
    expect(pingsInRange(axis, 12, 28)).toEqual([2, 3]);
  });

  it('still opens a real dropout on a distance axis, at the distance run', () => {
    // Pings 2 and 3 are 58 seconds apart, and the vessel covered 290 m of
    // track in between with nothing measured over it.
    const times = Float64Array.from([0, 1, 2, 60, 61, 62], (s) => s * 1e9);
    const axis = buildXAxis('meters', {
      pingTime: times,
      xDistance: Float64Array.from([0, 5, 10, 300, 305, 310]),
    });

    expect(axis.right[2]).toBeCloseTo(15, 9);
    expect(axis.left[3]).toBeCloseTo(295, 9);
    expect(pingsInRange(axis, 100, 200)).toBeUndefined();
  });

  it('closes that same dropout on a ping axis, which is what it is for', () => {
    const times = Float64Array.from([0, 1, 2, 60, 61, 62], (s) => s * 1e9);
    const axis = buildXAxis('pings', { pingTime: times });
    expect(axis.right[2]).toBeCloseTo(axis.left[3], 12);
  });

  it('counts a cell as covered only where it overlaps, not where it touches', () => {
    // Cell 0 ends exactly at 0.5 and cell 3 starts exactly at 2.5, so a window
    // of exactly those bounds covers the two cells between them.
    const axis = buildXAxis('seconds', { pingTime });
    expect(pingsInRange(axis, 0.5, 2.5)).toEqual([1, 2]);
  });
});

describe('remapRange', () => {
  const pingTime = Float64Array.from({ length: 6 }, (_, i) => i * 1e9);
  const distance = Float64Array.from({ length: 6 }, (_, i) => i * 100);

  it('keeps the same pings on screen when the unit changes', () => {
    // Switching pings to metres without this leaves a view showing the first
    // few metres of a track it had been showing all of.
    const pings = buildXAxis('pings', { pingTime });
    const metres = buildXAxis('meters', { pingTime, xDistance: distance });
    const covered = pingsInRange(pings, 1.6, 3.4);

    const moved = remapRange(pings, metres, [1.6, 3.4]);
    expect(covered).toEqual([2, 3]);
    expect(moved).toEqual([metres.left[2], metres.right[3]]);
  });

  it('falls back to the whole extent when nothing is covered', () => {
    const pings = buildXAxis('pings', { pingTime });
    const metres = buildXAxis('meters', { pingTime, xDistance: distance });
    expect(remapRange(pings, metres, [100, 200])).toEqual([
      metres.left[0],
      metres.right[5],
    ]);
  });

  it('round trips a full extent back to a full extent', () => {
    const pings = buildXAxis('pings', { pingTime });
    const metres = buildXAxis('meters', { pingTime, xDistance: distance });
    const whole: [number, number] = [pings.left[0], pings.right[5]];
    const there = remapRange(pings, metres, whole);
    expect(remapRange(metres, pings, there)).toEqual(whole);
  });
});

describe('verticalFor', () => {
  const metric = {
    rangeStart: Float64Array.from([5, 6, 7]),
    rangeStep: Float64Array.from([0.5, 0.5, 0.5]),
    samples: 10,
  };

  it('leaves metres alone', () => {
    expect(verticalFor('meters', metric)).toBe(metric);
  });

  it('makes the sample index the coordinate for index units', () => {
    for (const unit of ['range_sample', 'bins'] as const) {
      const indexed = verticalFor(unit, metric);
      expect(sampleToRange(indexed, 1, 0)).toBe(0);
      expect(sampleToRange(indexed, 1, 4)).toBe(4);
      expect(verticalExtent(indexed)).toEqual([0, 10]);
    }
  });

  it('drops the per ping offset that heave puts in the metric geometry', () => {
    // Two pings at different depths hold the same sample indices, which is
    // what a range sample axis means.
    const indexed = verticalFor('range_sample', metric);
    expect(sampleToRange(indexed, 0, 3)).toBe(sampleToRange(indexed, 2, 3));
    expect(sampleToRange(metric, 0, 3)).not.toBe(sampleToRange(metric, 2, 3));
  });
});

describe('an index axis across levels', () => {
  const pingTime = Float64Array.from({ length: 8 }, (_, i) => i * 1e9);

  it('is unchanged at level zero', () => {
    const axis = buildXAxis('pings', { pingTime, factor: 1 });
    expect(Array.from(axis.centre)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('counts source pings at a coarse level, so a level change moves nothing', () => {
    // Coarse ping j merges source pings 2j and 2j+1, so it covers the same
    // stretch of axis those two did rather than its own index.
    const fine = buildXAxis('pings', { pingTime, factor: 1 });
    const coarse = buildXAxis('pings', {
      pingTime: pingTime.slice(0, 4),
      factor: 2,
    });

    expect(coarse.left[0]).toBeCloseTo(fine.left[0], 12);
    expect(coarse.right[0]).toBeCloseTo(fine.right[1], 12);
    expect(coarse.right[3]).toBeCloseTo(fine.right[7], 12);
  });
});
