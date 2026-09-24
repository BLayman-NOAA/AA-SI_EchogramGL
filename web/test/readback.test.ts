import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Cancelled, Readback, settle } from '../src/compute/readback';

/**
 * Enough of a device to drive the readback, with the map resolved by hand so a
 * test can decide what happens between the copy and the answer.
 */
function fakeDevice() {
  let release: () => void = () => undefined;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const buffer = {
    size: 0,
    mapAsync: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
    getMappedRange: vi.fn(() => bytes.buffer.slice(0)),
    unmap: vi.fn(),
    destroy: vi.fn(),
  };
  const device = {
    createBuffer: vi.fn((options: { size: number }) => {
      buffer.size = options.size;
      return buffer;
    }),
    createCommandEncoder: vi.fn(() => ({
      copyBufferToBuffer: vi.fn(),
      finish: vi.fn(() => ({})),
    })),
    queue: { submit: vi.fn() },
  };
  return { device, buffer, finish: () => release() };
}

describe('readback', () => {
  it('copies out before unmapping', async () => {
    // The mapped range is a view into memory the driver takes back, so anything
    // still pointing at it after unmap is reading a buffer that is not ours.
    const { device, buffer, finish } = fakeDevice();
    const readback = new Readback({ device: device as unknown as GPUDevice, usage: 9, mapMode: 1 });
    const pending = readback.read({} as GPUBuffer, 4);
    finish();
    await pending;

    const order = buffer.getMappedRange.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(buffer.unmap.mock.invocationCallOrder[0]);
  });

  it('abandons a result the view no longer wants', async () => {
    const { device, buffer, finish } = fakeDevice();
    const readback = new Readback({ device: device as unknown as GPUDevice, usage: 9, mapMode: 1 });
    const pending = readback.read({} as GPUBuffer, 4);
    readback.cancel();
    finish();

    await expect(pending).rejects.toBeInstanceOf(Cancelled);
    // Still unmapped: a buffer left mapped cannot be used by the next read.
    expect(buffer.unmap).toHaveBeenCalled();
  });

  it('reuses the staging buffer until a bigger one is needed', async () => {
    const { device, finish } = fakeDevice();
    const readback = new Readback({ device: device as unknown as GPUDevice, usage: 9, mapMode: 1 });
    const first = readback.read({} as GPUBuffer, 64);
    finish();
    await first;
    const second = readback.read({} as GPUBuffer, 32);
    finish();
    await second;
    expect(device.createBuffer).toHaveBeenCalledTimes(1);

    const third = readback.read({} as GPUBuffer, 256);
    finish();
    await third;
    expect(device.createBuffer).toHaveBeenCalledTimes(2);
  });

  it('reports whether a read is on the device', async () => {
    const { device, finish } = fakeDevice();
    const readback = new Readback({ device: device as unknown as GPUDevice, usage: 9, mapMode: 1 });
    const pending = readback.read({} as GPUBuffer, 4);
    expect(readback.inFlight).toBe(true);
    finish();
    await pending;
    expect(readback.inFlight).toBe(false);
  });
});

describe('settle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once for a burst of requests', () => {
    // A drag asks on every frame. NFR-3's budget is measured against a view
    // that has stopped moving, which is what this is for.
    const run = vi.fn();
    const scheduler = settle(run, 100);
    for (let i = 0; i < 20; i += 1) scheduler.request();
    vi.advanceTimersByTime(99);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not run after a cancel', () => {
    const run = vi.fn();
    const scheduler = settle(run, 100);
    scheduler.request();
    scheduler.cancel();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });
});
