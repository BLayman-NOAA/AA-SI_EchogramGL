/**
 * What a reduction means, decided without a device.
 *
 * The GPU produces counts and sums; everything an analyst reads comes from
 * these functions, so the arithmetic is testable against a Python reference
 * without a browser or a graphics card in the loop.
 */

/** Metres in a nautical mile, which is what NASC is per square of. */
const METRES_PER_NAUTICAL_MILE = 1852;

/** Bins the viewport histogram uses. About half a decibel over a 120 dB span. */
export const DEFAULT_BINS = 256;

/** Where the histogram starts and stops, if the store does not say. */
export const DEFAULT_RANGE: [number, number] = [-120, 0];

export interface Histogram {
  counts: Uint32Array;
  /** Lowest and highest value the bins cover. */
  range: [number, number];
}

export interface Accumulated {
  /** Samples with data inside the region. */
  count: number;
  /** Sum of linear Sv over them. */
  linear: number;
  /** Sum of linear Sv times each ping's range step, in metres. */
  weighted: number;
}

export interface RegionStatistics extends Accumulated {
  /** Mean linear Sv expressed back in decibels, or undefined with no data. */
  meanSv?: number;
  /** Nautical area scattering coefficient, m^2 per square nautical mile. */
  nasc?: number;
  /** Pings the region spans, which is what the depth integral is averaged over. */
  pings: number;
}

/**
 * Sum the per block partials the shader wrote.
 *
 * Four floats per block, laid out as linear, weighted, count, padding, because
 * a storage buffer struct aligns to sixteen bytes.
 */
export function accumulate(partials: ArrayBuffer, blocks: number): Accumulated {
  const floats = new Float32Array(partials);
  const uints = new Uint32Array(partials);
  let linear = 0;
  let weighted = 0;
  let count = 0;
  for (let block = 0; block < blocks; block += 1) {
    linear += floats[block * 4];
    weighted += floats[block * 4 + 1];
    count += uints[block * 4 + 2];
  }
  return { count, linear, weighted };
}

/**
 * Turn the accumulators into the numbers a host application shows.
 *
 * The mean is taken in linear space and reported in decibels, per NFR-8, since
 * the mean of decibels is a different and wrong quantity.
 *
 * NASC integrates linear Sv over depth to get an area scattering coefficient
 * per ping, then averages that over the pings the region spans. A ping whose
 * samples were all masked contributes zero rather than being left out: it is
 * water the survey looked at and found nothing in, which is a real zero.
 */
export function statistics(totals: Accumulated, pings: number): RegionStatistics {
  if (!totals.count || !pings) return { ...totals, pings };
  const meanSv = 10 * Math.log10(totals.linear / totals.count);
  const areaScattering = totals.weighted / pings;
  const nasc = 4 * Math.PI * METRES_PER_NAUTICAL_MILE ** 2 * areaScattering;
  return { ...totals, pings, meanSv, nasc };
}

/**
 * Display limits from percentiles of a histogram.
 *
 * The bin a percentile falls in is the answer to within its width, and the
 * position inside it is interpolated from the running count, so a 256 bin
 * histogram over 120 dB does not quantize the limits to half a decibel.
 */
export function percentileLimits(
  histogram: Histogram,
  low = 0.02,
  high = 0.98,
): [number, number] | undefined {
  const { counts, range } = histogram;
  let total = 0;
  for (const count of counts) total += count;
  if (!total) return undefined;

  const lower = valueAt(histogram, total * low);
  const upper = valueAt(histogram, total * high);
  if (!(upper > lower)) {
    // Every sample in one bin. Widening to the bin is more use than limits
    // that are equal, which would map the whole picture to one colour.
    const width = (range[1] - range[0]) / counts.length;
    return [lower, lower + width];
  }
  return [lower, upper];
}

/** The value below which `target` of the counted samples fall. */
function valueAt(histogram: Histogram, target: number): number {
  const { counts, range } = histogram;
  const width = (range[1] - range[0]) / counts.length;
  let seen = 0;
  for (let bin = 0; bin < counts.length; bin += 1) {
    const next = seen + counts[bin];
    if (next >= target && counts[bin] > 0) {
      const within = (target - seen) / counts[bin];
      return range[0] + (bin + within) * width;
    }
    seen = next;
  }
  return range[1];
}

/** Per label counts, for a categorical legend. Labels start at -1 for noise. */
export function labelCounts(histogram: Histogram): Map<number, number> {
  const { counts, range } = histogram;
  const width = (range[1] - range[0]) / counts.length;
  const totals = new Map<number, number>();
  for (let bin = 0; bin < counts.length; bin += 1) {
    if (!counts[bin]) continue;
    const label = Math.round(range[0] + (bin + 0.5) * width);
    totals.set(label, (totals.get(label) ?? 0) + counts[bin]);
  }
  return totals;
}

/** Share of the counted cells each label holds, which is what FR-68 asks for. */
export function labelShares(histogram: Histogram): Map<number, number> {
  const totals = labelCounts(histogram);
  let total = 0;
  for (const count of totals.values()) total += count;
  if (!total) return new Map();
  const shares = new Map<number, number>();
  for (const [label, count] of totals) shares.set(label, count / total);
  return shares;
}
