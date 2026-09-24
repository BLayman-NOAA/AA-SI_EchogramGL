/**
 * Whether two channels can be differenced, and what to say when they cannot.
 *
 * The check people expect here is "do the two share a sample grid", and that
 * check would refuse the most useful pair there is. On HB2407, 200 kHz samples
 * every 0.191 m and 38 kHz every 0.179 m: sample index i is a different depth
 * in the two, drifting to 4.7 m over 391 samples. Refusing them would rule out
 * 200 minus 38, which is the difference fisheries acoustics is built on.
 *
 * So a differing sample interval is resampled, not refused: the shader reads
 * the second channel at the fragment's depth rather than at its sample index.
 * What cannot be resampled is a pair that does not describe the same water, and
 * that is what this refuses.
 */

export interface ChannelGrid {
  /** Depth of sample zero, per ping. */
  rangeStart: Float64Array;
  /** Metres per sample, per ping. */
  rangeStep: Float64Array;
  samples: number;
}

export interface AlignmentProblem {
  reason: 'pings' | 'overlap';
  message: string;
}

/**
 * Fraction of the shallower channel's span the two must share.
 *
 * A pair that overlaps for a tenth of the water column produces a difference
 * layer that is nodata almost everywhere, which reads as a bug rather than as
 * an answer.
 */
export const MIN_OVERLAP = 0.5;

/**
 * Check a pair, returning nothing when they can be differenced.
 *
 * Ping alignment is exact or nothing: the two channels come from one merged
 * store and share a ping_time coordinate, so a mismatch means they were not
 * built together and no interpolation would make them comparable.
 */
export function checkAlignment(
  first: ChannelGrid,
  second: ChannelGrid,
  names: [string, string] = ['first', 'second'],
): AlignmentProblem | undefined {
  if (first.rangeStart.length !== second.rangeStart.length) {
    return {
      reason: 'pings',
      message:
        `${names[0]} has ${first.rangeStart.length} pings and ${names[1]} has ` +
        `${second.rangeStart.length}. Channels of one store share a ping axis, ` +
        `so this pair did not come from the same store.`,
    };
  }

  const a = extent(first);
  const b = extent(second);
  const shared = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  const shallower = Math.min(a[1] - a[0], b[1] - b[0]);
  if (!(shared > 0) || shared < shallower * MIN_OVERLAP) {
    const share = shared > 0 ? ((100 * shared) / shallower).toFixed(0) : '0';
    return {
      reason: 'overlap',
      message:
        `${names[0]} covers ${a[0].toFixed(1)} to ${a[1].toFixed(1)} m and ` +
        `${names[1]} covers ${b[0].toFixed(1)} to ${b[1].toFixed(1)} m, ` +
        `sharing ${share} percent of the shallower one. A difference over ` +
        `that would be nodata almost everywhere.`,
    };
  }
  return undefined;
}

/** Shallowest and deepest a channel reaches, over every ping. */
function extent(grid: ChannelGrid): [number, number] {
  let top = Infinity;
  let bottom = -Infinity;
  for (let ping = 0; ping < grid.rangeStart.length; ping += 1) {
    const start = grid.rangeStart[ping];
    const end = start + grid.rangeStep[ping] * grid.samples;
    if (start < top) top = start;
    if (end > bottom) bottom = end;
  }
  return [top, bottom];
}

/**
 * How far apart sample index i is in the two channels, at the deepest sample.
 *
 * Not a failure, but worth reporting: it is the distance a naive index for
 * index difference would be wrong by, and on a real pair it is metres.
 */
export function indexDrift(first: ChannelGrid, second: ChannelGrid): number {
  const samples = Math.min(first.samples, second.samples);
  let worst = 0;
  for (let ping = 0; ping < first.rangeStart.length; ping += 1) {
    const a = first.rangeStart[ping] + first.rangeStep[ping] * samples;
    const b = second.rangeStart[ping] + second.rangeStep[ping] * samples;
    worst = Math.max(worst, Math.abs(a - b));
  }
  return worst;
}
