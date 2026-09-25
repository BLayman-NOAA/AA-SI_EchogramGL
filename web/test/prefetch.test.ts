import { describe, expect, it } from 'vitest';

import { type FootprintRequest, plan } from '../src/data/prefetch';

const factors = [1, 2, 4, 8, 16, 32, 64, 128];

/** Eight levels, each half the rows of the one below, one column of samples. */
const levels = factors.map((factor, index) => ({
  index,
  rows: Math.ceil(64 / factor),
  columns: 1,
}));

function request(over: Partial<FootprintRequest> = {}): FootprintRequest {
  return {
    target: 0,
    visible: { rows: [10, 13], columns: [0, 0] },
    levels,
    factors,
    tilePings: 2048,
    ...over,
  };
}

function rowsAt(found: ReturnType<typeof plan>, level: number): number[] {
  return found
    .filter((tile) => tile.level === level)
    .map((tile) => tile.row)
    .sort((a, b) => a - b);
}

describe('footprint policy', () => {
  it('asks for what is on screen first and at high priority', () => {
    const found = plan(request({ ring: 0, depth: 0 }));
    expect(found.map((tile) => tile.row)).toEqual([10, 11, 12, 13]);
    expect(found.every((tile) => tile.priority === 'high')).toBe(true);
  });

  it('holds each coarser level over about the same tile count', () => {
    // The whole footprint policy in one assertion. Four tiles on screen at the
    // target, and about four at each coarser level, which covers twice the
    // water each step up for the same bytes.
    const found = plan(request({ ring: 0, depth: 2 }));
    expect(rowsAt(found, 0)).toHaveLength(4);
    expect(rowsAt(found, 1).length).toBeGreaterThanOrEqual(4);
    expect(rowsAt(found, 2).length).toBeGreaterThanOrEqual(4);
  });

  it('covers the water on screen at every coarser level it asks for', () => {
    // Rows 10 to 13 at the target are rows 5 to 6 at the next level up. If the
    // footprint missed those, the tile that stands in for a slot while the
    // fine one loads would be the one tile not requested.
    const found = plan(request({ ring: 0, depth: 1 }));
    expect(rowsAt(found, 1)).toContain(5);
    expect(rowsAt(found, 1)).toContain(6);
  });

  it('marks everything past the viewport as speculative', () => {
    const found = plan(request({ ring: 1, depth: 2 }));
    const visible = found.filter((tile) => tile.level === 0 && tile.row >= 10 && tile.row <= 13);
    const rest = found.filter((tile) => !visible.includes(tile));
    expect(visible.every((tile) => tile.priority === 'high')).toBe(true);
    expect(rest.every((tile) => tile.priority === 'low')).toBe(true);
  });

  it('widens the ring in the direction of travel', () => {
    const forward = rowsAt(plan(request({ velocity: 40960, depth: 0 })), 0);
    const backward = rowsAt(plan(request({ velocity: -40960, depth: 0 })), 0);

    // 40,960 pings a second over half a second is ten tiles of 2048.
    expect(Math.max(...forward)).toBeGreaterThan(13 + 10);
    expect(Math.min(...forward)).toBe(9);
    expect(Math.min(...backward)).toBeLessThan(10 - 9);
    expect(Math.max(...backward)).toBe(14);
  });

  it('asks only for coarse levels while the view is still moving', () => {
    // The target level is where the bytes are and the view is not staying
    // here. Requesting it at every pointer position spends the link on tiles
    // the next frame has already left behind.
    const found = plan(request({ moving: true, depth: 2, velocity: 40960 }));
    expect(rowsAt(found, 0)).toEqual([]);
    expect(rowsAt(found, 1).length).toBeGreaterThan(0);
    expect(found.every((tile) => tile.priority === 'low')).toBe(true);
  });

  it('never names a tile the level does not have', () => {
    const found = plan(
      request({ visible: { rows: [62, 70], columns: [0, 0] }, ring: 4, depth: 3 }),
    );
    for (const tile of found) {
      const extent = levels[tile.level];
      expect(tile.row).toBeGreaterThanOrEqual(0);
      expect(tile.row).toBeLessThan(extent.rows);
      expect(tile.column).toBeLessThan(extent.columns);
    }
  });

  it('names each tile once, at the priority it was first wanted at', () => {
    const found = plan(request({ ring: 3, depth: 2 }));
    const keys = found.map((tile) => `${tile.level}:${tile.row}:${tile.column}`);
    expect(new Set(keys).size).toBe(keys.length);
    const onScreen = found.find((tile) => tile.level === 0 && tile.row === 11);
    expect(onScreen?.priority).toBe('high');
  });

  it('stops at the coarsest level rather than past it', () => {
    const found = plan(request({ target: 6, visible: { rows: [0, 0], columns: [0, 0] }, depth: 3 }));
    expect(found.every((tile) => tile.level <= 7)).toBe(true);
  });
});

describe('finer levels', () => {
  /** One tile on screen at level 3, of which pings 512 to 1536 are in frame. */
  const zoomed = (over: Partial<FootprintRequest> = {}) =>
    request({
      target: 3,
      visible: { rows: [2, 2], columns: [0, 0] },
      visiblePings: [2 * 2048 + 512, 2 * 2048 + 1536],
      ring: 0,
      depth: 0,
      tileBytes: 1,
      ...over,
    });

  it('holds as many finer levels as the budget allows, nearest first', () => {
    // The water in frame is 2 tiles at level 2, 2 at level 1 and 4 at level 0,
    // charged one unit each against a budget the visible tile has already
    // spent one of. Each step finer costs more than the last, so the ladder
    // ends at the first level that does not fit.
    expect(plan(zoomed({ budget: 1 })).every((tile) => tile.level >= 3)).toBe(true);

    const one = plan(zoomed({ budget: 3 }));
    expect(rowsAt(one, 2)).toEqual([4, 5]);
    expect(rowsAt(one, 1)).toEqual([]);

    const two = plan(zoomed({ budget: 5 }));
    expect(rowsAt(two, 1)).toEqual([9, 10]);
    expect(rowsAt(two, 0)).toEqual([]);

    const three = plan(zoomed({ budget: 9 }));
    expect(rowsAt(three, 0)).toEqual([18, 19, 20, 21]);
  });

  it('holds none without a budget, and none while the view is moving', () => {
    expect(plan(zoomed({ tileBytes: 0 })).every((tile) => tile.level >= 3)).toBe(true);
    const moving = plan(zoomed({ budget: 100, moving: true }));
    expect(moving.every((tile) => tile.level >= 3)).toBe(true);
  });

  it('charges the target, the coarser levels and the ring first', () => {
    // With the ring and two coarser levels the footprint costs 8 units before
    // any finer level: 1 visible, 3 at level 4, 2 at level 5 and 2 of ring.
    // Those are never refused, so a budget of 8 holds no finer level and a
    // budget of 10 holds level 2, after everything else.
    const full = { ring: 1, depth: 2 };
    const tight = plan(zoomed({ ...full, budget: 8 }));
    expect(tight).toHaveLength(8);
    expect(tight.every((tile) => tile.level >= 3)).toBe(true);

    const roomy = plan(zoomed({ ...full, budget: 10 }));
    expect(rowsAt(roomy, 2)).toEqual([4, 5]);
    const lastCoarse = roomy.map((tile) => tile.level >= 3).lastIndexOf(true);
    const firstFine = roomy.findIndex((tile) => tile.level < 3);
    expect(firstFine).toBeGreaterThan(lastCoarse);
    expect(roomy.filter((tile) => tile.level < 3).every((t) => t.priority === 'low')).toBe(true);
  });

  it('names a level not loaded from an estimate of its extent', () => {
    // Only the target is loaded. The coarser levels and the finer one are
    // named all the same, sized from the target's row count and the factors,
    // which is what tells the caller to load them. Nothing named is a row the
    // level turns out not to have.
    const found = plan(zoomed({ levels: [levels[3]], depth: 2, budget: 8 }));
    expect(new Set(found.map((tile) => tile.level))).toEqual(new Set([2, 3, 4, 5]));
    for (const tile of found) {
      expect(tile.row).toBeGreaterThanOrEqual(0);
      expect(tile.row).toBeLessThan(levels[tile.level].rows);
    }
  });

  it('falls back to the visible rows when the pings in frame are not given', () => {
    // Whole tiles rather than the water in frame: row 2 at level 3 is rows 8
    // to 11 at level 1, where the pings in frame would have been 9 and 10.
    const found = plan(zoomed({ visiblePings: undefined, budget: 100 }));
    expect(rowsAt(found, 1)).toEqual([8, 9, 10, 11]);
  });
});
