import { describe, expect, it } from 'vitest';

import { NOISE_COLOR, clusterPalette } from '../src/render/colormaps';
import { LABEL_OFFSET, buildPalette, hsvToRgb, paletteColors } from '../src/render/palettes';

describe('categorical palette', () => {
  it('puts noise first, so a label indexes the table directly', () => {
    const colors = paletteColors(3);
    expect(LABEL_OFFSET).toBe(1);
    expect(colors[0]).toEqual(NOISE_COLOR);
    expect(colors[0 + LABEL_OFFSET]).toEqual(clusterPalette()[0]);
    expect(colors).toHaveLength(5);
  });

  it('uses the figures colors while they last', () => {
    const base = clusterPalette();
    const colors = paletteColors(base.length - 1);
    expect(colors.slice(1)).toEqual(base);
  });

  it('extends past the base set by golden ratio hue spacing', () => {
    const base = clusterPalette();
    const colors = paletteColors(base.length + 1);
    // generate_colors starts its hue offset at zero for the first generated
    // color, which is full saturation red at value 0.8.
    expect(colors[base.length + LABEL_OFFSET]).toEqual(hsvToRgb(0, 0.9, 0.8));
    expect(colors[base.length + LABEL_OFFSET]).not.toEqual(
      colors[base.length + LABEL_OFFSET + 1],
    );
  });

  it('matches colorsys on the hue wheel', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([1, 0, 0]);
    expect(hsvToRgb(1 / 3, 1, 1)).toEqual([0, 1, 1 - 1]);
    expect(hsvToRgb(2 / 3, 1, 1)[2]).toBeCloseTo(1, 6);
  });

  it('builds an opaque rgba table one entry per label', () => {
    const table = buildPalette(2);
    expect(table).toHaveLength(4 * 4);
    expect(table[3]).toBe(255);
    expect(Array.from(table.slice(0, 3))).toEqual([0, 0, 0]);
  });
});
