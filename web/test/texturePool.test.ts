import { describe, expect, it } from 'vitest';

import { TexturePool } from '../src/device/texturePool';

interface Fake {
  width: number;
  height: number;
  destroyed: boolean;
  destroy(): void;
}

function fakeDevice() {
  const made: Fake[] = [];
  const device = {
    createTexture(descriptor: { size: number[] }) {
      const texture: Fake = {
        width: descriptor.size[0],
        height: descriptor.size[1],
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      made.push(texture);
      return texture as unknown as GPUTexture;
    },
  } as unknown as GPUDevice;
  return { device, made };
}

function pool(budget: number) {
  const { device, made } = fakeDevice();
  return {
    made,
    pool: new TexturePool({ device, format: 'r16float', usage: 0, budget }),
  };
}

describe('reuse', () => {
  it('hands back a released texture rather than making another', () => {
    const { pool: pages, made } = pool(1024 * 1024);
    const first = pages.acquire(64, 64);
    pages.release(first);
    const second = pages.acquire(64, 64);

    expect(second).toBe(first);
    expect(made).toHaveLength(1);
  });

  it('does not hand back a texture of the wrong shape', () => {
    const { pool: pages, made } = pool(1024 * 1024);
    pages.release(pages.acquire(64, 64));
    pages.acquire(64, 32);
    expect(made).toHaveLength(2);
  });

  it('counts a released texture as spare rather than as gone', () => {
    const { pool: pages } = pool(1024 * 1024);
    const texture = pages.acquire(100, 100);
    expect(pages.inUse).toBe(100 * 100 * 2);
    pages.release(texture);
    expect(pages.inUse).toBe(0);
    expect(pages.spare).toBe(100 * 100 * 2);
    expect(pages.allocated).toBe(100 * 100 * 2);
  });

  it('refuses a texture it did not allocate', () => {
    const { pool: pages } = pool(1024 * 1024);
    const stranger = { width: 4, height: 4 } as GPUTexture;
    expect(() => pages.release(stranger)).toThrow(/did not allocate/);
  });
});

describe('the budget', () => {
  // 64 by 64 at two bytes a texel is 8192, so four fit in 32768.
  const size = 64 * 64 * 2;

  it('frees spare textures rather than letting the driver hold them', () => {
    // Three tiles fit while they are all in use, because only free textures
    // can be given back. The first release is what brings the total down.
    const { pool: pages, made } = pool(size * 2);
    const held = [pages.acquire(64, 64), pages.acquire(64, 64), pages.acquire(64, 64)];
    for (const texture of held) pages.release(texture);

    expect(made.filter((t) => t.destroyed)).toHaveLength(1);
    expect(pages.allocated).toBe(size * 2);
  });

  it('goes over budget rather than failing to draw what is on screen', () => {
    // Only free textures can be given back, so a visible set larger than the
    // budget is drawn and the cache is what shrinks.
    const { pool: pages } = pool(size);
    pages.acquire(64, 64);
    pages.acquire(64, 64);
    expect(pages.inUse).toBe(size * 2);
  });

  it('keeps half the budget for the free list to reuse from', () => {
    const { pool: pages } = pool(size * 8);
    expect(pages.share).toBe(size * 4);
  });

  it('destroys everything it made when it is destroyed', () => {
    const { pool: pages, made } = pool(size * 8);
    pages.release(pages.acquire(64, 64));
    pages.acquire(32, 32);
    pages.destroy();
    expect(made.every((t) => t.destroyed)).toBe(true);
    expect(pages.allocated).toBe(0);
  });
});

describe('several views sharing one pool', () => {
  it('returns to where it started after each of them lets go', () => {
    // NFR-18, as far as it reaches without a device. A panel opened and closed
    // hands every texture back, so the count after N of them is the count
    // before the first. The pool is shared now, so a view that destroyed it
    // instead would take the other panels' tiles with it.
    const { pool: shared } = pool(64 * 1024 * 1024);
    const baseline = shared.inUse;

    for (let view = 0; view < 8; view += 1) {
      const held = [];
      for (let tile = 0; tile < 12; tile += 1) held.push(shared.acquire(512, 2048));
      expect(shared.inUse).toBeGreaterThan(baseline);
      for (const texture of held) shared.release(texture);
    }

    expect(shared.inUse).toBe(baseline);
  });

  it('gives a closed panel textures to the next one that opens', () => {
    // What sharing the pool is worth. Splitting a window used to mean a second
    // pool and a second allocation of the same shapes.
    const { pool: shared, made } = pool(64 * 1024 * 1024);
    const first = [];
    for (let tile = 0; tile < 6; tile += 1) first.push(shared.acquire(512, 2048));
    for (const texture of first) shared.release(texture);
    const allocated = made.length;

    for (let tile = 0; tile < 6; tile += 1) shared.acquire(512, 2048);
    expect(made.length).toBe(allocated);
  });
});
