import { describe, expect, it } from 'vitest';

import { ArrayCache } from '../src/data/cache';

/** Tiles are all one size here, so the arithmetic in a test is readable. */
const TILE = 100;

function fill(cache: ArrayCache<string>, level: number, keys: string[]) {
  for (const key of keys) cache.set(level, key, key, TILE);
}

describe('array cache', () => {
  it('hands back what it was given', () => {
    const cache = new ArrayCache<string>({ budget: 1000 });
    cache.set(0, 'a', 'first', TILE);
    expect(cache.get(0, 'a')).toBe('first');
    expect(cache.get(0, 'b')).toBeUndefined();
    expect(cache.size).toBe(TILE);
  });

  it('keys by level as well as tile', () => {
    // The same row and column at two levels is two different pieces of water.
    const cache = new ArrayCache<string>({ budget: 1000 });
    cache.set(0, '0:0', 'fine', TILE);
    cache.set(1, '0:0', 'coarse', TILE);
    expect(cache.get(0, '0:0')).toBe('fine');
    expect(cache.get(1, '0:0')).toBe('coarse');
  });

  it('splits the budget evenly across resident levels', () => {
    const cache = new ArrayCache<string>({ budget: 1000 });
    fill(cache, 0, ['a']);
    expect(cache.share).toBe(1000);
    fill(cache, 1, ['a']);
    expect(cache.share).toBe(500);
    fill(cache, 2, ['a']);
    expect(cache.share).toBeCloseTo(1000 / 3, 6);
  });

  it('evicts within a level rather than across the whole cache', () => {
    // This is the point of the split. Level 0 is the one a pan leaves behind
    // fastest, and a single pool would let it spend the coarse levels' share
    // on tiles nothing will ask for again.
    const cache = new ArrayCache<string>({ budget: 1000 });
    fill(cache, 1, ['coarse-a', 'coarse-b']);
    fill(cache, 0, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

    expect(cache.has(1, 'coarse-a')).toBe(true);
    expect(cache.has(1, 'coarse-b')).toBe(true);
    expect(cache.has(0, 'a')).toBe(false);
    expect(cache.size).toBeLessThanOrEqual(1000);
  });

  it('drops the least recently used, not the oldest written', () => {
    const cache = new ArrayCache<string>({ budget: 300 });
    fill(cache, 0, ['a', 'b', 'c']);
    cache.get(0, 'a');
    cache.set(0, 'd', 'd', TILE);

    expect(cache.has(0, 'a')).toBe(true);
    expect(cache.has(0, 'b')).toBe(false);
  });

  it('keeps the entry just written even when it alone is over the share', () => {
    // A tile bigger than a level's share would otherwise be evicted by the
    // insertion that added it, and the caller would never see a hit.
    const cache = new ArrayCache<string>({ budget: 100 });
    cache.set(0, 'big', 'big', 4000);
    expect(cache.get(0, 'big')).toBe('big');
  });

  it('stays inside the budget under pressure', () => {
    const cache = new ArrayCache<string>({ budget: 1000 });
    for (let level = 0; level < 4; level += 1) {
      for (let i = 0; i < 20; i += 1) cache.set(level, `t${i}`, 'x', TILE);
    }
    expect(cache.size).toBeLessThanOrEqual(1000);
  });

  it('lets go of a level in one call', () => {
    const cache = new ArrayCache<string>({ budget: 1000 });
    fill(cache, 0, ['a', 'b']);
    fill(cache, 1, ['a']);
    cache.dropLevel(0);
    expect(cache.has(0, 'a')).toBe(false);
    expect(cache.has(1, 'a')).toBe(true);
    expect(cache.size).toBe(TILE);
  });

  it('replaces rather than doubles when a key is written twice', () => {
    const cache = new ArrayCache<string>({ budget: 1000 });
    cache.set(0, 'a', 'first', TILE);
    cache.set(0, 'a', 'second', TILE);
    expect(cache.size).toBe(TILE);
    expect(cache.get(0, 'a')).toBe('second');
  });
});
