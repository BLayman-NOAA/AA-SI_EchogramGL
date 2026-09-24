import { describe, expect, it } from 'vitest';

import { MockStore } from '../src/data/MockStore';
import { Summaries, loadSummaries } from '../src/data/summaries';

/** Chunks of (1, 2048, 512), which is what the builder writes by default. */
const chunks = [1, 2048, 512];

const document = {
  '0': {
    '0.0.0': { allNodata: false, min: -90, max: -30 },
    '0.0.1': { allNodata: true },
    '0.1.0': { allNodata: true },
    '0.1.1': { allNodata: true },
    '1.0.0': { allNodata: false },
  },
};

describe('chunk summaries', () => {
  const summaries = new Summaries(document);

  it('skips a window whose every chunk is empty', () => {
    // Pings 2048 to 4096 of channel 0, which is chunk 0.1.0 and 0.1.1.
    expect(summaries.allNodata(0, 0, chunks, [2048, 4096], [0, 1024])).toBe(true);
  });

  it('fetches a window where any chunk holds something', () => {
    // One live chunk anywhere in the window means the tile has something to
    // draw, and drawing it needs the whole window.
    expect(summaries.allNodata(0, 0, chunks, [0, 4096], [0, 1024])).toBe(false);
  });

  it('reads the chunk the window actually falls in', () => {
    // Samples 512 to 1024 is sample chunk 1, which is empty at ping chunk 0.
    expect(summaries.allNodata(0, 0, chunks, [0, 2048], [512, 1024])).toBe(true);
    expect(summaries.allNodata(0, 0, chunks, [0, 2048], [0, 512])).toBe(false);
  });

  it('keeps channels apart', () => {
    expect(summaries.allNodata(0, 1, chunks, [0, 2048], [0, 512])).toBe(false);
  });

  it('fetches whenever the answer is not certain', () => {
    // A guess that skips draws a hole and reports no problem, so an unknown
    // level, an unknown chunk and a nonsense chunk shape all have to fetch.
    expect(summaries.allNodata(3, 0, chunks, [0, 2048], [0, 512])).toBe(false);
    expect(summaries.allNodata(0, 0, chunks, [999999, 1000000], [0, 512])).toBe(false);
    expect(summaries.allNodata(0, 0, [1, 0, 512], [0, 2048], [0, 512])).toBe(false);
  });

  it('reports the share of a level that holds nothing', () => {
    expect(summaries.emptyShare(0)).toBeCloseTo(3 / 5, 6);
    expect(summaries.emptyShare(9)).toBeUndefined();
  });

  it('knows which levels it describes', () => {
    expect(summaries.has(0)).toBe(true);
    expect(summaries.has(1)).toBe(false);
  });
});

describe('loading the sidecar', () => {
  it('reads it from the store', async () => {
    const bytes = new Map([
      ['summaries.json', new TextEncoder().encode(JSON.stringify(document))],
    ]);
    const store = new MockStore({ bytes });
    const pending = loadSummaries(store, 'summaries.json');
    await store.settle();

    const summaries = await pending;
    expect(summaries?.has(0)).toBe(true);
  });

  it('treats an absent sidecar as an absence, not a failure', async () => {
    // It only ever removes work, so a store built before it existed simply
    // fetches every chunk.
    const store = new MockStore();
    const pending = loadSummaries(store, 'summaries.json');
    await store.settle();
    expect(await pending).toBeUndefined();
  });

  it('treats an unreadable sidecar the same way', async () => {
    const bytes = new Map([['summaries.json', new TextEncoder().encode('{ not json')]]);
    const store = new MockStore({ bytes });
    const pending = loadSummaries(store, 'summaries.json');
    await store.settle();
    expect(await pending).toBeUndefined();
  });
});
