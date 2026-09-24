import { describe, expect, it } from 'vitest';

import { BundleCache } from '../src/render/bundles';

function fakeDevice() {
  const calls: string[][] = [];
  const device = {
    createRenderBundleEncoder() {
      const recorded: string[] = [];
      calls.push(recorded);
      return {
        setPipeline: () => recorded.push('pipeline'),
        setBindGroup: (index: number) => recorded.push(`group ${index}`),
        draw: (vertices: number, instances: number) =>
          recorded.push(`draw ${vertices} ${instances}`),
        finish: () => ({ recorded }) as unknown as GPURenderBundle,
      } as unknown as GPURenderBundleEncoder;
    },
  };
  return { device, calls };
}

function cache() {
  const { device, calls } = fakeDevice();
  return { calls, cache: new BundleCache(device, { colorFormats: ['bgra8unorm'] }) };
}

describe('BundleCache', () => {
  it('records once and replays for the same tile set', () => {
    // A pan writes a matrix into a bound buffer. The recorded calls still point
    // at the same buffer, so nothing about them has changed.
    const { cache: bundles } = cache();
    const record = (encoder: GPURenderBundleEncoder) => encoder.draw(4, 100);

    const first = bundles.bundle('0:0#1', record);
    const second = bundles.bundle('0:0#1', record);
    expect(second).toBe(first);
    expect(bundles.recordings).toBe(1);
  });

  it('re-records when the tile set changes', () => {
    const { cache: bundles } = cache();
    const record = () => {};
    bundles.bundle('0:0#1', record);
    bundles.bundle('0:0#1,0:1#2', record);
    expect(bundles.recordings).toBe(2);
  });

  it('re-records when a tile is refilled in place', () => {
    // Same tile, new bind group. The set is the same size and the same names,
    // which is why the key carries the stamp as well as the key.
    const { cache: bundles } = cache();
    const record = () => {};
    bundles.bundle('0:0#1', record);
    bundles.bundle('0:0#2', record);
    expect(bundles.recordings).toBe(2);
  });

  it('records what it was told to, in order', () => {
    const { cache: bundles, calls } = cache();
    bundles.bundle('two tiles', (encoder) => {
      encoder.setPipeline({} as GPURenderPipeline);
      encoder.setBindGroup(0, {} as GPUBindGroup);
      encoder.setBindGroup(1, {} as GPUBindGroup);
      encoder.draw(4, 2048);
    });
    expect(calls[0]).toEqual(['pipeline', 'group 0', 'group 1', 'draw 4 2048']);
  });

  it('records again after being invalidated', () => {
    const { cache: bundles } = cache();
    const record = () => {};
    bundles.bundle('same', record);
    bundles.invalidate();
    bundles.bundle('same', record);
    expect(bundles.recordings).toBe(2);
  });
});
