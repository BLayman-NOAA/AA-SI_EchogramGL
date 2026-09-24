/**
 * GPU device, limits, lifetime and the two caches every view draws from.
 *
 * One context per page, shared by every view, so several panels use one device,
 * one texture pool and one chunk cache. Section 9.3 puts both caches here for
 * the same reason: two panels on the same survey are usually looking at nearby
 * water, and a second view of a tile already decoded should cost nothing. A
 * budget per view would also mean N times the memory for N panels, which is the
 * opposite of what a split screen should cost.
 *
 * Nothing here is module level state.
 */

import type { ChannelValues } from '../data/store';
import { ArrayCache, DEFAULT_ARRAY_BUDGET } from '../data/cache';
import { PipelineCache } from './pipelines';
import type { TexturePool } from './texturePool';
import { createValuePool } from './textures';

export class GpuUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpuUnavailableError';
  }
}

/** Called after the device was replaced, or with the error if it could not be. */
export type DeviceLostHandler = (error?: unknown) => void;

export interface GpuContextOptions {
  powerPreference?: GPUPowerPreference;
  requiredFeatures?: GPUFeatureName[];
  /** Texture bytes to keep for tiles, across every view. See TexturePool. */
  textureBudget?: number;
  /** Host bytes to keep in decoded tiles, across every view. See ArrayCache. */
  arrayBudget?: number;
}

export class GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  pipelines: PipelineCache;
  readonly format: GPUTextureFormat;

  /** Tile textures, shared. Replaced when the device is, since they belong to it. */
  pool: TexturePool;

  /** Decoded tiles, shared. Outlives a device: these are host arrays. */
  readonly tiles: ArrayCache<ChannelValues>;

  private handlers = new Set<DeviceLostHandler>();
  private closed = false;

  constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    private options: GpuContextOptions,
  ) {
    this.adapter = adapter;
    this.device = device;
    this.pipelines = new PipelineCache(device);
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.pool = createValuePool(device, options.textureBudget);
    this.tiles = new ArrayCache<ChannelValues>({
      budget: options.arrayBudget ?? DEFAULT_ARRAY_BUDGET,
    });
    this.watch();
  }

  get limits(): GPUSupportedLimits {
    return this.device.limits;
  }

  /**
   * Register a handler for device loss, called after the device has been
   * replaced. Returns a function that unregisters it.
   */
  onDeviceLost(handler: DeviceLostHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  destroy() {
    this.closed = true;
    this.handlers.clear();
    this.pipelines.clear();
    this.pool.destroy();
    this.tiles.clear();
    this.device.destroy();
  }

  /**
   * Replace the device after it is lost and let views rebuild. A webview can
   * lose a device on suspend or on a driver update, so this is a normal path.
   *
   * Recovery starts from a new adapter. An adapter yields one device, and
   * asking a spent one for another returns a device that is already lost.
   */
  private watch() {
    this.device.lost.then(async (info) => {
      if (this.closed || info.reason === 'destroyed') return;
      try {
        this.adapter = await requestAdapter(this.options);
        this.device = await requestDevice(this.adapter, this.options);
      } catch (error) {
        this.notify(error);
        return;
      }
      this.pipelines.useDevice(this.device);
      // Before the handlers run, not after: a view rebuilding on the new device
      // acquires tiles straight away, and it must not be handed textures that
      // belonged to the device that went away.
      this.pool.destroy();
      this.pool = createValuePool(this.device, this.options.textureBudget);
      this.watch();
      this.notify();
    });
  }

  private notify(error?: unknown) {
    for (const handler of this.handlers) handler(error);
  }
}

/**
 * Acquire an adapter and device.
 *
 * Throws with the reason rather than returning null, because the two failures
 * need different advice: no `navigator.gpu` usually means the page is not in a
 * secure context, while a null adapter means the machine or browser cannot
 * provide one.
 */
export async function createGpuContext(
  options: GpuContextOptions = {},
): Promise<GpuContext> {
  const adapter = await requestAdapter(options);
  const device = await requestDevice(adapter, options);
  return new GpuContext(adapter, device, options);
}

async function requestAdapter(options: GpuContextOptions): Promise<GPUAdapter> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new GpuUnavailableError(
      'navigator.gpu is undefined. WebGPU needs a secure context, so use ' +
        'https or http://localhost rather than a bare hostname.',
    );
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: options.powerPreference ?? 'high-performance',
  });
  if (!adapter) {
    throw new GpuUnavailableError('requestAdapter returned null: no WebGPU adapter.');
  }
  return adapter;
}

async function requestDevice(
  adapter: GPUAdapter,
  options: GpuContextOptions,
): Promise<GPUDevice> {
  return adapter.requestDevice({
    requiredFeatures: options.requiredFeatures ?? [],
  });
}

/** Adapter facts worth recording, since they constrain tile sizing. */
export function describeContext(context: GpuContext): Record<string, unknown> {
  const limits = context.limits;
  return {
    features: [...context.adapter.features],
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxTextureArrayLayers: limits.maxTextureArrayLayers,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxBufferSize: limits.maxBufferSize,
    preferredFormat: context.format,
  };
}
