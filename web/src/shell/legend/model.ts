/**
 * What a legend says, decided without touching the DOM.
 *
 * The form follows the layer's color mode. A tinted layer gets a swatch and not
 * a colorbar because in additive mode the hue encodes which channel, not what
 * value, and a gradient would say the opposite.
 *
 * One legend per visible layer. A hidden layer has none, which is part of what
 * makes toggling legible: the stack you can see is the stack described. The
 * nodata swatch belongs to the stack rather than to any layer, so it appears
 * once and only where something actually paints it.
 */

import { type Layer, colorMode } from '../../app/layers';
import { NODATA_COLOR } from '../../render/colormaps';

export type LegendForm = 'colorbar' | 'swatch' | 'keyed';

export interface LegendKey {
  label: number;
  color: [number, number, number];
  /** Share of visible cells, once the histogram in milestone 8 supplies it. */
  share?: number;
}

export interface LegendItem {
  layer: string;
  form: LegendForm;
  /** What the layer is of, which for an acoustic store is the frequency. */
  title: string;
  unit?: string;
  clim?: [number, number];
  colormap?: string;
  tint?: [number, number, number];
  keys?: LegendKey[];
}

export interface Legend {
  items: LegendItem[];
  /** Present only when some visible layer paints its nodata. */
  nodata?: { color: [number, number, number]; label: string };
}

export interface LegendContext {
  /** Name for a channel index, such as '38 kHz'. */
  channelName: (channel: number) => string;
  /** Unit of the value, shown against the limits. */
  unit: string;
  /** Labels present, for a categorical layer, with their colors. */
  keys?: (palette: string) => LegendKey[];
  /** The color the view paints nodata with, when it is not the default. */
  nodataColor?: [number, number, number];
}

export function legendFor(layers: Layer[], context: LegendContext): Legend {
  const visible = layers.filter((layer) => layer.visible);
  const items = visible.map((layer) => item(layer, context));
  const painted = visible.some((layer) => layer.nodata === 'paint');
  return painted
    ? { items, nodata: { color: context.nodataColor ?? NODATA_COLOR, label: 'masked' } }
    : { items };
}

function item(layer: Layer, context: LegendContext): LegendItem {
  const title = context.channelName(layer.channel);
  const mode = colorMode(layer.color);

  if (mode === 'tint' && 'tint' in layer.color) {
    return {
      layer: layer.id,
      form: 'swatch',
      title,
      clim: layer.clim,
      unit: context.unit,
      tint: layer.color.tint,
    };
  }
  if (mode === 'palette' && 'palette' in layer.color) {
    return {
      layer: layer.id,
      form: 'keyed',
      title,
      keys: context.keys?.(layer.color.palette) ?? [],
    };
  }
  return {
    layer: layer.id,
    form: 'colorbar',
    title,
    clim: layer.clim,
    unit: context.unit,
    colormap: 'colormap' in layer.color ? layer.color.colormap : undefined,
  };
}
