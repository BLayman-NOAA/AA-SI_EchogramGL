/**
 * Texture uploads, spread across frames.
 *
 * Architecture section 4.5. A burst of chunks arriving together each calling
 * writeTexture in one frame stutters visibly, and chunks do arrive together:
 * the requests went out together and the link delivers them together. The cap
 * is per frame bytes, and the rest waits for the next one.
 *
 * Nothing here touches WebGPU. A job is a closure the view supplies and a byte
 * count to charge it, which is what lets the queue be tested without a device.
 */

export interface UploadJob {
  /** Bytes this upload writes, which is what the cap is spent against. */
  bytes: number;
  /** Visible tiles ahead of speculative ones, whatever order they arrived in. */
  priority?: 'high' | 'low';
  run(): void;
}

/**
 * Bytes to write per frame.
 *
 * Four megabytes is two 2048 by 512 tiles at float16, which is a tile or two
 * of movement per frame and well inside a 16 ms budget on the hardware this
 * targets.
 */
export const DEFAULT_PER_FRAME = 4 * 1024 * 1024;

export interface UploaderOptions {
  perFrame?: number;
  /** Called when work is queued and nothing has drained it yet. */
  onQueued?: () => void;
}

export class Uploader {
  private perFrame: number;
  private onQueued?: () => void;
  private high: UploadJob[] = [];
  private low: UploadJob[] = [];

  constructor(options: UploaderOptions = {}) {
    this.perFrame = options.perFrame ?? DEFAULT_PER_FRAME;
    this.onQueued = options.onQueued;
  }

  /** Jobs waiting. */
  get pending(): number {
    return this.high.length + this.low.length;
  }

  /** Bytes waiting, which is what a status line reports. */
  get pendingBytes(): number {
    let total = 0;
    for (const job of this.high) total += job.bytes;
    for (const job of this.low) total += job.bytes;
    return total;
  }

  queue(job: UploadJob) {
    const empty = this.pending === 0;
    if (job.priority === 'low') this.low.push(job);
    else this.high.push(job);
    if (empty) this.onQueued?.();
  }

  /**
   * Run what fits in one frame.
   *
   * The first job always runs, even alone over the cap. A tile larger than the
   * whole frame budget would otherwise sit at the head of the queue forever and
   * block everything behind it.
   *
   * Returns the bytes written, so a caller can tell a drained frame from an
   * idle one.
   */
  drain(): number {
    let spent = 0;
    while (this.pending) {
      const job = this.high.length ? this.high[0] : this.low[0];
      if (spent && spent + job.bytes > this.perFrame) break;
      if (this.high.length) this.high.shift();
      else this.low.shift();
      job.run();
      spent += job.bytes;
    }
    return spent;
  }

  /** Throw away queued work, as when the store is replaced. */
  clear() {
    this.high = [];
    this.low = [];
  }
}
