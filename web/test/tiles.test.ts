import { describe, expect, it } from 'vitest';

import { buildXAxis } from '../src/geometry/coords';
import {
  APRON,
  allTiles,
  boxOverlaps,
  planTiles,
  tileAt,
  tileBox,
  tilesCovering,
} from '../src/geometry/tiles';

const limits = { maxDimension: 8192, preferred: 2048 };

describe('planTiles', () => {
  it('leaves a level that fits as one tile', () => {
    const grid = planTiles({ pings: 1211, samples: 512 }, limits);
    expect([grid.rows, grid.columns]).toEqual([1, 1]);
    expect(tileAt(grid, 0, 0).pings).toEqual([0, 1211]);
  });

  it('adds a row at the ping where one tile stops holding the level', () => {
    const exact = planTiles({ pings: 2048, samples: 64 }, limits);
    const over = planTiles({ pings: 2049, samples: 64 }, limits);
    expect(exact.rows).toBe(1);
    expect(over.rows).toBe(2);
    expect(tileAt(over, 1, 0).pings).toEqual([2048, 2049]);
  });

  it('keeps the texture inside the device limit once an apron exists', () => {
    // The apron is what a linear filter reaches into, so the limit applies to
    // the tile and its apron together, not to the tile alone.
    const grid = planTiles({ pings: 100, samples: 40000 }, { maxDimension: 2048 });
    const middle = tileAt(grid, 0, 1);
    const width = middle.texture[1] - middle.texture[0];
    expect(grid.tileSamples).toBe(2048 - 2 * APRON);
    expect(width).toBeLessThanOrEqual(2048);
  });

  it('covers every ping and sample exactly once', () => {
    const grid = planTiles({ pings: 5000, samples: 3000 }, limits);
    const tiles = allTiles(grid);
    expect(tiles).toHaveLength(grid.rows * grid.columns);

    const pings = new Set<number>();
    for (const tile of tiles) {
      if (tile.column !== 0) continue;
      for (let ping = tile.pings[0]; ping < tile.pings[1]; ping += 1) {
        expect(pings.has(ping)).toBe(false);
        pings.add(ping);
      }
    }
    expect(pings.size).toBe(5000);
  });
});

describe('the apron', () => {
  const grid = planTiles({ pings: 10, samples: 6000 }, limits);

  it('reaches a neighbour on both interior edges', () => {
    const middle = tileAt(grid, 0, 1);
    expect(middle.samples).toEqual([2048, 4096]);
    expect(middle.texture).toEqual([2047, 4097]);
  });

  it('stops at the level, where clamp to edge is the right answer anyway', () => {
    const first = tileAt(grid, 0, 0);
    const last = tileAt(grid, 0, grid.columns - 1);
    expect(first.texture[0]).toBe(0);
    expect(last.texture[1]).toBe(6000);
  });

  it('is absent from a single column, which has no boundary to cross', () => {
    const one = planTiles({ pings: 10, samples: 512 }, limits);
    expect(tileAt(one, 0, 0).texture).toEqual([0, 512]);
  });
});

describe('tilesCovering', () => {
  const grid = planTiles({ pings: 5000, samples: 5000 }, limits);

  it('takes the tiles a range falls in and no others', () => {
    const tiles = tilesCovering(grid, [2040, 2060], [0, 10]);
    expect(tiles.map((t) => t.key)).toEqual(['0:0', '1:0']);
  });

  it('clamps a range that reaches past the level', () => {
    const tiles = tilesCovering(grid, [4900, 9000], [0, 10]);
    expect(tiles.map((t) => t.key)).toEqual(['2:0']);
  });

  it('returns nothing for an empty range', () => {
    expect(tilesCovering(grid, [100, 100], [0, 10])).toEqual([]);
  });

  it('returns nothing for a range that misses the level entirely', () => {
    // Clamping before testing would pull the range onto the nearest tile and
    // answer with one holding none of what was asked for.
    expect(tilesCovering(grid, [-500, -100], [0, 10])).toEqual([]);
    expect(tilesCovering(grid, [9000, 9500], [0, 10])).toEqual([]);
    expect(tilesCovering(grid, [0, 10], [-9, -1])).toEqual([]);
  });
});

describe('culling', () => {
  const pingTime = Float64Array.from({ length: 4096 }, (_, i) => i * 1e9);
  const axis = buildXAxis('seconds', { pingTime });
  const vertical = {
    rangeStart: Float64Array.from({ length: 4096 }, (_, i) => (i % 2) * 1.5),
    rangeStep: new Float64Array(4096).fill(0.5),
    samples: 400,
  };
  const grid = planTiles({ pings: 4096, samples: 400 }, limits);

  it('takes the vertical over the tile own pings, so heave cannot cull it', () => {
    // One ping in two starts 1.5 m deeper, and a box from a single ping would
    // miss the metre and a half at whichever end it did not take.
    const box = tileBox(tileAt(grid, 0, 0), axis, vertical);
    expect(box.y[0]).toBeCloseTo(0, 9);
    expect(box.y[1]).toBeCloseTo(1.5 + 400 * 0.5, 9);
  });

  it('places the second row after the first along the track', () => {
    const first = tileBox(tileAt(grid, 0, 0), axis, vertical);
    const second = tileBox(tileAt(grid, 1, 0), axis, vertical);
    expect(second.x[0]).toBeGreaterThanOrEqual(first.x[1] - 1e-9);
  });

  it('keeps a box that touches the view and drops one that misses it', () => {
    const box = tileBox(tileAt(grid, 0, 0), axis, vertical);
    expect(boxOverlaps(box, [100, 200], [0, 50])).toBe(true);
    expect(boxOverlaps(box, [5000, 6000], [0, 50])).toBe(false);
    expect(boxOverlaps(box, [100, 200], [500, 600])).toBe(false);
  });
});
