import { describe, expect, it } from 'vitest';

import {
  DecodePool,
  type DecodeRequest,
  type DecodeResult,
  type WorkerLike,
} from '../src/data/decode';
import { type Header, decodeArray, multiscalesOf } from '../src/data/pieces';
import { toFloat16Bits } from '../src/data/values';
import { validXUnits, validYUnits } from '../src/geometry/axes';
import {
  type PieceBudget,
  type PieceExtent,
  choosePieces,
  openingExtent,
} from '../src/geometry/pieces';

/** Ten pieces, each ten seconds wide, back to back from zero. */
function row(texture = 10, transfer = 10): PieceExtent[] {
  return Array.from({ length: 10 }, (_, i) => ({
    x: [i * 10, i * 10 + 9] as [number, number],
    texture,
    transfer,
  }));
}

const plenty: PieceBudget = { texture: 1e9, transfer: 1e9, count: 1000 };

describe('choosing pieces', () => {
  it('takes the pieces in view nearest the centre first', () => {
    const { chosen } = choosePieces(row(), [30, 69], plenty, 0);
    expect(chosen.slice(0, 2).sort()).toEqual([4, 5]);
    expect(chosen.sort()).toEqual([3, 4, 5, 6]);
  });

  it('reaches past the edges once the view is covered', () => {
    const { chosen } = choosePieces(row(), [40, 59], plenty, 1);
    expect(chosen.slice(0, 2).sort()).toEqual([4, 5]);
    expect(new Set(chosen)).toEqual(new Set([2, 3, 4, 5, 6, 7]));
  });

  it('counts what is in view and does not fit', () => {
    const budget = { ...plenty, texture: 25 };
    const { chosen, deferred } = choosePieces(row(), [0, 99], budget, 0);
    expect(chosen).toHaveLength(2);
    expect(deferred).toBe(8);
    expect(chosen.sort()).toEqual([4, 5]);
  });

  it('always takes one piece in view, however large', () => {
    const { chosen } = choosePieces(row(1000), [40, 49], { ...plenty, texture: 10 }, 0);
    expect(chosen).toEqual([4]);
  });

  it('stops at the transfer budget as well as the texture one', () => {
    const budget = { ...plenty, transfer: 30 };
    expect(choosePieces(row(), [0, 99], budget, 0).chosen).toHaveLength(3);
  });

  it('stops at the count', () => {
    const budget = { ...plenty, count: 4 };
    expect(choosePieces(row(), [0, 99], budget, 0).chosen).toHaveLength(4);
  });
});

describe('opening on pieces', () => {
  it('opens on the middle, as wide as the budget allows', () => {
    const extent = openingExtent(row(), { ...plenty, texture: 40 });
    expect(extent).toEqual([30, 69]);
  });

  it('opens on the whole when it fits', () => {
    expect(openingExtent(row(), plenty)).toEqual([0, 99]);
  });

  it('opens on one piece when not even that fits', () => {
    const extent = openingExtent(row(1000), { ...plenty, texture: 10 });
    expect(extent[1] - extent[0]).toBe(9);
  });
});

describe('a described dataset', () => {
  const encode = (values: number[]) => {
    const bytes = new Uint8Array(Float64Array.from(values).buffer);
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return { shape: [values.length], data: btoa(text) };
  };

  it('decodes its sidecars exactly', () => {
    const values = [1.469e18, -2.5, 0.191];
    expect([...decodeArray(encode(values))]).toEqual(values);
  });

  it('stands in for a one level store with no channel axis', () => {
    const header: Header = {
      var: 'labels',
      kind: 'labels',
      dims: ['ping_time', 'depth'],
      order: { channel: null, ping: 0, sample: 1 },
      shape: [12, 20],
      chunks: [12, 20],
      dtype: 'int16',
      channels: 1,
      pings: 12,
      samples: 20,
      dataType: 'Cluster-MVBS',
      verticalRef: 'depth',
      rangeVar: 'depth',
      gridded: true,
      hasGps: false,
      nodata: -9999,
      nodataThreshold: -5000,
      sidecars: {},
    };
    const multiscales = multiscalesOf(header);
    expect(multiscales.channelDim).toBeNull();
    expect(multiscales.datasets).toHaveLength(1);
    expect(multiscales.name).toBe('labels');
  });
});

describe('time only data', () => {
  it('offers time against metres', () => {
    const context = { dataType: 'MVBS', verticalRef: 'depth', hasGps: true, timeOnly: true };
    expect(validXUnits(context)).toEqual(['datetime', 'seconds']);
    expect(validYUnits(context)).toEqual(['meters']);
  });
});

describe('labels as values', () => {
  it('converts int64 labels rather than masking them', () => {
    const bits = toFloat16Bits(BigInt64Array.from([-1n, 0n, 7n]));
    expect([...new Float16Array(bits.buffer)]).toEqual([-1, 0, 7]);
  });
});

class FakeWorker implements WorkerLike {
  sent: DecodeRequest[] = [];
  onmessage: ((event: { data: DecodeResult }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: unknown) {
    this.sent.push(message as DecodeRequest);
  }
  terminate() {}
}

describe('the decode queue', () => {
  it('sends visible tiles ahead of speculative ones, each in the order asked', () => {
    const workers: FakeWorker[] = [];
    const pool = new DecodePool({
      size: 1,
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const request = (channel: number, priority: 'high' | 'low') => ({
      href: 'http://example/',
      path: '',
      valueName: 'Sv',
      channel,
      pings: [0, 1] as [number, number],
      samples: [0, 1] as [number, number],
      priority,
    });
    void pool.read(request(0, 'low'));
    void pool.read(request(1, 'low'));
    void pool.read(request(2, 'high'));
    void pool.read(request(3, 'high'));
    const worker = workers[0];
    const order = [worker.sent[0].channel];
    for (let i = 0; i < 3; i += 1) {
      const last = worker.sent[worker.sent.length - 1];
      worker.onmessage?.({ data: { id: last.id, data: new Uint16Array(1), pings: 1, samples: 1 } });
      order.push(worker.sent[worker.sent.length - 1].channel);
    }
    expect(order).toEqual([0, 2, 3, 1]);
  });
});
