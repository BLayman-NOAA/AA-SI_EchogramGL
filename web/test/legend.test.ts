import { describe, expect, it } from 'vitest';

import { type LayerSpec, resolveLayers } from '../src/app/layers';
import { NODATA_COLOR } from '../src/render/colormaps';
import { legendFor } from '../src/shell/legend/model';

const DEFAULTS = {
  color: { colormap: 'viridis' } as const,
  clim: [-80, -20] as [number, number],
  opacity: 1,
  filter: 'nearest' as GPUFilterMode,
};

const CONTEXT = {
  channelName: (channel: number) => `${18 + channel * 20} kHz`,
  unit: 'dB',
  keys: () => [
    { label: -1, color: [0, 0, 0] as [number, number, number] },
    { label: 0, color: [1, 0, 0] as [number, number, number], share: 0.124 },
  ],
};

function legend(...specs: LayerSpec[]) {
  return legendFor(resolveLayers(specs, DEFAULTS), CONTEXT);
}

describe('legend form follows the colour mode', () => {
  it('gives a colormap layer a colorbar with its limits', () => {
    const { items } = legend({ channel: 0, color: { colormap: 'jet' } });
    expect(items[0]).toMatchObject({
      form: 'colorbar',
      title: '18 kHz',
      colormap: 'jet',
      clim: [-80, -20],
      unit: 'dB',
    });
  });

  it('gives a tinted layer a swatch, not a gradient', () => {
    // In additive mode the hue says which channel, not what value, and a
    // gradient would claim the opposite.
    const { items } = legend({ channel: 1, color: { tint: [1, 0, 0] } });
    expect(items[0]).toMatchObject({ form: 'swatch', tint: [1, 0, 0] });
    expect(items[0].colormap).toBeUndefined();
  });

  it('gives a categorical layer a keyed list', () => {
    const { items } = legend({ channel: 0, color: { palette: 'cluster' } });
    expect(items[0].form).toBe('keyed');
    expect(items[0].keys?.map((key) => key.label)).toEqual([-1, 0]);
    expect(items[0].clim).toBeUndefined();
  });
});

describe('legend and the stack', () => {
  it('drops a hidden layer, which is what makes toggling legible', () => {
    const { items } = legend(
      { id: 'a', channel: 0 },
      { id: 'b', channel: 1, visible: false },
      { id: 'c', channel: 2 },
    );
    expect(items.map((item) => item.layer)).toEqual(['a', 'c']);
  });

  it('shows the nodata swatch once for the stack', () => {
    const { nodata } = legend({ channel: 0 }, { channel: 1 }, { channel: 2 });
    expect(nodata).toEqual({ color: NODATA_COLOR, label: 'masked' });
  });

  it('drops the nodata swatch when nothing visible paints it', () => {
    // Nothing on screen is that color, so a key for it would be a claim about
    // a picture that does not contain one.
    const { nodata } = legend(
      { channel: 0, visible: false },
      { channel: 1, nodata: 'transparent' },
    );
    expect(nodata).toBeUndefined();
  });

  it('keeps legend order the same as draw order', () => {
    const { items } = legend({ id: 'low', channel: 0 }, { id: 'high', channel: 1 });
    expect(items.map((item) => item.layer)).toEqual(['low', 'high']);
  });
});
