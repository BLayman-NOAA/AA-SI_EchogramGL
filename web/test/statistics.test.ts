import { describe, expect, it } from 'vitest';

import {
  type Histogram,
  accumulate,
  labelShares,
  percentileLimits,
  statistics,
} from '../src/compute/statistics';

/** Build the partial buffer the shader writes: linear, weighted, count, pad. */
function partials(blocks: [number, number, number][]): ArrayBuffer {
  const buffer = new ArrayBuffer(blocks.length * 16);
  const floats = new Float32Array(buffer);
  const uints = new Uint32Array(buffer);
  blocks.forEach(([linear, weighted, count], index) => {
    floats[index * 4] = linear;
    floats[index * 4 + 1] = weighted;
    uints[index * 4 + 2] = count;
  });
  return buffer;
}

function histogram(counts: number[], range: [number, number]): Histogram {
  return { counts: Uint32Array.from(counts), range };
}

describe('accumulating partials', () => {
  it('sums every block', () => {
    const totals = accumulate(
      partials([
        [1, 10, 3],
        [2, 20, 4],
        [0.5, 5, 1],
      ]),
      3,
    );
    expect(totals.count).toBe(8);
    expect(totals.linear).toBeCloseTo(3.5, 6);
    expect(totals.weighted).toBeCloseTo(35, 6);
  });

  it('reads only the blocks the dispatch used', () => {
    // The buffer outlives one reduction and is not cleared past the blocks in
    // play, so the count has to bound the sum rather than the buffer length.
    const buffer = partials([
      [1, 1, 1],
      [99, 99, 99],
    ]);
    expect(accumulate(buffer, 1).count).toBe(1);
  });
});

describe('region statistics', () => {
  it('takes the mean in linear space and reports it in decibels', () => {
    // -60 dB and -40 dB. Their linear mean is 5.05e-5, which is -42.97 dB, and
    // it is dominated by the louder one. The mean of the decibels would be -50,
    // and that is the number NFR-8 forbids.
    const totals = { count: 2, linear: 1e-6 + 1e-4, weighted: 0 };
    expect(statistics(totals, 1).meanSv).toBeCloseTo(-42.97, 2);
  });

  it('computes NASC from the depth integral averaged over pings', () => {
    // weighted is the sum of linear Sv times each ping's range step, so it is
    // already the depth integral; NASC is 4 pi times that per square nautical
    // mile, averaged over the pings the rectangle spans.
    const totals = { count: 10, linear: 1e-5, weighted: 2e-6 };
    const expected = 4 * Math.PI * 1852 ** 2 * (2e-6 / 4);
    expect(statistics(totals, 4).nasc).toBeCloseTo(expected, 9);
  });

  it('says nothing rather than zero where no sample was counted', () => {
    const empty = statistics({ count: 0, linear: 0, weighted: 0 }, 100);
    expect(empty.meanSv).toBeUndefined();
    expect(empty.nasc).toBeUndefined();
  });
});

describe('percentile limits', () => {
  it('clips the tails of a known histogram', () => {
    // Ten bins over 0 to 100, a hundred counts each. The second percentile
    // falls a fifth of the way into the first bin and the ninety eighth a
    // fifth from the end of the last.
    const limits = percentileLimits(histogram(Array(10).fill(100), [0, 100]));
    expect(limits?.[0]).toBeCloseTo(2, 6);
    expect(limits?.[1]).toBeCloseTo(98, 6);
  });

  it('interpolates inside a bin rather than quantizing to its edge', () => {
    const limits = percentileLimits(histogram([0, 100, 0, 0], [0, 40]), 0.25, 0.75);
    expect(limits?.[0]).toBeCloseTo(12.5, 6);
    expect(limits?.[1]).toBeCloseTo(17.5, 6);
  });

  it('widens to one bin where every sample is in the same place', () => {
    // Equal limits map the whole picture to one colour, which is a worse
    // answer than a bin wide window on the value that is there.
    const limits = percentileLimits(histogram([0, 50, 0, 0], [0, 40]), 0.5, 0.5);
    expect(limits![1] - limits![0]).toBeCloseTo(10, 6);
  });

  it('has no answer for an empty histogram', () => {
    expect(percentileLimits(histogram([0, 0, 0], [0, 30]))).toBeUndefined();
  });
});

describe('categorical binning', () => {
  it('reports the share of visible cells per label', () => {
    // Labels binned by value: a range of -1 to 3 over four bins puts each
    // whole label in its own bin, which is what a categorical layer needs.
    const shares = labelShares(histogram([10, 30, 40, 20], [-1.5, 2.5]));
    expect(shares.get(-1)).toBeCloseTo(0.1, 6);
    expect(shares.get(0)).toBeCloseTo(0.3, 6);
    expect(shares.get(1)).toBeCloseTo(0.4, 6);
    expect(shares.get(2)).toBeCloseTo(0.2, 6);
  });

  it('leaves out a label nothing on screen carries', () => {
    const shares = labelShares(histogram([0, 5, 0, 5], [-1.5, 2.5]));
    expect([...shares.keys()].sort()).toEqual([0, 2]);
  });
});
