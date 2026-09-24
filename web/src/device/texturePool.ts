/**
 * Texture allocation with reuse and a budget.
 *
 * Panning across a survey creates and drops tile textures continuously, and a
 * texture is expensive to create and free relative to writing into one. Sizes
 * repeat, since every interior tile of a grid is the same shape, so a freed
 * texture is nearly always the right shape for the next tile that needs one.
 *
 * The budget covers everything allocated, in use and free alike, because that
 * is what the driver is holding. Only free textures can be given back, so a
 * visible set larger than the budget goes over it rather than failing to draw;
 * the budget shapes the cache, it does not ration the picture.
 */

const BYTES_PER_TEXEL: Record<string, number> = {
  r16float: 2,
  r32float: 4,
  rg16float: 4,
  rgba8unorm: 4,
  rgba16float: 8,
};

/** Bytes to keep allocated before free textures are released back to the driver. */
export const DEFAULT_BUDGET = 512 * 1024 * 1024;

export interface TexturePoolOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  /** Named rather than defaulted, so the pool needs no WebGPU global to exist. */
  usage: GPUTextureUsageFlags;
  budget?: number;
  label?: string;
}

interface Free {
  texture: GPUTexture;
  bytes: number;
}

export class TexturePool {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private usage: GPUTextureUsageFlags;
  private budget: number;
  private label: string;
  private texelBytes: number;

  /** Keyed by shape, so a released texture is reused only where it fits exactly. */
  private free = new Map<string, Free[]>();
  private live = new Map<GPUTexture, number>();
  private freeBytes = 0;
  private liveBytes = 0;

  constructor(options: TexturePoolOptions) {
    this.device = options.device;
    this.format = options.format;
    this.usage = options.usage;
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.label = options.label ?? 'tile';
    const bytes = BYTES_PER_TEXEL[options.format];
    if (!bytes) throw new Error(`no texel size known for format ${options.format}`);
    this.texelBytes = bytes;
  }

  /** Bytes held by textures in use. */
  get inUse(): number {
    return this.liveBytes;
  }

  /**
   * What a caller should hold in live textures before it starts letting go.
   *
   * Half the budget, so the other half is free list for the pool to hand back
   * from. A caller that fills the whole budget with live tiles leaves nothing
   * to reuse and puts every pan back on the allocator.
   */
  get share(): number {
    return this.budget / 2;
  }

  /** Bytes held by textures waiting to be reused. */
  get spare(): number {
    return this.freeBytes;
  }

  get allocated(): number {
    return this.liveBytes + this.freeBytes;
  }

  acquire(width: number, height: number): GPUTexture {
    const shape = `${width}x${height}`;
    const bytes = width * height * this.texelBytes;
    const waiting = this.free.get(shape);
    const reused = waiting?.pop();
    if (reused) {
      this.freeBytes -= reused.bytes;
      this.liveBytes += reused.bytes;
      this.live.set(reused.texture, reused.bytes);
      return reused.texture;
    }

    // Room is made before allocating, not after, so a large visible set does
    // not spend a frame holding both the old free list and the new textures.
    this.trim(bytes);
    const texture = this.device.createTexture({
      label: `${this.label} ${shape}`,
      size: [width, height, 1],
      format: this.format,
      dimension: '2d',
      usage: this.usage,
    });
    this.liveBytes += bytes;
    this.live.set(texture, bytes);
    return texture;
  }

  release(texture: GPUTexture) {
    const bytes = this.live.get(texture);
    if (bytes === undefined) {
      throw new Error('released a texture this pool did not allocate');
    }
    this.live.delete(texture);
    this.liveBytes -= bytes;

    const shape = `${texture.width}x${texture.height}`;
    const waiting = this.free.get(shape);
    if (waiting) waiting.push({ texture, bytes });
    else this.free.set(shape, [{ texture, bytes }]);
    this.freeBytes += bytes;
    this.trim(0);
  }

  /** Destroy free textures until the budget has room for `wanted` more bytes. */
  trim(wanted = 0) {
    for (const [shape, waiting] of this.free) {
      while (waiting.length && this.allocated + wanted > this.budget) {
        const dropped = waiting.shift()!;
        dropped.texture.destroy();
        this.freeBytes -= dropped.bytes;
      }
      if (!waiting.length) this.free.delete(shape);
      if (this.allocated + wanted <= this.budget) return;
    }
  }

  destroy() {
    for (const waiting of this.free.values()) {
      for (const spare of waiting) spare.texture.destroy();
    }
    for (const texture of this.live.keys()) texture.destroy();
    this.free.clear();
    this.live.clear();
    this.freeBytes = 0;
    this.liveBytes = 0;
  }
}
