/**
 * The layer stack.
 *
 * A view draws an ordered list of layers, one draw per layer per tile, and
 * draw order is the whole of the layering mechanism. Nothing here touches the
 * device: a layer is a description, and what it resolves to on the GPU is a
 * pipeline key, a blend state and a sampler, all of which are decided by pure
 * functions so they can be asserted without one.
 *
 * Three color modes, two shader paths. A solid tint is a colormap whose table
 * happens to hold one hue at rising alpha, so the tricolor echogram needs no
 * composite shader and no new branch: it is three tinted layers blending with
 * `add`, which saturates where strong layers overlap, and that is the reading
 * it is meant to have. Only a categorical palette is a different path, because
 * a label is an index rather than a magnitude.
 */

import type { BlendMode } from '../render/blend';

export type NodataMode = 'paint' | 'transparent';

/**
 * How a layer turns values into color.
 *
 * A tint encodes which channel rather than what value, which is why its legend
 * is a swatch and not a colorbar.
 */
export type Color =
  | { colormap: string }
  | { tint: [number, number, number] }
  | { palette: string };

export type ColorMode = 'colormap' | 'tint' | 'palette';

/**
 * What a layer computes.
 *
 * There is no ratio. Sv is already logarithmic, so subtracting decibels is
 * dividing in linear space: 200 minus 38 dB is ten log ten of the linear
 * ratio, and a separate linear divide would be the same question asked twice,
 * answered in a dimensionless unit no decibel colorbar can label. FR-11 is
 * satisfied by the difference rather than by a second mode.
 */
export type Transform = 'value' | 'difference';

/**
 * Limits a difference opens on, in decibels.
 *
 * Symmetric about zero, because the sign is the whole point: positive means
 * the first channel scatters more. Twelve decibels is wide enough to hold the
 * frequency responses fisheries acoustics separates species on.
 */
export const DIFFERENCE_CLIM: [number, number] = [-12, 12];

/** Limits a value layer opens on, which suit Sv and suit a difference badly. */
export const VALUE_CLIM: [number, number] = [-80, -20];

/** What a new layer of either kind should start at. */
export function defaultClim(against: number | undefined): [number, number] {
  return against === undefined ? [...VALUE_CLIM] : [...DIFFERENCE_CLIM];
}

/** A layer as asked for. Everything but the channel has a default. */
export interface LayerSpec {
  id?: string;
  /** Index along the store's channel axis. */
  channel: number;
  /**
   * The channel subtracted from it, for a difference or a ratio.
   *
   * Section 5.10 sketched this as `channels: string[]`, one or two long. Two
   * named fields say which is which, and a difference is not symmetric: 200
   * minus 38 is not 38 minus 200.
   */
  against?: number;
  transform?: Transform;
  color?: Color;
  clim?: [number, number];
  opacity?: number;
  visible?: boolean;
  blend?: BlendMode;
  /** Defaults by position: paint at the bottom, transparent above. */
  nodata?: NodataMode;
  /** How the value texture is sampled. A palette forces nearest. */
  filter?: GPUFilterMode;
}

/** A layer with every question answered. */
export interface Layer {
  id: string;
  channel: number;
  against?: number;
  transform: Transform;
  color: Color;
  clim: [number, number];
  opacity: number;
  visible: boolean;
  blend: BlendMode;
  nodata: NodataMode;
  filter: GPUFilterMode;
}

export interface LayerDefaults {
  color: Color;
  clim: [number, number];
  opacity: number;
  filter: GPUFilterMode;
}

export function colorMode(color: Color): ColorMode {
  if ('tint' in color) return 'tint';
  if ('palette' in color) return 'palette';
  return 'colormap';
}

/**
 * Whether a layer indexes a palette by label rather than mapping a magnitude.
 *
 * The one distinction the shader makes. A tint is a colormap to the shader and
 * a separate mode only to the legend.
 */
export function isCategorical(layer: Layer): boolean {
  return colorMode(layer.color) === 'palette';
}

/**
 * How a layer samples its value texture.
 *
 * A categorical layer is nearest whatever was asked for: linear filtering on a
 * label texture invents intermediate labels along every cluster boundary, and
 * an intermediate label indexes a palette entry that means something else. The
 * palette lookup itself takes no sampler at all, since the shader reads it with
 * textureLoad, so the path is nearest end to end by construction rather than by
 * a descriptor that could be set wrongly.
 */
export function filterFor(layer: Layer): GPUFilterMode {
  return isCategorical(layer) ? 'nearest' : layer.filter;
}

/**
 * Fill in a stack's defaults.
 *
 * `nodata` defaults by position rather than by visibility. Painting is what
 * makes a mask conspicuous, so the bottom layer paints and everything above it
 * is transparent; deciding it from what is currently visible would mean
 * toggling one layer changed another layer's pipeline.
 */
export function resolveLayers(
  specs: LayerSpec[],
  defaults: LayerDefaults,
): Layer[] {
  return specs.map((spec, index) => ({
    id: spec.id ?? `layer-${index}`,
    channel: spec.channel,
    // A transform naming no second channel is a plain value layer. Saying so
    // here rather than at every use means nothing downstream has to guess.
    against: spec.against,
    transform: spec.against === undefined ? 'value' : 'difference',
    color: spec.color ?? defaults.color,
    clim: spec.clim ?? (spec.against === undefined ? defaults.clim : [...DIFFERENCE_CLIM]),
    opacity: spec.opacity ?? defaults.opacity,
    visible: spec.visible ?? true,
    blend: spec.blend ?? 'over',
    nodata: spec.nodata ?? (index === 0 ? 'paint' : 'transparent'),
    filter: spec.filter ?? defaults.filter,
  }));
}

/**
 * The pipeline a layer needs.
 *
 * Everything in the key is baked into the pipeline: the blend state is part of
 * the descriptor and the two branches are override constants. Nothing else
 * about a layer is, so a limit, an opacity or a visibility change reaches the
 * next frame without a compilation, which is NFR-5.
 */
export function pipelineKey(layer: Layer, format: GPUTextureFormat): string {
  const categorical = isCategorical(layer) ? 'label' : 'value';
  return `value:${format}:${categorical}:${layer.transform}:${layer.nodata}:${layer.blend}`;
}

/** The override constants that key names, as the pipeline cache wants them. */
export function pipelineConstants(layer: Layer): Record<string, number> {
  return {
    NODATA_TRANSPARENT: layer.nodata === 'transparent' ? 1 : 0,
    CATEGORICAL: isCategorical(layer) ? 1 : 0,
    TRANSFORM: TRANSFORMS[layer.transform],
  };
}

const TRANSFORMS: Record<Transform, number> = { value: 0, difference: 1 };

/** The layers that draw, in draw order. */
export function drawn(layers: Layer[]): Layer[] {
  return layers.filter((layer) => layer.visible);
}

/** Every channel any layer reads, so tiles are fetched once for a shared one. */
export function channelsUsed(layers: Layer[]): number[] {
  const seen = new Set<number>();
  for (const layer of drawn(layers)) {
    seen.add(layer.channel);
    if (layer.against !== undefined) seen.add(layer.against);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Every channel one layer reads, which a slot must hold before it can draw. */
export function channelsOf(layer: Layer): number[] {
  return layer.against === undefined ? [layer.channel] : [layer.channel, layer.against];
}

/** Move a layer within the stack, which is the whole of reordering. */
export function reorder<T>(layers: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= layers.length) return layers;
  const next = [...layers];
  const [moved] = next.splice(from, 1);
  next.splice(Math.min(Math.max(to, 0), next.length), 0, moved);
  return next;
}
