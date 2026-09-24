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
