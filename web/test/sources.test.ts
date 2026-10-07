import { describe, expect, it } from 'vitest';

import { resolveLayers } from '../src/app/layers';
import {
  SETTINGS_VERSION,
  type ViewSettings,
  copySettings,
  parseSettings,
  serializeSettings,
} from '../src/app/settings';
import {
  type AxisContext,
  sharedXUnits,
  sharedYUnits,
  validXUnits,
  validYUnits,
} from '../src/geometry/axes';
import { buildXAxis } from '../src/geometry/coords';

const mvbs: AxisContext = { dataType: 'MVBS', verticalRef: 'depth', hasGps: true };
const sv: AxisContext = { dataType: 'Sv', verticalRef: 'depth', hasGps: false };

describe('units across sources', () => {
  it('offers what one source offers when it is alone', () => {
    expect(sharedXUnits([mvbs])).toEqual(validXUnits(mvbs));
    expect(sharedYUnits([mvbs])).toEqual(validYUnits(mvbs));
  });

  it('narrows to time against metres with two', () => {
    expect(sharedXUnits([mvbs, sv])).toEqual(['datetime', 'seconds']);
    expect(sharedYUnits([mvbs, sv])).toEqual(['meters']);
  });

  it('does not offer distance with two, even where both have positions', () => {
    expect(sharedXUnits([mvbs, mvbs])).not.toContain('meters');
    expect(sharedXUnits([mvbs, mvbs])).not.toContain('pings');
  });
});

describe('one time origin', () => {
  const second = 1e9;
  const epoch = 1_469_000_000 * second;

  it('puts the same instant at the same x in two datasets', () => {
    const early = { pingTime: Float64Array.from([0, 10, 20, 30], (t) => epoch + t * second) };
    const late = { pingTime: Float64Array.from([20, 25, 30], (t) => epoch + t * second) };
    const a = buildXAxis('seconds', { ...early, epoch });
    const b = buildXAxis('seconds', { ...late, epoch });
    expect(a.centre[2]).toBe(20);
    expect(b.centre[0]).toBe(20);
    expect(a.centre[3]).toBe(b.centre[2]);
  });

  it('counts from the first ping when no origin is given', () => {
    const late = { pingTime: Float64Array.from([20, 25], (t) => epoch + t * second) };
    expect(buildXAxis('seconds', late).centre[0]).toBe(0);
  });
});

describe('layers name their source', () => {
  const defaults = {
    color: { colormap: 'viridis' },
    clim: [-80, -20] as [number, number],
    opacity: 1,
    filter: 'nearest' as GPUFilterMode,
  };

  it('keeps the source a spec names, and leaves it open otherwise', () => {
    const layers = resolveLayers(
      [{ channel: 0 }, { channel: 1, source: 'labels' }],
      defaults,
    );
    expect(layers[0].source).toBeUndefined();
    expect(layers[1].source).toBe('labels');
  });
});

describe('settings with sources', () => {
  const settings: ViewSettings = {
    version: SETTINGS_VERSION,
    store: 'http://127.0.0.1:8128/store/',
    sources: [
      { id: 'main', store: 'http://127.0.0.1:8128/store/' },
      { id: 'mvbs', store: 'http://127.0.0.1:8128/mount/abc/' },
    ],
    layers: [
      { id: 'layer-0', channel: 0 },
      { id: 'layer-1', source: 'mvbs', channel: 1 },
    ],
    level: 'auto',
    pixelsPerPing: 2,
    colormap: 'viridis',
    filter: 'nearest',
    xUnit: 'datetime',
    yUnit: 'meters',
    aspect: { mode: 'free', exaggeration: 1 },
  };

  it('round trip', () => {
    const back = parseSettings(serializeSettings(settings));
    expect(back.sources).toEqual(settings.sources);
    expect(back.layers[1].source).toBe('mvbs');
  });

  it('copy without sharing the source list', () => {
    const copy = copySettings(settings);
    expect(copy.sources).toEqual(settings.sources);
    expect(copy.sources).not.toBe(settings.sources);
  });

  it('read settings written before sources existed', () => {
    const { sources: _, ...older } = settings;
    const back = parseSettings(JSON.stringify(older));
    expect(back.sources).toBeUndefined();
    expect(back.store).toBe(settings.store);
  });

  it('drop source entries that are not whole', () => {
    const back = parseSettings(
      JSON.stringify({ ...settings, sources: [{ id: 'a' }, { id: 'b', store: 'x' }] }),
    );
    expect(back.sources).toEqual([{ id: 'b', store: 'x' }]);
  });
});
