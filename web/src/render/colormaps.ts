/**
 * Colormap lookup tables.
 *
 * Definitions come from matplotlib through colormaps.json, written by
 * `aa-echogram colormaps`, so a value maps to the same color here as it does in
 * the existing figures. Nothing in this file invents a color.
 */

import definitions from './colormaps.json';

export interface ColormapDocument {
  version: number;
  size: number;
  source: string;
  nodataColor: string;
  noiseColor: string;
  clusterPalette: string[];
  continuous: Record<string, number[][]>;
}

const document = definitions as ColormapDocument;

export const LUT_SIZE = document.size;
export const NODATA_COLOR = parseHex(document.nodataColor);
export const NOISE_COLOR = parseHex(document.noiseColor);

export function colormapNames(): string[] {
  return Object.keys(document.continuous);
}

/**
 * Quantize a 0 to 1 channel the way matplotlib does.
 *
 * matplotlib truncates rather than rounds, and matching it keeps viewer pixels
 * identical to figure pixels rather than off by one.
 */
export function toByte(value: number): number {
  return Math.min(Math.floor(value * 255), 255);
}

/** Build an RGBA byte table for one colormap. */
export function buildLut(name: string): Uint8Array<ArrayBuffer> {
  const stops = document.continuous[name];
  if (!stops) {
    throw new Error(`unknown colormap ${name}; have ${colormapNames().join(', ')}`);
  }
  const lut = new Uint8Array(stops.length * 4);
  for (let i = 0; i < stops.length; i += 1) {
    const [r, g, b] = stops[i];
    lut[i * 4 + 0] = toByte(r);
    lut[i * 4 + 1] = toByte(g);
    lut[i * 4 + 2] = toByte(b);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/**
 * Build a table holding one hue at rising alpha.
 *
 * A solid tint is a degenerate colormap rather than a separate shader path, so
 * the tricolor echogram of three tinted layers needs nothing new.
 *
 * The hue is constant and only alpha ramps, which is what makes the additive
 * result linear in the value: blending multiplies rgb by alpha once, so a table
 * that darkened the hue as well would contribute the square of the intensity.
 * Full length rather than two entries, so it samples like any other colormap.
 */
export function buildTintLut(
  tint: [number, number, number],
  size = LUT_SIZE,
): Uint8Array<ArrayBuffer> {
  const lut = new Uint8Array(size * 4);
  for (let i = 0; i < size; i += 1) {
    lut[i * 4 + 0] = toByte(tint[0]);
    lut[i * 4 + 1] = toByte(tint[1]);
    lut[i * 4 + 2] = toByte(tint[2]);
    lut[i * 4 + 3] = toByte(i / (size - 1));
  }
  return lut;
}

/** The categorical base colors, as 0 to 1 triples. */
export function clusterPalette(): [number, number, number][] {
  return document.clusterPalette.map(parseHex);
}

/** Upload a table as a width by 1 rgba8unorm texture. */
export function createLutTexture(
  device: GPUDevice,
  lut: Uint8Array<ArrayBuffer>,
  label = 'colormap',
): GPUTexture {
  const width = lut.length / 4;
  const texture = device.createTexture({
    label,
    size: [width, 1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    lut,
    { bytesPerRow: width * 4 },
    [width, 1, 1],
  );
  return texture;
}

/** Parse `#rrggbb` into three 0 to 1 channels. */
export function parseHex(hex: string): [number, number, number] {
  const text = hex.replace('#', '');
  if (text.length < 6) throw new Error(`not a hex color: ${hex}`);
  return [
    parseInt(text.slice(0, 2), 16) / 255,
    parseInt(text.slice(2, 4), 16) / 255,
    parseInt(text.slice(4, 6), 16) / 255,
  ];
}
