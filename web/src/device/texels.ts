/**
 * Reading single values back from a value texture.
 *
 * For the hover readout, when the decoded tile it would read is no longer in
 * the host cache: the texture being drawn holds the same float16 values, and
 * one texel is a small copy and one map. Reads run one after another, so a
 * pointer moving across many cells queues reads rather than failing them.
 */

import { halfToNumber } from '../data/values';

/** `copyTextureToBuffer` rows are padded to this many bytes. */
const ROW_ALIGNMENT = 256;

export class TexelReader {
  private staging?: GPUBuffer;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private device: GPUDevice) {}

  /** The value of one texel of an r16float texture. */
  read(texture: GPUTexture, x: number, y: number): Promise<number> {
    const run = () => this.readNow(texture, x, y);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readNow(texture: GPUTexture, x: number, y: number): Promise<number> {
    this.staging ??= this.device.createBuffer({
      label: 'texel readback',
      size: ROW_ALIGNMENT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const staging = this.staging;
    const encoder = this.device.createCommandEncoder({ label: 'texel readback' });
    encoder.copyTextureToBuffer(
      { texture, origin: { x, y } },
      { buffer: staging, bytesPerRow: ROW_ALIGNMENT },
      [1, 1, 1],
    );
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ, 0, 4);
    const bits = new Uint16Array(staging.getMappedRange(0, 4).slice(0))[0];
    staging.unmap();
    return halfToNumber(bits);
  }

  destroy() {
    this.staging?.destroy();
    this.staging = undefined;
  }
}
