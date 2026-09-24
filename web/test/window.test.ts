import { describe, expect, it } from 'vitest';

import { buildXAxis } from '../src/geometry/coords';
import { type WindowContext, resolveWindow } from '../src/geometry/window';

// Pings every second, with a seven second gap between the fourth and fifth.
const pingTime = Float64Array.from([0, 1, 2, 3, 10, 11, 12], (s) => s * 1e9);
const epochNs = Date.UTC(2024, 5, 1) * 1e6;

function context(unit: 'seconds' | 'pings' = 'seconds'): WindowContext {
  return {
    axis: buildXAxis(unit, { pingTime }),
    epochNs,
    vertical: [0, 200],
  };
}

describe('resolveWindow', () => {
  it('returns the request and what was attained separately', () => {
    const result = resolveWindow({ x: { min: 0.2, max: 2.6 } }, context());
    expect(result.requested.x).toEqual([0.2, 2.6]);
    expect(result.attained.x).toEqual([-0.5, 4]);
    expect(result.pings).toEqual([0, 3]);
    expect(result.clamped).toBe(false);
    expect(result.empty).toBe(false);
  });

  it('snaps to whole pings, because whole pings are what get drawn', () => {
    const result = resolveWindow({ x: { min: 0.6, max: 1.4 } }, context());
    // First and last, so one ping is a pair with the same index twice.
    expect(result.pings).toEqual([1, 1]);
    expect(result.attained.x).toEqual([0.5, 1.5]);
  });

  it('clamps a window that reaches outside the survey and says so', () => {
    const result = resolveWindow({ x: { min: -50, max: 5 } }, context());
    expect(result.clamped).toBe(true);
    expect(result.attained.x[0]).toBeGreaterThanOrEqual(-0.5);
    expect(result.empty).toBe(false);
  });

  it('reports a window inside a gap as empty, with no ping extent', () => {
    const result = resolveWindow({ x: { min: 5, max: 8 } }, context());
    expect(result.empty).toBe(true);
    expect(result.pings).toBeUndefined();
    expect(result.clamped).toBe(false);
  });

  it('clamps the vertical to the data and flags it', () => {
    const result = resolveWindow({ y: { min: -10, max: 500 } }, context());
    expect(result.attained.y).toEqual([0, 200]);
    expect(result.clamped).toBe(true);
  });

  it('defaults each axis to the whole extent when it is not asked for', () => {
    const result = resolveWindow({ y: { min: 10, max: 20 } }, context());
    expect(result.attained.y).toEqual([10, 20]);
    expect(result.pings).toEqual([0, 6]);
    expect(result.clamped).toBe(false);
  });

  it('takes bounds in either order', () => {
    const result = resolveWindow({ x: { min: 2.6, max: 0.2 } }, context());
    expect(result.requested.x).toEqual([0.2, 2.6]);
  });

  it('reads a timestamp bound against the first ping', () => {
    const start = new Date(Date.UTC(2024, 5, 1, 0, 0, 2)).toISOString();
    const end = new Date(Date.UTC(2024, 5, 1, 0, 0, 3)).toISOString();
    const result = resolveWindow({ x: { min: start, max: end } }, context());
    expect(result.requested.x).toEqual([2, 3]);
    expect(result.pings).toEqual([2, 3]);
  });

  it('refuses a timestamp on an axis that is not time', () => {
    expect(() =>
      resolveWindow({ x: { min: '2024-06-01T00:00:02Z', max: 3 } }, context('pings')),
    ).toThrow(/needs a time axis/);
  });

  it('refuses a bound it cannot read as a timestamp', () => {
    expect(() =>
      resolveWindow({ x: { min: 'half past three', max: 3 } }, context()),
    ).toThrow(/could not read/);
  });
});
