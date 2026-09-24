import { describe, expect, it, vi } from 'vitest';

import { MockStore } from '../src/data/MockStore';
import { ArrayCache } from '../src/data/cache';
import { type TileKey, type TileWant, TileScheduler } from '../src/data/scheduler';

/** A tile is its own name here, so an assertion reads as the tile it is about. */
type Tile = string;

function name(key: TileKey): Tile {
  return `${key.level}/${key.channel}/${key.row}.${key.column}`;
}

function want(
  level: number,
  row: number,
  priority: 'high' | 'low' = 'high',
  channel = 0,
): TileWant {
  return { level, channel, row, column: 0, priority };
}

/**
 * A scheduler over MockStore, with the consumer's side recorded.
 *
 * `held` starts empty and fills as tiles are delivered, which is what the view
 * does when it installs a texture.
 */
function harness(
  options: {
    latency?: number;
    fail?: Map<string, string>;
    cache?: ArrayCache<Tile>;
    namespace?: string;
  } = {},
) {
  const store = new MockStore({
    latency: options.latency ?? 10,
    fail: options.fail,
    bytes: new Map(),
  });
  const delivered: Tile[] = [];
  const resident = new Set<Tile>();
  const errors: unknown[] = [];
  const empty = new Set<Tile>();

  const scheduler = new TileScheduler<Tile>({
    cache: options.cache ?? new ArrayCache<Tile>({ budget: 1024 * 1024 }),
    namespace: options.namespace ?? 'store-a',
    hooks: {
      read: async (key, { signal, priority }) => {
        await store.get(`${name(key)}?${priority}`, { signal, priority });
        return name(key);
      },
      weigh: () => 100,
      deliver: (key, value) => {
        delivered.push(value);
        resident.add(name(key));
      },
      held: (key) => resident.has(name(key)),
      empty: (key) => empty.has(name(key)),
      onError: (error) => errors.push(error),
    },
  });

  return { scheduler, store, delivered, resident, errors, empty };
}

describe('tile scheduler', () => {
  it('asks for exactly the set it was given', async () => {
    const { scheduler, store, delivered } = harness();
    scheduler.request([want(0, 10), want(0, 11), want(1, 5, 'low')]);
    expect(scheduler.inFlight).toBe(3);

    await store.settle();
    expect(delivered.sort()).toEqual(['0/0/10.0', '0/0/11.0', '1/0/5.0']);
    expect(scheduler.inFlight).toBe(0);
  });

  it('carries the priority the tile was wanted at', async () => {
    const { scheduler, store } = harness();
    scheduler.request([want(0, 10, 'high'), want(0, 20, 'low')]);
    await store.settle();

    expect(store.priorities.get('0/0/10.0?high')).toBe('high');
    expect(store.priorities.get('0/0/20.0?low')).toBe('low');
  });

  it('abandons a request the new viewport does not want', async () => {
    // The abort on viewport change. Without it a drag leaves every intermediate
    // frame's tiles on the wire ahead of the one being looked at.
    const { scheduler, store } = harness();
    scheduler.request([want(0, 10), want(0, 11)]);
    scheduler.request([want(0, 11), want(0, 12)]);

    expect(store.aborted).toEqual(['0/0/10.0?high']);
    expect(scheduler.inFlight).toBe(2);

    await store.settle();
    expect(store.delivered.sort()).toEqual(['0/0/11.0?high', '0/0/12.0?high']);
  });

  it('leaves a request alone when it is still wanted', async () => {
    const { scheduler, store } = harness();
    scheduler.request([want(0, 10)]);
    scheduler.request([want(0, 10), want(0, 11)]);

    expect(store.aborted).toEqual([]);
    // Asked for once, not twice: it was already on the wire.
    expect(store.requests.filter((key) => key.startsWith('0/0/10.0'))).toHaveLength(1);
    await store.settle();
  });

  it('never installs a tile that arrives after it was abandoned', async () => {
    const { scheduler, store, delivered } = harness();
    scheduler.request([want(0, 10)]);
    scheduler.request([want(0, 11)]);
    await store.settle();

    expect(delivered).toEqual(['0/0/11.0']);
  });

  it('does not ask for a tile the consumer already holds', async () => {
    const { scheduler, store, resident } = harness();
    resident.add('0/0/10.0');
    scheduler.request([want(0, 10), want(0, 11)]);

    expect(store.requests).toHaveLength(1);
    await store.settle();
  });

  it('never requests a chunk the store says is empty', async () => {
    // Architecture 3.7. On seafloor masked data the water below the bottom is
    // sentinel all the way down, and the builder already looked.
    const { scheduler, store, empty } = harness();
    empty.add('0/0/10.0');
    scheduler.request([want(0, 10), want(0, 11)]);

    expect(store.requests).toEqual(['0/0/11.0?high']);
    expect(scheduler.skipped).toBe(1);

    scheduler.request([want(0, 10)]);
    expect(store.requests).toHaveLength(1);
    await store.settle();
  });

  it('serves a second view of the same tile from the cache', async () => {
    const { scheduler, store, delivered, resident } = harness();
    scheduler.request([want(0, 10)]);
    await store.settle();

    // The texture was evicted, the tile was not. This is what the array cache
    // buys: an upload without a round trip.
    resident.clear();
    store.reset();
    scheduler.request([want(0, 10)]);

    expect(store.requests).toEqual([]);
    expect(delivered).toEqual(['0/0/10.0', '0/0/10.0']);
  });

  it('remembers a failure rather than asking again every frame', async () => {
    const { scheduler, store, errors } = harness({
      fail: new Map([['0/0/10.0?high', 'no such chunk']]),
    });
    scheduler.request([want(0, 10)]);
    await store.settle();
    expect(errors).toHaveLength(1);

    store.reset();
    scheduler.request([want(0, 10)]);
    expect(store.requests).toEqual([]);
    expect(scheduler.failures).toBe(1);
  });

  it('does not report an abort as a failure', async () => {
    const { scheduler, store, errors } = harness();
    scheduler.request([want(0, 10)]);
    scheduler.request([]);
    await store.settle();

    expect(errors).toEqual([]);
    expect(scheduler.failures).toBe(0);
  });

  it('forgets a level, its failures and what it had in flight', async () => {
    const { scheduler, store, errors } = harness({
      fail: new Map([['0/0/10.0?high', 'gone']]),
    });
    scheduler.request([want(0, 10), want(0, 11)]);
    await store.settle();
    expect(errors).toHaveLength(1);

    scheduler.request([want(0, 12)]);
    scheduler.dropLevel(0);
    expect(scheduler.inFlight).toBe(0);
    expect(scheduler.failures).toBe(0);

    store.reset();
    scheduler.request([want(0, 10)]);
    expect(store.requests).toHaveLength(1);
    await store.settle();
  });

  it('keeps channels apart', async () => {
    const { scheduler, store, resident } = harness();
    resident.add('0/0/10.0');
    scheduler.request([want(0, 10, 'high', 0), want(0, 10, 'high', 1)]);

    expect(store.requests).toEqual(['0/1/10.0?high']);
    await store.settle();
  });

  it('gives everything up at once', async () => {
    const { scheduler, store } = harness();
    scheduler.request([want(0, 10), want(0, 11)]);
    scheduler.abortAll();

    expect(scheduler.inFlight).toBe(0);
    expect(store.aborted).toHaveLength(2);
  });

  it('leaves the consumer to decide what a delivery means', async () => {
    const deliver = vi.fn();
    const store = new MockStore({ latency: 0 });
    const scheduler = new TileScheduler<string>({
      cache: new ArrayCache<string>({ budget: 1000 }),
      namespace: 'store-a',
      hooks: {
        read: async (key, options) => {
          await store.get(name(key), options);
          return name(key);
        },
        weigh: () => 10,
        deliver,
        held: () => false,
      },
    });
    scheduler.request([want(0, 3)]);
    await store.settle();

    expect(deliver).toHaveBeenCalledWith(
      { level: 0, channel: 0, row: 3, column: 0 },
      '0/0/3.0',
      'high',
    );
  });
});

describe('a cache shared between views', () => {
  it('never hands one store the tiles of another', () => {
    // The failure this prevents is silent: level 3 row 7 of one survey is not
    // level 3 row 7 of the next, and a view served the wrong one draws another
    // survey's water with nothing anywhere reporting a problem.
    const cache = new ArrayCache<Tile>({ budget: 1024 * 1024 });
    const a = harness({ cache, namespace: 'store-a' });
    const b = harness({ cache, namespace: 'store-b' });

    a.scheduler.request([want(0, 10)]);
    return a.store.settle().then(() => {
      b.scheduler.request([want(0, 10)]);
      // Asked the network rather than taking the entry sitting in the cache.
      expect(b.store.requests).toEqual(['0/0/10.0?high']);
      expect(b.delivered).toEqual([]);
      return b.store.settle();
    });
  });

  it('serves a second view of the same store from the cache', () => {
    const cache = new ArrayCache<Tile>({ budget: 1024 * 1024 });
    const a = harness({ cache, namespace: 'store-a' });
    const b = harness({ cache, namespace: 'store-a' });

    a.scheduler.request([want(0, 10)]);
    return a.store.settle().then(() => {
      b.scheduler.request([want(0, 10)]);
      expect(b.store.requests).toEqual([]);
      expect(b.delivered).toEqual(['0/0/10.0']);
    });
  });

  it('leaves the cache alone when one view lets a level go', () => {
    // The cache is shared, so dropping a level here would take entries another
    // view is reading. Its own budget decides when they leave.
    const cache = new ArrayCache<Tile>({ budget: 1024 * 1024 });
    const a = harness({ cache, namespace: 'store-a' });
    const b = harness({ cache, namespace: 'store-a' });

    a.scheduler.request([want(0, 10)]);
    return a.store.settle().then(() => {
      a.scheduler.dropLevel(0);
      b.scheduler.request([want(0, 10)]);
      expect(b.store.requests).toEqual([]);
      expect(b.delivered).toEqual(['0/0/10.0']);
    });
  });
});
