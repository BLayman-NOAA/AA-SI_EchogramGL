/**
 * A view's configuration as a plain object.
 *
 * What a second window is handed, what a saved workspace holds, and what a
 * host application stores when it closes a panel. Plain JSON: no class, no
 * function, no typed array, so it survives structuredClone, a BroadcastChannel
 * and localStorage without a custom serializer.
 *
 * Deliberately not everything the view knows. The store URL, the layers, the
 * units and the window are configuration. The level being drawn, what is
 * resident and how many tiles are in flight are answers, and a second window
 * given those would be told what to conclude rather than what to look at.
 *
 * The version field is not decoration. Layer fields have already changed once
 * this project (a ratio transform came and went) and a configuration written by
 * an older build has to either upgrade or be refused, never be half applied.
 */

import type { LayerSpec } from './layers';
import type { AspectMode } from './viewport';

/** Bumped when a field changes meaning, not when one is added. */
export const SETTINGS_VERSION = 1;

export interface ViewSettings {
  version: number;
  /** Where the store is, so a second window opens the same data. */
  store?: string;
  layers: LayerSpec[];
  level: number | 'auto';
  pixelsPerPing: number;
  colormap: string;
  filter: 'nearest' | 'linear';
  xUnit: string;
  yUnit: string;
  aspect: { mode: AspectMode; exaggeration: number };
  /** The viewport, in the units named above. */
  window?: { x: [number, number]; y: [number, number] };
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** Round trip a settings object, so a caller never shares mutable state. */
export function copySettings(settings: ViewSettings): ViewSettings {
  return {
    ...settings,
    layers: settings.layers.map((layer) => ({
      ...layer,
      clim: layer.clim ? ([...layer.clim] as [number, number]) : undefined,
      color: layer.color ? copyColor(layer.color) : undefined,
    })),
    aspect: { ...settings.aspect },
    window: settings.window
      ? { x: [...settings.window.x], y: [...settings.window.y] }
      : undefined,
  };
}

export function serializeSettings(settings: ViewSettings): string {
  return JSON.stringify({ ...settings, version: SETTINGS_VERSION });
}

/**
 * Read a settings object back, or say why it cannot be.
 *
 * Rejects rather than repairs. A configuration missing its layers is not a
 * configuration with no layers: it is a different shape, and applying the half
 * that parsed would leave a view whose controls disagree with its picture.
 */
export function parseSettings(text: string | unknown): ViewSettings {
  let raw: unknown;
  if (typeof text === 'string') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SettingsError('settings are not JSON');
    }
  } else {
    raw = text;
  }

  if (!raw || typeof raw !== 'object') throw new SettingsError('settings are not an object');
  const found = raw as Partial<ViewSettings>;

  if (typeof found.version !== 'number') {
    throw new SettingsError('settings carry no version, so they cannot be read safely');
  }
  if (found.version > SETTINGS_VERSION) {
    throw new SettingsError(
      `settings are version ${found.version} and this build reads ${SETTINGS_VERSION}. ` +
        'They were written by a newer viewer.',
    );
  }
  if (!Array.isArray(found.layers)) {
    throw new SettingsError('settings carry no layer stack');
  }

  return upgrade({
    version: found.version,
    store: typeof found.store === 'string' ? found.store : undefined,
    layers: found.layers as LayerSpec[],
    level: found.level === 'auto' || typeof found.level === 'number' ? found.level : 'auto',
    pixelsPerPing: number(found.pixelsPerPing, 2),
    colormap: typeof found.colormap === 'string' ? found.colormap : 'viridis',
    filter: found.filter === 'linear' ? 'linear' : 'nearest',
    xUnit: typeof found.xUnit === 'string' ? found.xUnit : 'pings',
    yUnit: typeof found.yUnit === 'string' ? found.yUnit : 'range',
    aspect: {
      mode: (found.aspect?.mode ?? 'fit') as AspectMode,
      exaggeration: number(found.aspect?.exaggeration, 1),
    },
    window: extent(found.window),
  });
}

/**
 * Bring an older settings object up to date.
 *
 * Nothing to do yet, and the shape of it matters more than the content: a
 * version older than the current one is upgraded here or it is refused above.
 * There is no third path where it is applied as it stands.
 */
function upgrade(settings: ViewSettings): ViewSettings {
  return { ...settings, version: SETTINGS_VERSION };
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function extent(value: unknown): ViewSettings['window'] {
  if (!value || typeof value !== 'object') return undefined;
  const found = value as { x?: unknown; y?: unknown };
  const x = pair(found.x);
  const y = pair(found.y);
  return x && y ? { x, y } : undefined;
}

function pair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [low, high] = value;
  if (typeof low !== 'number' || typeof high !== 'number') return undefined;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return undefined;
  return [low, high];
}

function copyColor(color: NonNullable<LayerSpec['color']>): NonNullable<LayerSpec['color']> {
  if ('tint' in color) return { tint: [...color.tint] as [number, number, number] };
  return { ...color };
}
