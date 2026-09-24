import { describe, expect, it } from 'vitest';

import { clipMatrix } from '../src/geometry/coords';

/** Apply the padded column major mat3x3 the way WGSL does. */
function apply(matrix: Float32Array, x: number, y: number): [number, number] {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8],
    matrix[1] * x + matrix[5] * y + matrix[9],
  ];
}

describe('clipMatrix', () => {
  const x: [number, number] = [0, 100];
  const y: [number, number] = [5, 205];

  it('puts the shallowest sample at the top of the viewport', () => {
    const matrix = clipMatrix(x, y);
    const [left, top] = apply(matrix, 0, 5);
    const [right, bottom] = apply(matrix, 100, 205);
    expect(left).toBeCloseTo(-1, 5);
    expect(top).toBeCloseTo(1, 5);
    expect(right).toBeCloseTo(1, 5);
    expect(bottom).toBeCloseTo(-1, 5);
  });

  it('keeps the middle of the data in the middle of the viewport', () => {
    const [cx, cy] = apply(clipMatrix(x, y), 50, 105);
    expect(cx).toBeCloseTo(0, 6);
    expect(cy).toBeCloseTo(0, 6);
  });

  it('pads each column to four floats, as WGSL lays out a mat3x3f', () => {
    expect(clipMatrix(x, y).length).toBe(12);
  });

  it('survives a degenerate extent rather than dividing by zero', () => {
    for (const value of clipMatrix([7, 7], [0, 0])) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
