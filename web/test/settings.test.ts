import { describe, expect, it } from 'vitest';

import type { LayerSpec } from '../src/app/layers';
import {
  SETTINGS_VERSION,
  type ViewSettings,
  SettingsError,
  copySettings,
  parseSettings,
  serializeSettings,
} from '../src/app/settings';

const layers: LayerSpec[] = [
  { id: 'layer-0', channel: 4, color: { colormap: 'viridis' }, clim: [-80, -20] },
  {
    id: 'layer-1',
    channel: 2,
    against: 4,
    color: { tint: [1, 0, 0] },
    clim: [-12, 12],
    blend: 'add',
    opacity: 0.6,
    visible: false,
  },
];

const settings: ViewSettings = {
  version: SETTINGS_VERSION,
  store: 'http://127.0.0.1:8128/store/',
  layers,
  level: 'auto',
  pixelsPerPing: 2,
  colormap: 'viridis',
  filter: 'nearest',
  xUnit: 'time',
  yUnit: 'depth',
  aspect: { mode: 'locked', exaggeration: 12.5 },
  window: { x: [10, 20], y: [0, 70] },
};

describe('settings round trip', () => {
  it('comes back the same', () => {
    expect(parseSettings(serializeSettings(settings))).toEqual(settings);
  });

  it('keeps layer order, which is draw order', () => {
    const found = parseSettings(serializeSettings(settings));
    expect(found.layers.map((layer) => layer.id)).toEqual(['layer-0', 'layer-1']);
  });

  it('keeps every field of a layer, including the ones a difference needs', () => {
    const found = parseSettings(serializeSettings(settings)).layers[1];
    expect(found.against).toBe(4);
    expect(found.clim).toEqual([-12, 12]);
    expect(found.blend).toBe('add');
    expect(found.opacity).toBe(0.6);
    expect(found.visible).toBe(false);
    expect(found.color).toEqual({ tint: [1, 0, 0] });
  });

  it('survives structuredClone, which is what a channel does to it', () => {
    // Plain JSON is the requirement here. A typed array or a class instance
    // would cross the channel as something else, or not at all.
    expect(structuredClone(settings)).toEqual(settings);
  });

  it('copies deeply enough that a caller cannot reach back in', () => {
    const copy = copySettings(settings);
    copy.layers[0].clim![0] = -1;
    (copy.window!.x as number[])[0] = -1;
    copy.aspect.exaggeration = 1;

    expect(settings.layers[0].clim![0]).toBe(-80);
    expect(settings.window!.x[0]).toBe(10);
    expect(settings.aspect.exaggeration).toBe(12.5);
  });
});

describe('refusing what cannot be applied', () => {
  it('will not read settings with no version', () => {
    const { version, ...rest } = settings;
    expect(() => parseSettings(JSON.stringify(rest))).toThrow(SettingsError);
    expect(() => parseSettings(JSON.stringify(rest))).toThrow(/version/);
  });

  it('will not read settings from a newer viewer', () => {
    // Half applying these is the failure worth avoiding: the picture would
    // disagree with the controls and nothing would say why.
    const newer = { ...settings, version: SETTINGS_VERSION + 5 };
    expect(() => parseSettings(JSON.stringify(newer))).toThrow(/newer viewer/);
  });

  it('will not read settings with no layer stack', () => {
    const { layers: _, ...rest } = settings;
    expect(() => parseSettings(JSON.stringify(rest))).toThrow(/layer stack/);
  });

  it('says so when the text is not JSON at all', () => {
    expect(() => parseSettings('{ not json')).toThrow(/not JSON/);
  });

  it('upgrades an older version rather than applying it as it stands', () => {
    const older = { ...settings, version: 0 };
    expect(parseSettings(JSON.stringify(older)).version).toBe(SETTINGS_VERSION);
  });

  it('accepts an object as well as its text', () => {
    expect(parseSettings(structuredClone(settings)).xUnit).toBe('time');
  });
});

describe('filling in what is missing', () => {
  it('falls back rather than failing on a field it can default', () => {
    const sparse = { version: SETTINGS_VERSION, layers: [] };
    const found = parseSettings(JSON.stringify(sparse));
    expect(found.level).toBe('auto');
    expect(found.colormap).toBe('viridis');
    expect(found.filter).toBe('nearest');
    expect(found.window).toBeUndefined();
  });

  it('drops a window that is not two pairs of numbers', () => {
    // Better than carrying half of one through: a view told to frame NaN shows
    // nothing and reports no reason.
    const broken = { ...settings, window: { x: [1, 'two'], y: [0, 70] } };
    expect(parseSettings(JSON.stringify(broken)).window).toBeUndefined();
  });
});

describe('nodata color in settings', () => {
  it('round trips a chosen color', () => {
    const chosen = { ...settings, nodataColor: '#ff00aa' };
    expect(parseSettings(serializeSettings(chosen)).nodataColor).toBe('#ff00aa');
  });

  it('drops a color that is not #rrggbb, so the default applies', () => {
    const text = serializeSettings({ ...settings, nodataColor: 'red' });
    expect(parseSettings(text).nodataColor).toBeUndefined();
  });
});
