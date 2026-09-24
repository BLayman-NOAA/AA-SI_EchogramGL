import { describe, expect, it } from 'vitest';

import {
  NODATA_COLOR,
  buildLut,
  buildTintLut,
  colormapNames,
  parseHex,
  toByte,
} from '../src/render/colormaps';
import reference from './colormaps.reference.json';

const expected = reference as {
  size: number;
  continuous: Record<string, number[]>;
};

describe('colormap tables', () => {
  it('matches matplotlib entry for entry', () => {
    for (const name of Object.keys(expected.continuous)) {
      const lut = buildLut(name);
      expect(Array.from(lut), name).toEqual(expected.continuous[name]);
    }
  });

  it('covers every colormap the definitions carry', () => {
    expect(colormapNames().sort()).toEqual(Object.keys(expected.continuous).sort());
  });

  it('quantizes by truncation, as matplotlib does', () => {
    // 0.26666 times 255 is 67.99, which rounds to 68 and truncates to 67.
    expect(toByte(0.26666)).toBe(67);
    expect(toByte(0)).toBe(0);
    expect(toByte(1)).toBe(255);
  });

  it('builds a tint as one hue at rising alpha', () => {
    // Only alpha ramps. Blending multiplies rgb by alpha once, so a table that
    // darkened the hue as well would make the additive result the square of
    // the intensity rather than proportional to it.
    const lut = buildTintLut([1, 0, 0], 4);
    expect(Array.from(lut)).toEqual([
      255, 0, 0, 0,
      255, 0, 0, 85,
      255, 0, 0, 170,
      255, 0, 0, 255,
    ]);
  });

  it('carries the nodata color from the figures', () => {
    expect(NODATA_COLOR.map((c) => Math.round(c * 255))).toEqual([46, 46, 46]);
    expect(parseHex('#2E2E2E')).toEqual(NODATA_COLOR);
  });
});
