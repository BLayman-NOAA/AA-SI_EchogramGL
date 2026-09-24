import { describe, expect, it } from 'vitest';

import { type ChannelGrid, checkAlignment, indexDrift } from '../src/app/alignment';

function grid(step: number, samples: number, start = 0, pings = 8): ChannelGrid {
  return {
    rangeStart: new Float64Array(pings).fill(start),
    rangeStep: new Float64Array(pings).fill(step),
    samples,
  };
}

/** The pair fisheries acoustics is built on, as HB2407 actually records it. */
const kHz200 = grid(0.191022, 391);
const kHz38 = grid(0.179083, 391);

describe('channel alignment', () => {
  it('accepts a pair whose sample intervals differ', () => {
    // The check people expect here would refuse this, and it is the single
    // most useful difference there is. A differing interval is resampled by
    // depth in the shader, not refused.
    expect(checkAlignment(kHz200, kHz38)).toBeUndefined();
  });

  it('measures how far apart sample index i is at the deepest sample', () => {
    // What differencing by index rather than by depth would be wrong by.
    expect(indexDrift(kHz200, kHz38)).toBeCloseTo(4.67, 2);
  });

  it('refuses a pair from different stores', () => {
    const problem = checkAlignment(kHz200, grid(0.179083, 391, 0, 9));
    expect(problem?.reason).toBe('pings');
    expect(problem?.message).toContain('same store');
  });

  it('refuses a pair that does not cover the same water', () => {
    // 0 to 250 m against 300 to 310 m. A difference over that is nodata
    // everywhere, which reads as a bug rather than as an answer.
    const problem = checkAlignment(grid(0.64, 391), grid(0.05, 200, 300));
    expect(problem?.reason).toBe('overlap');
    expect(problem?.message).toContain('percent');
  });

  it('accepts a short channel that sits wholly inside a deep one', () => {
    // The overlap is measured against the shallower span, not the deeper. A
    // 10 m channel fully covered by a 250 m one is defined everywhere it
    // exists, and drawing it over that band is the right answer.
    expect(checkAlignment(grid(0.64, 391), grid(0.05, 200, 240))).toBeUndefined();
  });

  it('names the channels in the message it produces', () => {
    const problem = checkAlignment(kHz200, grid(0.179083, 391, 0, 9), [
      '200 kHz',
      '38 kHz',
    ]);
    expect(problem?.message).toContain('200 kHz');
    expect(problem?.message).toContain('38 kHz');
  });

  it('accepts a pair on the same grid', () => {
    expect(checkAlignment(kHz38, grid(0.179083, 391))).toBeUndefined();
    expect(indexDrift(kHz38, grid(0.179083, 391))).toBe(0);
  });
});
