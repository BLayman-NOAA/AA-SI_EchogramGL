/**
 * Choosing which stored level to draw, and what stands in for it.
 *
 * The target level is a resolution answer: the coarsest level still holding a
 * ping for every pixel across the view. It is not a precondition for drawing.
 * The viewport is divided into slots at the target level, and a slot whose tile
 * has not arrived draws from the finest coarser level that has, so a viewport
 * inside the survey never draws blank, only coarser.
 *
 * A coarse tile standing in for a fine slot needs no interpolation and no
 * scaling of anything. Tiles hold the same number of pings at every level, so a
 * slot maps onto a whole instance range inside one coarse tile, and the vertex
 * stage positions those pings from that level's own geometry. The substitution
 * is a first instance and a count.
 */

/** How far past a boundary the wanted factor has to reach before a level moves. */
export const HYSTERESIS = 1.2;

/**
 * Device pixels wanted per drawn ping.
 *
 * Counted in drawn pings rather than source pings, because source pings per
 * pixel is fixed by the zoom and no level changes it: a pixel covers the water
 * it covers. What a level changes is how many source pings are merged into the
 * one ping that gets drawn there, so this is the width of a cell on screen.
 * Two is a cell two pixels wide, which is a level coarser than one.
 */
export const PIXELS_PER_PING = 2;

export interface SlotDraw {
  level: number;
  row: number;
  column: number;
  /** First instance, which is both the geometry offset and the texture row. */
  firstInstance: number;
  instances: number;
}

/**
 * Level zero pings the view spans, whatever level happens to be loaded.
 *
 * Taken from the median cell spacing rather than by counting cells, so it moves
 * smoothly with the zoom instead of stepping as cells cross the edge of the
 * view. Multiplying by the level's factor removes the level from the answer,
 * which is what keeps the choice from depending on the current choice.
 */
export function sourcePings(span: number, spacing: number, factor: number): number {
  if (!(span > 0) || !(spacing > 0)) return 0;
  return (span / spacing) * factor;
}

/** Ping factor that would make each drawn ping the wanted number of pixels wide. */
export function wantedFactor(
  pings: number,
  pixels: number,
  pixelsPerPing = PIXELS_PER_PING,
): number {
  if (!(pixels > 0) || !(pixelsPerPing > 0)) return 1;
  return (pings * pixelsPerPing) / pixels;
}

/** Coarsest level at or below the wanted factor, and level zero below that. */
export function levelFor(wanted: number, factors: number[]): number {
  let chosen = 0;
  for (let level = 0; level < factors.length; level += 1) {
    if (factors[level] <= wanted) chosen = level;
  }
  return chosen;
}

/**
 * Pick a level, refusing to move until the wanted factor clears the boundary.
 *
 * Without the margin a viewport sitting exactly on a boundary switches level on
 * every pointer move, and each switch is a set of fetches.
 */
export function chooseLevel(
  current: number,
  wanted: number,
  factors: number[],
  hysteresis = HYSTERESIS,
): number {
  const next = levelFor(wanted, factors);
  if (next === current) return current;
  // Both bands are measured from the level in force, not from the one being
  // moved to. They are the same thing for a step of one level, which is what a
  // zoom produces; they are not for a jump, where comparing against the
  // destination's factor asks whether the destination is a close fit rather
  // than whether the current level is a bad one, and refuses to move at all.
  if (next > current && wanted < factors[current + 1] * hysteresis) return current;
  if (next < current && wanted > factors[current] / hysteresis) return current;
  return next;
}

/**
 * Levels past the target a slot will stand on.
 *
 * A tile two levels coarse is stretched four to one along the ping axis, which
 * reads as coarseness. Four levels is sixteen to one, which reads as a
 * scattering layer: the picture stops looking like a low resolution echogram
 * and starts looking like a different measurement. The pinned coarsest is
 * exempt, because the alternative there is an empty panel.
 */
export const SUBSTITUTION_CAP = 2;

export interface SlotContext {
  /** Ping factor per level, ascending. */
  factors: number[];
  /** Pings a full tile holds, the same at every level. */
  tilePings: number;
  /** Pings the level holds, for clamping the last tile of a level. */
  pingsAt: (level: number) => number;
  resident: (level: number, row: number, column: number) => boolean;
  /** Levels past the target a substitution may reach. */
  cap?: number;
  /** A level the cap does not apply to, which is the pinned coarsest. */
  exempt?: number;
}

/**
 * Where one slot reads from.
 *
 * Walks from the target towards the coarsest and takes the first level holding
 * the tile, so the fallback is monotonic and never names a level that is not
 * resident. Undefined means nothing covers the slot, which the pinned coarsest
 * level is there to prevent.
 */
export function resolveSlot(
  slot: { row: number; column: number },
  target: number,
  context: SlotContext,
): SlotDraw | undefined {
  const {
    factors,
    tilePings,
    pingsAt,
    resident,
    cap = SUBSTITUTION_CAP,
    exempt,
  } = context;
  for (let level = target; level < factors.length; level += 1) {
    if (level - target > cap && level !== exempt) continue;
    const ratio = factors[level] / factors[target];
    // Powers of two by construction. A factor that does not divide the tile
    // would put a slot boundary inside a coarse ping, which is not a range.
    if (!Number.isInteger(ratio) || tilePings % ratio !== 0) continue;

    const row = Math.floor(slot.row / ratio);
    if (!resident(level, row, slot.column)) continue;

    const first = ((slot.row % ratio) * tilePings) / ratio;
    const held = pingsAt(level) - row * tilePings;
    const instances = Math.min(tilePings / ratio, held - first);
    if (instances <= 0) continue;
    return { level, row, column: slot.column, firstInstance: first, instances };
  }
  return undefined;
}
