/**
 * Value textures.
 *
 * Sv is r16float, which WebGPU filters without a device feature. r32float would
 * need `float32-filterable` and buys nothing: near 100 dB, float16 spacing is
 * about 0.06 dB.
 *
 * One texture holds one tile of one channel. Channels were layers of an array
 * texture while a level was one texture, which cost nothing because only one
 * layer was ever filled. Under tiling it would multiply every tile by the
 * channel count to hold data no pass reads, so a tile is a plain 2d texture and
 * a channel switch refills them.
 */

import { TexturePool } from './texturePool';

export const VALUE_FORMAT: GPUTextureFormat = 'r16float';

export interface ValueTextureSize {
  /** Texture x, the sample axis. */
  samples: number;
  /** Texture y, the ping axis. */
  pings: number;
}

export class TextureTooLargeError extends Error {
  constructor(size: ValueTextureSize, limit: number) {
    super(
      `a ${size.samples} by ${size.pings} texture exceeds the device limit of ` +
        `${limit}. Tiling handles this; a single texture does not.`,
    );
    this.name = 'TextureTooLargeError';
  }
}

/**
 * What this needs of a context, named structurally.
 *
 * A GpuContext satisfies it, and so does anything else with a device. Taking
 * the context type here would make device and texture modules import each
 * other, which the layer rule refuses for a good reason: load order would
 * start to matter.
 */
export interface DeviceLimits {
  device: GPUDevice;
  limits: GPUSupportedLimits;
}

export function createValueTexture(
  context: DeviceLimits,
  size: ValueTextureSize,
): GPUTexture {
  const limit = context.limits.maxTextureDimension2D;
  if (size.samples > limit || size.pings > limit) {
    throw new TextureTooLargeError(size, limit);
  }
  return context.device.createTexture({
    label: 'values',
    size: [size.samples, size.pings, 1],
    format: VALUE_FORMAT,
    dimension: '2d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
}

/** A pool sized for value tiles, which are all the same format and usage. */
export function createValuePool(device: GPUDevice, budget?: number): TexturePool {
  return new TexturePool({
    device,
    format: VALUE_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    budget,
    label: 'value tile',
  });
}

/**
 * Fill a texture from raw float16.
 *
 * `bits` is ping major, so a texture row is one ping's samples and no transpose
 * or conversion happens on the way in.
 */
export function writeValues(
  device: GPUDevice,
  texture: GPUTexture,
  bits: Uint16Array<ArrayBuffer>,
  size: ValueTextureSize,
) {
  device.queue.writeTexture(
    { texture },
    bits,
    { bytesPerRow: size.samples * 2, rowsPerImage: size.pings },
    [size.samples, size.pings, 1],
  );
}
