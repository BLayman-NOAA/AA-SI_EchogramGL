import { describe, expect, it } from 'vitest';

import {
  MAX_EXAGGERATION,
  MIN_EXAGGERATION,
  exaggerationAt,
  toPosition,
} from '../src/shell/controls/aspect';

describe('exaggeration slider', () => {
  it('spans the ends of its range', () => {
    expect(exaggerationAt(0)).toBeCloseTo(MIN_EXAGGERATION, 9);
    expect(exaggerationAt(1)).toBeCloseTo(MAX_EXAGGERATION, 9);
  });

  it('puts true scale near the middle of the travel', () => {
    // Not exactly at the middle: the range reaches further above one than
    // below, because stretching a thin layer open is asked for more often than
    // squashing one flat. A linear slider over the same range would spend a
    // ten thousandth of its travel below one, which is half the useful
    // settings.
    expect(toPosition(1) / 1000).toBeGreaterThan(0.4);
    expect(toPosition(1) / 1000).toBeLessThan(0.6);
  });

  it('round trips a factor through a slider position', () => {
    // One step is under half a percent of a decade, so the round trip is close
    // in proportion rather than in absolute terms.
    for (const value of [0.05, 1, 7.5, 200]) {
      const back = exaggerationAt(toPosition(value) / 1000);
      expect(Math.abs(back / value - 1)).toBeLessThan(0.01);
    }
  });

  it('clamps a factor outside the range to an end', () => {
    expect(toPosition(1e6)).toBe(1000);
    expect(toPosition(1e-6)).toBe(0);
  });
});
