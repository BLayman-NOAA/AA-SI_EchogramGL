import { describe, expect, it } from 'vitest';

import { PieceSource, WINDOW_POINTS } from '../src/app/PieceSource';
import type { SourceHost } from '../src/app/Source';
import { parseSettings, serializeSettings, SETTINGS_VERSION } from '../src/app/settings';
import type { PieceSetSpec, PieceSpec } from '../src/data/pieces';

const SECOND = 1e9;
const START = 1_469_000_000 * SECOND;

function piece(index: number, pings = 100): PieceSpec {
  const start = START + index * 600 * SECOND;
  return {
    id: `hash${index}`,
    label: `D20160725-T2${index}0000.raw`,
    start,
    end: start + 590 * SECOND,
    pings,
    channels: 2,
    samples: 20,
    bytes: 1000,
    header: `http://127.0.0.1:8000/api/describe/mount${index}`,
    store: `http://127.0.0.1:8000/mount/mount${index}/`,
  };
}

function spec(count: number, pings = 100): PieceSetSpec {
  return {
    name: 'file_mvbs',
    pieces: Array.from({ length: count }, (_, i) => piece(i, pings)),
  };
}

/** A host that records when the time origin is asked for. */
function host() {
  const asked: number[] = [];
  let epoch: number | undefined;
  const state = {
    context: { pool: { share: 1e9 } },
    viewport: undefined,
    xUnit: 'seconds',
    sourceCount: 1,
    epoch(first: number) {
      asked.push(first);
      epoch ??= first;
      return epoch;
    },
  };
  return { host: state as unknown as SourceHost, asked, set: (n: number) => (epoch = n) };
}

describe('a piece source', () => {
  it('does not place its pieces until the view settles its origin', () => {
    const { host: held, asked, set } = host();
    const source = new PieceSource('steps', spec(3), (n) => n, held);
    expect(asked).toHaveLength(0);
    expect(source.bounds()).toBeUndefined();
    // The view resets and another source sets the origin first.
    set(START - 60 * SECOND);
    source.place();
    const axis = source.windowAxis()!;
    expect(axis.centre[0]).toBe(60);
  });

  it('caps the axis a window is resolved against', () => {
    const { host: held } = host();
    const source = new PieceSource('steps', spec(50, 20_000), (n) => n, held);
    source.place();
    const axis = source.windowAxis()!;
    expect(axis.centre.length).toBeLessThanOrEqual(WINDOW_POINTS + 50);
    expect(axis.centre.length).toBeGreaterThan(WINDOW_POINTS / 2);
    // Still spans every piece, first ping to last.
    expect(axis.centre[0]).toBe(0);
    expect(axis.centre[axis.centre.length - 1]).toBe(49 * 600 + 590);
  });

  it('has no context until it has prepared', () => {
    const { host: held } = host();
    expect(new PieceSource('steps', spec(1), (n) => n, held).context).toBeUndefined();
  });

  it('says how to open it again', () => {
    const { host: held } = host();
    const given = spec(2);
    const setting = new PieceSource('steps', given, (n) => n, held).setting();
    expect(setting).toEqual({ id: 'steps', spec: given });
  });
});

describe('settings with a resolved step', () => {
  const settings = {
    version: SETTINGS_VERSION,
    sources: [
      { id: 'survey_echogram_store', store: 'http://127.0.0.1:8000/mount/abc/' },
      { id: 'file_mvbs', spec: spec(2) },
    ],
    layers: [{ id: 'a', source: 'file_mvbs', channel: 0 }],
    level: 'auto' as const,
    pixelsPerPing: 2,
    colormap: 'viridis',
    filter: 'nearest' as const,
    xUnit: 'datetime',
    yUnit: 'meters',
    aspect: { mode: 'free' as const, exaggeration: 1 },
  };

  it('carries the step so a second window can open it', () => {
    const back = parseSettings(serializeSettings(settings));
    expect(back.sources).toHaveLength(2);
    expect(back.sources![1].spec!.pieces).toHaveLength(2);
    expect(back.sources![0].store).toBe(settings.sources[0].store);
  });

  it('drops a step that is not whole', () => {
    const broken = { ...settings, sources: [{ id: 'x', spec: { server: 1 } }] };
    expect(parseSettings(JSON.stringify(broken)).sources).toBeUndefined();
  });
});
