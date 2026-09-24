/**
 * Getting numbers back off the device without blocking a frame.
 *
 * A readback is a copy to a mappable buffer, a fence, and an await. The await
 * is the point: nothing here blocks, and a result that arrives after the view
 * has moved is dropped rather than shown, because a statistic labelled with the
 * wrong rectangle is worse than no statistic.
 *
 * Cancellation is a generation counter and not an abort signal. The GPU work is
 * already queued by the time a cancel could arrive, so stopping it is not on
 * offer; what is on offer is refusing to apply the answer.
 */

export class Cancelled extends Error {
  constructor() {
    super('reduction cancelled');
    this.name = 'Cancelled';
  }
}

export interface ReadbackOptions {
  device: GPUDevice;
  /**
   * Usage flags for the staging buffer, and the mode it is mapped with.
   *
   * Passed in rather than read from the WebGPU globals, so this module needs no
   * device to be loaded and its cancellation behaviour can be tested without
   * one. Same reason TexturePool takes its usage.
   */
  usage: GPUBufferUsageFlags;
  mapMode: GPUMapModeFlags;
  label?: string;
}

/**
 * A staging buffer that is reused, and a queue of one.
 *
 * Reused because a reduction runs on every viewport settle and allocating a
 * buffer per reduction is what makes a pan allocate. Queue of one because the
 * only answer worth having is the latest.
 */
export class Readback {
  private staging?: GPUBuffer;
  private size = 0;
  private generation = 0;
  private busy = false;

  constructor(private options: ReadbackOptions) {}

  /** Abandon whatever is in flight. Its result will not be returned. */
  cancel() {
    this.generation += 1;
  }

  /** Whether a read is waiting on the device, so a caller can skip a dispatch. */
  get inFlight(): boolean {
    return this.busy;
  }

  /**
   * Copy `bytes` from `source` and resolve with a copy of them.
   *
   * Throws Cancelled if the view moved while the device was working, which the
   * caller is expected to swallow.
   */
  async read(source: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const { device } = this.options;
    const staging = this.ensure(bytes);
    const generation = this.generation;
    this.busy = true;

    try {
      const encoder = device.createCommandEncoder({ label: 'readback' });
      encoder.copyBufferToBuffer(source, 0, staging, 0, bytes);
      device.queue.submit([encoder.finish()]);

      await staging.mapAsync(this.options.mapMode, 0, bytes);
      if (generation !== this.generation) {
        staging.unmap();
        throw new Cancelled();
      }
      // Copied out before unmapping: the mapped range is a view into memory the
      // driver takes back, so anything still pointing at it afterwards is
      // reading a buffer that is no longer ours.
      const copy = staging.getMappedRange(0, bytes).slice(0);
      staging.unmap();
      return copy;
    } finally {
      this.busy = false;
    }
  }

  private ensure(bytes: number): GPUBuffer {
    if (this.staging && this.size >= bytes) return this.staging;
    this.staging?.destroy();
    this.size = Math.max(bytes, 4);
    this.staging = this.options.device.createBuffer({
      label: this.options.label ?? 'readback staging',
      size: this.size,
      usage: this.options.usage,
    });
    return this.staging;
  }

  destroy() {
    this.generation += 1;
    this.staging?.destroy();
    this.staging = undefined;
  }
}

/**
 * Call `run` once the caller has stopped asking, and never twice at once.
 *
 * A reduction over the visible region costs milliseconds, and a drag asks for
 * one on every frame. Waiting for the view to settle turns a hundred requests
 * into one, and is why NFR-3's hundred millisecond budget is measured against a
 * view that has stopped moving.
 */
export function settle(run: () => void, delay: number): {
  request(): void;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    request() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, delay);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
