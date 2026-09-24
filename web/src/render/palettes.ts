/**
 * Categorical palettes for label layers.
 *
 * Built by the same logic as `_create_cluster_colormap`: eleven base colors
 * chosen to read on a black background, extended by golden ratio hue spacing
 * once there are more clusters than base colors, with label -1 as noise. The
 * base colors arrive through colormaps.json so they are the figures' colors and
 * not a second opinion about them.
 *
 * Noise is black on purpose, per section 5.4. Masked data should be
 * conspicuous and noise should recede, which is why the two are different
 * colors rather than both discarded.
 */

import { NOISE_COLOR, clusterPalette, toByte } from './colormaps';

/** Golden ratio conjugate, the hue step `generate_colors` uses. */
const GOLDEN_RATIO = 0.618033988749895;

/** Saturation and value `generate_colors` fixes for a generated hue. */
const GENERATED_SATURATION = 0.9;
const GENERATED_VALUE = 0.8;

/**
 * Where label -1 sits in the table.
 *
 * A palette is indexed by label plus this, so the noise label lands at zero and
 * the shader indexes without a branch.
 */
export const LABEL_OFFSET = 1;

/**
 * Colors for labels -1 through `highest`, in order.
 *
 * Args:
 *   highest: Largest label present.
 */
export function paletteColors(highest: number): [number, number, number][] {
  const base = clusterPalette();
  const colors: [number, number, number][] = [NOISE_COLOR];
  for (let label = 0; label <= highest; label += 1) {
    colors.push(label < base.length ? base[label] : generated(label - base.length));
  }
  return colors;
}

/** Build the table as rgba bytes, ready for createLutTexture. */
export function buildPalette(highest: number): Uint8Array<ArrayBuffer> {
  const colors = paletteColors(highest);
  const table = new Uint8Array(colors.length * 4);
  for (let i = 0; i < colors.length; i += 1) {
    table[i * 4 + 0] = toByte(colors[i][0]);
    table[i * 4 + 1] = toByte(colors[i][1]);
    table[i * 4 + 2] = toByte(colors[i][2]);
    table[i * 4 + 3] = 255;
  }
  return table;
}

/** The nth color past the base set, by golden ratio hue spacing from zero. */
function generated(index: number): [number, number, number] {
  const hue = (index * GOLDEN_RATIO) % 1;
  return hsvToRgb(hue, GENERATED_SATURATION, GENERATED_VALUE);
}

/** `colorsys.hsv_to_rgb`, which is what the figures generate colors through. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const sector = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const wheel: [number, number, number][] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ];
  return wheel[sector];
}
