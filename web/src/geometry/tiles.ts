/**
 * Splitting a level into textures a device will hold.
 *
 * `maxTextureDimension2D` is 8192 on a great deal of hardware, and a survey leg
 * is longer than that in pings before it is anything else, so a level becomes a
 * grid of tiles drawn as one instanced draw each.
 *
 * The two axes do not split the same way. A tile owns whole pings, and nothing
 * is interpolated across a ping boundary because every fragment of a ping
 * samples the middle of that ping's own texture row, so the ping axis needs no
 * overlap. The sample axis is the one the texture coordinate runs along, so a
 * linear filter reaches for a neighbour that a hard split would not have, and
 * an interior tile carries a one texel apron for it to find.
 */

import type { VerticalGeometry, XAxisValues } from './coords';

/** Edge length to aim for, small enough that eviction and upload stay granular. */
export const DEFAULT_TILE = 2048;

/** Samples a tile keeps beyond its own, so a filter has a neighbour to reach. */
export const APRON = 1;

export interface TileLimits {
  /** Device `maxTextureDimension2D`. */
  maxDimension: number;
  preferred?: number;
}

export interface LevelShape {
  pings: number;
  samples: number;
}

export interface TileGrid extends LevelShape {
  /** Pings a full tile holds, whether or not this level has that many. */
  tilePings: number;
  tileSamples: number;
  rows: number;
  columns: number;
}

export interface Tile {
  row: number;
  column: number;
  key: string;
  /** Pings this tile draws, end exclusive. */
  pings: [number, number];
  /** Samples this tile draws, end exclusive. */
  samples: [number, number];
  /** Samples held in the texture, an apron wider at an interior edge. */
  texture: [number, number];
}

/** Where a tile falls in data space, for deciding whether it is on screen. */
export interface TileBox {
  x: [number, number];
  y: [number, number];
}

export function planTiles(shape: LevelShape, limits: TileLimits): TileGrid {
  const preferred = limits.preferred ?? DEFAULT_TILE;
  const edge = Math.max(1, Math.min(preferred, limits.maxDimension));
  // The same at every level, not clipped to the level's own ping count, so a
  // tile at one level covers a whole number of tiles at every finer one. That
  // alignment is what lets a coarse tile stand in for a fine slot as a plain
  // instance range rather than an interpolation.
  const tilePings = edge;
  // An apron only exists where there is more than one column, and where it does
  // the texture is wider than the tile, so the limit applies to the sum.
  const tileSamples =
    shape.samples <= edge
      ? Math.max(1, shape.samples)
      : Math.max(1, Math.min(edge, limits.maxDimension - 2 * APRON));

  return {
    ...shape,
    tilePings,
    tileSamples,
    rows: Math.ceil(shape.pings / tilePings),
    columns: Math.ceil(shape.samples / tileSamples),
  };
}

export function tileAt(grid: TileGrid, row: number, column: number): Tile {
  if (row < 0 || row >= grid.rows || column < 0 || column >= grid.columns) {
    throw new RangeError(
      `no tile at row ${row} column ${column} in a ${grid.rows} by ` +
        `${grid.columns} grid`,
    );
  }
  const first = row * grid.tilePings;
  const start = column * grid.tileSamples;
  const pings: [number, number] = [first, Math.min(first + grid.tilePings, grid.pings)];
  const samples: [number, number] = [
    start,
    Math.min(start + grid.tileSamples, grid.samples),
  ];
  return {
    row,
    column,
    key: `${row}:${column}`,
    pings,
    samples,
    // Clamping to the level removes the apron at the outer edges, where there
    // is no neighbour and clamp-to-edge is the right answer anyway.
    texture: [
      Math.max(0, samples[0] - APRON),
      Math.min(grid.samples, samples[1] + APRON),
    ],
  };
}

export function allTiles(grid: TileGrid): Tile[] {
  const out: Tile[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      out.push(tileAt(grid, row, column));
    }
  }
  return out;
}

/** Every tile holding any part of a ping and sample range, both end exclusive. */
export function tilesCovering(
  grid: TileGrid,
  pings: [number, number],
  samples: [number, number],
): Tile[] {
  if (pings[1] <= pings[0] || samples[1] <= samples[0]) return [];
  const rows = span(pings, grid.tilePings, grid.rows);
  const columns = span(samples, grid.tileSamples, grid.columns);
  if (!rows || !columns) return [];

  const out: Tile[] = [];
  for (let row = rows[0]; row <= rows[1]; row += 1) {
    for (let column = columns[0]; column <= columns[1]; column += 1) {
      out.push(tileAt(grid, row, column));
    }
  }
  return out;
}

/**
 * Where a tile sits in data space.
 *
 * The vertical is taken over the tile's own pings rather than from the level,
 * because heave moves a sample index up and down by a metre or so and a box
 * that ignored it would cull a tile that is on screen.
 */
export function tileBox(
  tile: Tile,
  axis: XAxisValues,
  vertical: VerticalGeometry,
): TileBox {
  const [first, end] = tile.pings;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let ping = first; ping < end; ping += 1) {
    const start = vertical.rangeStart[ping];
    const step = vertical.rangeStep[ping];
    top = Math.min(top, start + tile.samples[0] * step);
    bottom = Math.max(bottom, start + tile.samples[1] * step);
  }
  return {
    x: [axis.left[first], axis.right[end - 1]],
    y: [top, bottom],
  };
}

export function boxOverlaps(
  box: TileBox,
  x: [number, number],
  y: [number, number],
): boolean {
  return box.x[0] < x[1] && box.x[1] > x[0] && box.y[0] < y[1] && box.y[1] > y[0];
}

/** Index range of the tiles a value range falls in, or undefined for none. */
function span(
  range: [number, number],
  size: number,
  count: number,
): [number, number] | undefined {
  // A range wholly outside the grid covers nothing. Clamping first would pull
  // it onto the nearest tile and answer with one that holds none of it.
  if (range[1] <= 0 || range[0] >= count * size) return undefined;
  const low = Math.max(0, Math.floor(range[0] / size));
  const high = Math.min(count - 1, Math.floor((range[1] - 1) / size));
  return high < low ? undefined : [low, high];
}
