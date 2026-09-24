/**
 * Index, data and screen coordinates.
 *
 * Index space is `(ping, sample)`, what the texture holds. Data space is
 * `(x, y)` where x carries the chosen axis unit and y is range or depth in
 * metres. Screen space is pixels. Index to data uses the geometry sidecar;
 * data to screen is the view matrix.
 *
 * Selections are stored in data space, which is why they survive a level
 * change.
 */

import type { ChannelGeometry } from '../data/store';
import type { XUnit } from './axes';

/** Vertical geometry for one channel, plus the sample count it applies to. */
export interface VerticalGeometry extends ChannelGeometry {
  samples: number;
}

/**
 * The x position of every ping, in one unit, with the cell edges to draw.
 *
 * Edges rather than centres because a ping is a cell, not a point, and the
 * gap handling belongs here rather than in the shader.
 */
export interface XAxisValues {
  unit: XUnit;
  centre: Float64Array;
  left: Float64Array;
  right: Float64Array;
}

/**
 * How many nominal ping intervals a cell may span before it stops widening.
 *
 * Without a cap, a transit gap draws as one very wide cell, which asserts data
 * across a stretch where none was recorded. Capping leaves a hole instead.
 */
export const GAP_FACTOR = 2.0;

/** Depth or range of one sample within one ping. */
export function sampleToRange(
  geometry: VerticalGeometry,
  ping: number,
  sample: number,
): number {
  return geometry.rangeStart[ping] + sample * geometry.rangeStep[ping];
}

/** Fractional sample index at a depth within one ping. */
export function rangeToSample(
  geometry: VerticalGeometry,
  ping: number,
  range: number,
): number {
  return (range - geometry.rangeStart[ping]) / geometry.rangeStep[ping];
}

/** Vertical extent of one ping, shallowest and deepest edge. */
export function pingExtent(
  geometry: VerticalGeometry,
  ping: number,
): [number, number] {
  return [
    sampleToRange(geometry, ping, 0),
    sampleToRange(geometry, ping, geometry.samples),
  ];
}

/** Vertical extent across every ping, which heave makes wider than any one. */
export function verticalExtent(geometry: VerticalGeometry): [number, number] {
  let top = Infinity;
  let bottom = -Infinity;
  for (let ping = 0; ping < geometry.rangeStart.length; ping += 1) {
    const [a, b] = pingExtent(geometry, ping);
    if (a < top) top = a;
    if (b > bottom) bottom = b;
  }
  return [top, bottom];
}

/**
 * Vertical geometry for a chosen unit.
 *
 * In metres a sample sits where the sidecar puts it. In sample index or bin
 * units the sample index is the coordinate, which is the same affine model with
 * a start of zero and a step of one, so nothing downstream needs a second path.
 */
export function verticalFor(
  unit: 'meters' | 'range_sample' | 'bins',
  geometry: VerticalGeometry,
): VerticalGeometry {
  if (unit === 'meters') return geometry;
  const pings = geometry.rangeStart.length;
  return {
    rangeStart: new Float64Array(pings),
    rangeStep: new Float64Array(pings).fill(1),
    samples: geometry.samples,
  };
}

/** Sidecar arrays an x axis can be built from. */
export interface XSource {
  /** Nanoseconds since the unix epoch, one per ping. */
  pingTime: Float64Array;
  /** Cumulative along track distance in metres, one per ping. */
  xDistance?: Float64Array;
  /** Source pings this level merges into one, from the multiscales factors. */
  factor?: number;
}

/**
 * Place every ping on the chosen axis.
 *
 * `datetime` and `seconds` share one data space, seconds from the first ping,
 * and differ only in how ticks are labelled. Carrying dates as day numbers the
 * way matplotlib does would make the span incomparable with depth, which is
 * the reason `calculate_panel_geometry` takes a separate `x_range`.
 */
export function buildXAxis(unit: XUnit, source: XSource): XAxisValues {
  const centre = xValues(unit, source);
  const { left, right } = cellEdges(centre, gapReference(unit, source));
  return { unit, centre, left, right };
}

/**
 * What decides whether two pings have a gap between them.
 *
 * Whether a ping was missed is a question about time, not about the axis being
 * drawn. A ping axis closes gaps by construction, which is what it is for, so
 * it answers for itself and never reports one.
 */
function gapReference(unit: XUnit, source: XSource): Float64Array | undefined {
  return unit === 'pings' || unit === 'bins' ? undefined : source.pingTime;
}

function xValues(unit: XUnit, source: XSource): Float64Array {
  const count = source.pingTime.length;
  if (unit === 'pings' || unit === 'bins') {
    // Source pings, not this level's own index. A time or distance axis is the
    // same coordinate at every level and an index axis has to be made one, or
    // the view moves whenever the level changes underneath it and the label
    // means something different at every zoom.
    const factor = source.factor ?? 1;
    return Float64Array.from({ length: count }, (_, i) => (i + 0.5) * factor - 0.5);
  }
  if (unit === 'meters') {
    if (!source.xDistance) {
      throw new Error('the meters axis needs an x_distance sidecar');
    }
    return source.xDistance;
  }
  const epoch = source.pingTime[0];
  return Float64Array.from(source.pingTime, (t) => (t - epoch) / 1e9);
}

/**
 * Cell edges from centres, capped so a gap stays a gap.
 *
 * Each edge sits halfway to the neighbour, except where that would make the
 * cell wider than GAP_FACTOR nominal intervals. The first and last cells
 * mirror their one neighbour.
 */
export function cellEdges(
  centre: Float64Array,
  reference: Float64Array = centre,
): {
  left: Float64Array;
  right: Float64Array;
} {
  const count = centre.length;
  const left = new Float64Array(count);
  const right = new Float64Array(count);
  if (count === 0) return { left, right };
  if (count === 1) {
    left[0] = centre[0] - 0.5;
    right[0] = centre[0] + 0.5;
    return { left, right };
  }

  const cap = (GAP_FACTOR * medianSpacing(centre)) / 2;
  const limit = GAP_FACTOR * medianSpacing(reference);
  for (let i = 0; i < count; i += 1) {
    const back = i > 0 ? (centre[i] - centre[i - 1]) / 2 : undefined;
    const forward = i < count - 1 ? (centre[i + 1] - centre[i]) / 2 : undefined;
    // A cell reaches its neighbour unless a ping is missing between them, and
    // only the reference says whether one is. On a distance axis the spacing
    // is speed times interval and varies by a factor of eighty over a survey,
    // so capping on it draws every stretch of open water as absent data.
    const behind = i > 0 && reference[i] - reference[i - 1] > limit;
    const ahead = i < count - 1 && reference[i + 1] - reference[i] > limit;
    left[i] = centre[i] - shorten(back ?? forward ?? cap, behind, cap);
    right[i] = centre[i] + shorten(forward ?? back ?? cap, ahead, cap);
  }
  return { left, right };
}

/** Pull an edge back to the nominal half cell, where there is a gap to leave. */
function shorten(half: number, gap: boolean, cap: number): number {
  return gap ? Math.min(half, cap) : half;
}

export function medianSpacing(centre: Float64Array): number {
  if (centre.length < 2) return 1;
  const gaps = new Float64Array(centre.length - 1);
  for (let i = 1; i < centre.length; i += 1) gaps[i - 1] = centre[i] - centre[i - 1];
  const sorted = Float64Array.from(gaps).sort();
  const middle = sorted.length >> 1;
  const value =
    sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return value > 0 ? value : 1;
}

/**
 * First and last ping whose cell overlaps a range on the x axis.
 *
 * Returns undefined when the range falls between cells, which is what a window
 * inside a survey gap does.
 */
export function pingsInRange(
  axis: XAxisValues,
  min: number,
  max: number,
): [number, number] | undefined {
  let first = -1;
  let last = -1;
  for (let i = 0; i < axis.centre.length; i += 1) {
    if (axis.right[i] > min && axis.left[i] < max) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? undefined : [first, last];
}

/** A range in data units. */
export type Extent = [number, number];

/**
 * Carry a horizontal range from one axis to another.
 *
 * A viewport range is in the units of the axis that set it, so switching from
 * pings to metres without this leaves a view showing the first sixth of a track
 * it had been showing all of. The pings covered are what stays the same.
 */
export function remapRange(from: XAxisValues, to: XAxisValues, range: Extent): Extent {
  const last = to.right.length - 1;
  const covered = pingsInRange(from, range[0], range[1]);
  if (!covered) return [to.left[0], to.right[last]];
  return [to.left[covered[0]], to.right[covered[1]]];
}

/**
 * Column major mat3x3 taking data coordinates to clip space, padded the way
 * WGSL lays a mat3x3f out: each column occupies four floats.
 *
 * The y axis is flipped, so a larger y is deeper and draws lower on screen.
 */
export function clipMatrix(x: Extent, y: Extent): Float32Array<ArrayBuffer> {
  const width = x[1] - x[0] || 1;
  const height = y[1] - y[0] || 1;

  const matrix = new Float32Array(12);
  matrix[0] = 2 / width;
  matrix[4 + 1] = -2 / height;
  matrix[8 + 0] = -(x[1] + x[0]) / width;
  matrix[8 + 1] = (y[1] + y[0]) / height;
  matrix[8 + 2] = 1;
  return matrix;
}
