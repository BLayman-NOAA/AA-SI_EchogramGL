import { describe, expect, it } from 'vitest';

import {
  type Layer,
  type LayerSpec,
  channelsOf,
  channelsUsed,
  colorMode,
  drawn,
  filterFor,
  isCategorical,
  pipelineConstants,
  pipelineKey,
  reorder,
  resolveLayers,
} from '../src/app/layers';

const DEFAULTS = {
  color: { colormap: 'viridis' } as const,
  clim: [-80, -20] as [number, number],
  opacity: 1,
  filter: 'nearest' as GPUFilterMode,
};

function stack(...specs: LayerSpec[]): Layer[] {
  return resolveLayers(specs, DEFAULTS);
}

describe('layer defaults', () => {
  it('paints nodata on the bottom layer and lets it through above', () => {
    // Painting is what makes a mask conspicuous rather than silent, so the
    // layer with nothing under it is the one that does it.
    const layers = stack({ channel: 0 }, { channel: 1 }, { channel: 2 });
    expect(layers.map((layer) => layer.nodata)).toEqual([
      'paint',
      'transparent',
      'transparent',
    ]);
  });

  it('takes an explicit nodata setting over the positional default', () => {
    const layers = stack({ channel: 0, nodata: 'transparent' }, { channel: 1, nodata: 'paint' });
    expect(layers.map((layer) => layer.nodata)).toEqual(['transparent', 'paint']);
  });

  it('defaults by position and not by visibility', () => {
    // Otherwise hiding the bottom layer would change the layer above it from
    // transparent to paint, which is a pipeline change on a toggle.
    const layers = stack({ channel: 0, visible: false }, { channel: 1 });
    expect(layers[1].nodata).toBe('transparent');
  });

  it('fills colour, limits and opacity from the view defaults', () => {
    const [layer] = stack({ channel: 3 });
    expect(layer).toMatchObject({
      channel: 3,
      color: { colormap: 'viridis' },
      clim: [-80, -20],
      opacity: 1,
      visible: true,
      blend: 'over',
      filter: 'nearest',
    });
  });
});

describe('colour modes', () => {
  it('names the three modes', () => {
    expect(colorMode({ colormap: 'jet' })).toBe('colormap');
    expect(colorMode({ tint: [1, 0, 0] })).toBe('tint');
    expect(colorMode({ palette: 'cluster' })).toBe('palette');
  });

  it('treats only a palette as categorical', () => {
    const [cmap, tint, palette] = stack(
      { channel: 0, color: { colormap: 'jet' } },
      { channel: 1, color: { tint: [1, 0, 0] } },
      { channel: 2, color: { palette: 'cluster' } },
    );
    expect([cmap, tint].map(isCategorical)).toEqual([false, false]);
    expect(isCategorical(palette)).toBe(true);
  });

  it('forces nearest filtering on a palette layer', () => {
    // Linear filtering on labels invents a label between two clusters, and
    // that label indexes a palette entry belonging to a third.
    const [palette, continuous] = stack(
      { channel: 0, color: { palette: 'cluster' }, filter: 'linear' },
      { channel: 1, color: { colormap: 'jet' }, filter: 'linear' },
    );
    expect(filterFor(palette)).toBe('nearest');
    expect(filterFor(continuous)).toBe('linear');
  });
});

describe('pipeline resolution', () => {
  it('keys on the blend mode, the nodata mode and the shader branch', () => {
    const [layer] = stack({ channel: 0, blend: 'add', nodata: 'transparent' });
    expect(pipelineKey(layer, 'bgra8unorm')).toBe(
      'value:bgra8unorm:value:value:transparent:add',
    );
  });

  it('gives a palette layer its own pipeline', () => {
    const [continuous, categorical] = stack(
      { channel: 0, color: { tint: [1, 0, 0] } },
      { channel: 1, color: { palette: 'cluster' }, nodata: 'paint' },
    );
    expect(pipelineKey(continuous, 'rgba8unorm')).not.toBe(
      pipelineKey(categorical, 'rgba8unorm'),
    );
  });

  it('keeps the limits, opacity, channel and visibility out of the key', () => {
    // NFR-5: these reach the next frame without a compilation, so none of them
    // may name a pipeline.
    const [a, b] = stack(
      { channel: 0, clim: [-80, -20], opacity: 1, visible: true },
      { channel: 4, clim: [-60, -10], opacity: 0.3, visible: false },
    );
    const same = { ...b, nodata: a.nodata };
    expect(pipelineKey(same, 'bgra8unorm')).toBe(pipelineKey(a, 'bgra8unorm'));
  });

  it('turns the two branches into override constants', () => {
    const [layer] = stack({
      channel: 0,
      color: { palette: 'cluster' },
      nodata: 'transparent',
    });
    expect(pipelineConstants(layer)).toEqual({
      NODATA_TRANSPARENT: 1,
      CATEGORICAL: 1,
      TRANSFORM: 0,
    });
  });
});

describe('difference layers', () => {
  it('is a value layer until a second channel is named', () => {
    const [plain] = stack({ channel: 0 });
    expect(plain.transform).toBe('value');
    expect(plain.against).toBeUndefined();
  });

  it('defaults to a difference once one is', () => {
    const [layer] = stack({ channel: 2, against: 4 });
    expect(layer.transform).toBe('difference');
  });

  it('opens on limits symmetric about zero, not on the Sv limits', () => {
    // A difference lives near zero and is signed. The Sv default of -80 to -20
    // would put every pixel at one end of the colormap.
    const [layer] = stack({ channel: 2, against: 4 });
    expect(layer.clim).toEqual([-12, 12]);
    expect(stack({ channel: 2 })[0].clim).toEqual([-80, -20]);
  });

  it('counts both channels as in use', () => {
    // Both have to be fetched, and both have to be resident before the slot
    // can draw, so a difference layer is two tiles and not one.
    const layers = stack({ channel: 2, against: 4 });
    expect(channelsUsed(layers)).toEqual([2, 4]);
    expect(channelsOf(layers[0])).toEqual([2, 4]);
  });

  it('gives a difference its own pipeline', () => {
    const [value, difference] = stack({ channel: 0 }, { channel: 2, against: 4 });
    expect(pipelineKey({ ...difference, nodata: 'paint' }, 'bgra8unorm')).not.toBe(
      pipelineKey(value, 'bgra8unorm'),
    );
  });

  it('names the transform in the override constants', () => {
    expect(pipelineConstants(stack({ channel: 2, against: 4 })[0]).TRANSFORM).toBe(1);
    expect(pipelineConstants(stack({ channel: 2 })[0]).TRANSFORM).toBe(0);
  });

  it('has no ratio, because subtracting decibels is dividing', () => {
    // 200 minus 38 dB is ten log ten of the linear ratio. A second linear
    // divide would answer the same question in a unit no decibel colorbar can
    // label.
    const [layer] = stack({ channel: 2, against: 4 });
    expect(layer.transform).toBe('difference');
  });
});

describe('the stack', () => {
  it('draws the visible layers in order', () => {
    const layers = stack(
      { id: 'a', channel: 0 },
      { id: 'b', channel: 1, visible: false },
      { id: 'c', channel: 2 },
    );
    expect(drawn(layers).map((layer) => layer.id)).toEqual(['a', 'c']);
  });

  it('counts each channel once, and only where it is drawn', () => {
    // Two layers of one frequency share its tiles, which is what makes a
    // second view of the same channel cost no fetch.
    const layers = stack(
      { channel: 2 },
      { channel: 2, color: { colormap: 'jet' } },
      { channel: 0 },
      { channel: 4, visible: false },
    );
    expect(channelsUsed(layers)).toEqual([0, 2]);
  });

  it('moves a layer within the stack', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('leaves the stack alone when a move goes nowhere', () => {
    const layers = ['a', 'b', 'c'];
    expect(reorder(layers, 1, 1)).toBe(layers);
    expect(reorder(layers, 5, 0)).toBe(layers);
  });
});
