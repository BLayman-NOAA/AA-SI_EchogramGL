import { describe, expect, it } from 'vitest';

import type { Probe, ProbeLayer, SourceInfo } from '../src/app/EchogramView';
import { halfToNumber } from '../src/data/values';
import { defaultLayerFor } from '../src/panel/defaults';
import { duration, formatProbe, utc } from '../src/panel/readout';
import { readSections, writeSections } from '../src/panel/sections';

function layer(overrides: Partial<ProbeLayer> = {}): ProbeLayer {
  return {
    layer: 'a',
    source: 'main',
    label: '38 kHz',
    value: -67.34,
    categorical: false,
    difference: false,
    cell: { level: 3, factor: 8, x: [100, 180], y: [410, 412] },
    ...overrides,
  };
}

function probe(overrides: Partial<Probe> = {}): Probe {
  return {
    x: 100,
    y: 411.04,
    xUnit: 'datetime',
    yUnit: 'meters',
    timeNs: Date.parse('2016-07-25T21:03:40.400Z') * 1e6,
    verticalRef: 'depth',
    layers: [layer()],
    ...overrides,
  };
}

describe('the hover readout', () => {
  it('says when, how deep, the value and the size of the cell', () => {
    const found = formatProbe(probe());
    expect(found.position).toEqual(['2016-07-25 21:03:40 UTC', 'depth 411.0 m']);
    expect(found.values).toEqual(['38 kHz  -67.3 dB']);
    expect(found.cell).toBe('cell 80 s x 2.00 m  (level 3, 8 pings)');
  });

  it('signs a difference and names a cluster', () => {
    const found = formatProbe(
      probe({
        layers: [
          layer({ label: '200 kHz − 38 kHz', value: 4.26, difference: true }),
          layer({ label: 'labels', value: 3, categorical: true }),
          layer({ label: 'labels', value: -1, categorical: true }),
        ],
      }),
    );
    expect(found.values).toEqual([
      '200 kHz − 38 kHz  +4.3 dB',
      'labels  cluster 3',
      'labels  noise',
    ]);
  });

  it('tells no data from a tile still on its way', () => {
    const found = formatProbe(
      probe({
        layers: [
          layer({ value: null }),
          layer({ value: undefined }),
          layer({ value: undefined, cell: undefined }),
        ],
      }),
    );
    expect(found.values).toEqual(['38 kHz  no data', '38 kHz  loading', '38 kHz  nothing drawn']);
  });

  it('names a range axis and ping units', () => {
    const found = formatProbe(
      probe({
        xUnit: 'pings',
        x: 1234.4,
        verticalRef: 'range',
        layers: [layer({ cell: { level: 0, factor: 1, x: [1233.5, 1234.5], y: [1, 1.19] } })],
      }),
    );
    expect(found.position).toEqual(['ping 1234', 'range 411.0 m']);
    expect(found.cell).toBe('cell 1 ping x 0.19 m  (level 0, 1 ping)');
  });

  it('puts durations in the unit that reads best', () => {
    expect(duration(4)).toBe('4 s');
    expect(duration(80)).toBe('80 s');
    expect(duration(1200)).toBe('20.0 min');
    expect(duration(4 * 3600)).toBe('4.0 h');
    expect(utc(0)).toBe('1970-01-01 00:00:00 UTC');
  });
});

describe('float16 bits', () => {
  it('decode to what Float16Array holds', () => {
    const values = [0, -0.5, -67.3125, -9999, 65504, 1e-7, Infinity];
    const half = Float16Array.from(values);
    const bits = new Uint16Array(half.buffer);
    for (let i = 0; i < values.length; i += 1) {
      expect(halfToNumber(bits[i])).toBe(half[i]);
    }
    expect(halfToNumber(0x7e00)).toBeNaN();
  });
});

describe('section state', () => {
  function store(initial: Record<string, string> = {}) {
    const held = { ...initial };
    return {
      held,
      getItem: (key: string) => held[key] ?? null,
      setItem: (key: string, value: string) => {
        held[key] = value;
      },
    };
  }

  it('round trips', () => {
    const memory = store();
    writeSections(memory, 'k', { layers: true, view: false });
    expect(readSections(memory, 'k')).toEqual({ layers: true, view: false });
  });

  it('reads nothing from nothing, or from something unreadable', () => {
    expect(readSections(store(), 'k')).toEqual({});
    expect(readSections(store({ k: '{"layers": ' }), 'k')).toEqual({});
    expect(readSections(store({ k: '[true]' }), 'k')).toEqual({});
    expect(readSections(undefined, 'k')).toEqual({});
  });

  it('keeps only open or closed', () => {
    const memory = store({ k: '{"layers": true, "view": "yes"}' });
    expect(readSections(memory, 'k')).toEqual({ layers: true });
  });
});

describe('a new source', () => {
  const source = (dataType: string): SourceInfo => ({
    id: 'step',
    kind: 'pieces',
    levels: 1,
    level: 0,
    channels: 1,
    valueName: 'Sv',
    dataType,
    verticalRef: 'depth',
  });

  it('opens labels on the cluster palette', () => {
    expect(defaultLayerFor(source('Cluster-MVBS'), 'viridis').color).toEqual({
      palette: 'cluster',
    });
  });

  it('opens anything else on the colormap given', () => {
    const found = defaultLayerFor(source('MVBS'), 'inferno');
    expect(found).toEqual({
      id: 'step-layer',
      source: 'step',
      channel: 0,
      color: { colormap: 'inferno' },
    });
  });
});
