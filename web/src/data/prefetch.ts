/**
 * What to ask for, beyond what is on screen.
 *
 * Architecture section 9.3. Two ideas, and the second is the one that makes
 * scrolling feel continuous.
 *
 * A ring around the viewport, widened in the direction of travel, so territory
 * about to arrive is already held. And each coarser level held over about the
 * same number of tiles as the target: a tile at the next level up covers twice
 * the pings, so the same tile count is twice the extent for the same bytes.
 * Three levels resident that way cost three viewports and cover eight, which is
 * why a jump lands on something already drawn.
 *
 * This module decides what to want. It knows nothing about fetching, and takes
 * tile coordinates rather than data coordinates so the policy is assertable
 * without a store.
 */

export type Priority = 'high' | 'low';

export interface TileRequest {
  level: number;
  row: number;
  column: number;
  priority: Priority;
}

/** Rows and columns a level holds, for clamping. */
export interface LevelExtent {
  index: number;
  rows: number;
  columns: number;
}

export interface FootprintRequest {
  /** The level the view resolves slots at. */
  target: number;
  /** Rows and columns the viewport covers at the target level, both inclusive. */
  visible: { rows: [number, number]; columns: [number, number] };
  levels: LevelExtent[];
  /** Ping factor per level, ascending. */
  factors: number[];
  /** Pings a full tile holds, the same at every level. */
  tilePings: number;
  /** Signed level zero pings per second the view is moving along x. */
  velocity?: number;
  /** Seconds ahead of the pointer the ring reaches at that speed. */
  lookahead?: number;
  /** Rows either side held whether or not the view is moving. */
  ring?: number;
  /** Coarser levels held over wider extents. */
  depth?: number;
  /**
   * Whether the view is still moving.
   *
   * During a drag only the coarser levels are asked for. The target is where
   * the bytes are, and fetching it at every pointer position spends the link on
   * tiles the next frame has already left behind, so it waits for the motion to
   * settle. Section 9.2 measures that as 53 ms to first paint against 851.
   */
  moving?: boolean;
}

/** Rows either side of the viewport held with no motion at all. */
export const DEFAULT_RING = 1;

/** Seconds of travel the ring reaches ahead at the current speed. */
export const DEFAULT_LOOKAHEAD = 0.5;

/**
 * Coarser levels held over wider extents.
 *
 * Two, because substitution is capped at two levels: a tile four levels coarse
 * is stretched sixteen to one along the ping axis and reads as a scattering
 * layer rather than as coarseness. Holding a level that would never be drawn
 * from is bytes spent on nothing.
 */
export const DEFAULT_DEPTH = 2;

/**
 * The tiles worth holding, highest priority first.
 *
 * Deduplicated, so a tile wanted both as visible and as ring appears once at
 * the priority it was first wanted at.
 */
export function plan(request: FootprintRequest): TileRequest[] {
  const {
    target,
    visible,
    levels,
    factors,
    tilePings,
    velocity = 0,
    lookahead = DEFAULT_LOOKAHEAD,
    ring = DEFAULT_RING,
    depth = DEFAULT_DEPTH,
    moving = false,
  } = request;

  const extents = new Map(levels.map((level) => [level.index, level]));
  const out: TileRequest[] = [];
  const seen = new Set<string>();

  const add = (level: number, rows: [number, number], columns: [number, number],
    priority: Priority) => {
    const extent = extents.get(level);
    if (!extent) return;
    const rowRange = clamp(rows, extent.rows);
    const columnRange = clamp(columns, extent.columns);
    if (!rowRange || !columnRange) return;
    for (let row = rowRange[0]; row <= rowRange[1]; row += 1) {
      for (let column = columnRange[0]; column <= columnRange[1]; column += 1) {
        const key = `${level}:${row}:${column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ level, row, column, priority });
      }
    }
  };

  // What is on screen, and nothing outranks it. Skipped while the view is
  // moving, since the target level it is moving to is not the one it will rest
  // at, and a request issued now is bandwidth the coarse fill needed.
  if (!moving) add(target, visible.rows, visible.columns, 'high');

  // Coarser levels, each over about the same tile count and so twice the water
  // of the one below it. These are what a slot falls back to, and what makes a
  // pan into new territory draw at once.
  const [first, last] = visible.rows;
  const width = last - first + 1;
  for (let step = 1; step <= depth; step += 1) {
    const level = target + step;
    if (factors[level] === undefined) break;
    const ratio = factors[level] / factors[target];
    if (!Number.isInteger(ratio) || ratio <= 1) continue;
    const low = Math.floor(first / ratio);
    const high = Math.floor(last / ratio);
    const centre = (low + high) / 2;
    // Same tile count as the target's visible span, which is the equal byte
    // share, but never narrower than the water actually on screen.
    const half = Math.max(width / 2, (high - low + 1) / 2);
    add(
      level,
      [Math.floor(centre - half), Math.ceil(centre + half)],
      visible.columns,
      'low',
    );
  }

  // The ring, last, because it is the most speculative thing here. Asymmetric
  // under motion: territory behind the pointer is already drawn and is not
  // where the view is going.
  if (!moving) {
    const reach = Math.ceil((Math.abs(velocity) * lookahead) / tilePings);
    const ahead = velocity >= 0 ? reach : 0;
    const behind = velocity < 0 ? reach : 0;
    add(target, [first - ring - behind, last + ring + ahead], visible.columns, 'low');
  }

  return out;
}

/** A range clipped to a count, or nothing if it falls outside entirely. */
function clamp(range: [number, number], count: number): [number, number] | undefined {
  const low = Math.max(0, Math.floor(range[0]));
  const high = Math.min(count - 1, Math.ceil(range[1]));
  return high < low ? undefined : [low, high];
}
