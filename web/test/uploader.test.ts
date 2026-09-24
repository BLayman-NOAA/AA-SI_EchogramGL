import { describe, expect, it, vi } from 'vitest';

import { Uploader } from '../src/data/uploader';

function job(bytes: number, log: string[], name: string, priority?: 'high' | 'low') {
  return { bytes, priority, run: () => log.push(name) };
}

describe('uploader', () => {
  it('runs what fits in one frame and queues the rest', () => {
    const log: string[] = [];
    const uploader = new Uploader({ perFrame: 250 });
    for (const name of ['a', 'b', 'c', 'd']) uploader.queue(job(100, log, name));

    expect(uploader.drain()).toBe(200);
    expect(log).toEqual(['a', 'b']);
    expect(uploader.pending).toBe(2);
  });

  it('drains across frames until it is empty', () => {
    const log: string[] = [];
    const uploader = new Uploader({ perFrame: 250 });
    for (const name of ['a', 'b', 'c', 'd']) uploader.queue(job(100, log, name));

    uploader.drain();
    uploader.drain();
    expect(log).toEqual(['a', 'b', 'c', 'd']);
    expect(uploader.drain()).toBe(0);
  });

  it('runs a job larger than the whole frame budget rather than blocking on it', () => {
    // Otherwise the tile sits at the head of the queue forever and everything
    // behind it waits on an upload that can never start.
    const log: string[] = [];
    const uploader = new Uploader({ perFrame: 100 });
    uploader.queue(job(4000, log, 'huge'));
    uploader.queue(job(10, log, 'small'));

    expect(uploader.drain()).toBe(4000);
    expect(log).toEqual(['huge']);
  });

  it('uploads what is on screen before what was guessed at', () => {
    const log: string[] = [];
    const uploader = new Uploader({ perFrame: 1000 });
    uploader.queue(job(100, log, 'ring', 'low'));
    uploader.queue(job(100, log, 'visible', 'high'));

    uploader.drain();
    expect(log).toEqual(['visible', 'ring']);
  });

  it('asks for a frame when work arrives at an empty queue', () => {
    const onQueued = vi.fn();
    const uploader = new Uploader({ perFrame: 1000, onQueued });
    const log: string[] = [];

    uploader.queue(job(10, log, 'a'));
    uploader.queue(job(10, log, 'b'));
    expect(onQueued).toHaveBeenCalledTimes(1);

    uploader.drain();
    uploader.queue(job(10, log, 'c'));
    expect(onQueued).toHaveBeenCalledTimes(2);
  });

  it('reports the bytes waiting', () => {
    const uploader = new Uploader({ perFrame: 100 });
    const log: string[] = [];
    uploader.queue(job(30, log, 'a'));
    uploader.queue(job(70, log, 'b'));
    expect(uploader.pendingBytes).toBe(100);
    uploader.clear();
    expect(uploader.pendingBytes).toBe(0);
    expect(log).toEqual([]);
  });
});
