/**
 * Run the reduction over whatever tiles are resident.
 *
 * The inputs are the tiles the view already fetched, so a reduction costs no
 * read and no allocation beyond its own buffers. What it measures is therefore
 * what is on screen at the resolution on screen: at a coarse level the counts
 * are of coarse cells, each already a linear mean of the source samples it
 * merged, which is the honest answer to "what is visible" and not the same
 * number as a full resolution pass over the same rectangle.
 */

import type { GpuContext } from '../device/context';
import { Readback } from './readback';
import {
  type Accumulated,
  type Histogram,
  DEFAULT_BINS,
  accumulate,
} from './statistics';
import source from './reduce.wgsl?raw';

/** Texels one workgroup covers on each axis. Must match the shader. */
const BLOCK = 64;

/** Bytes in Region: two vec2f, a vec2f, an f32 and a u32. */
const REGION_BYTES = 32;

/** Bytes in TileSpan: two vec2f and four u32. */
const TILE_BYTES = 32;

/** Bytes in one Partial: two f32 and two u32. */
const PARTIAL_BYTES = 16;

/** One tile of one channel, as the reducer needs it. */
export interface ReduceTile {
  texture: GPUTexture;
  /** First sample the tile owns and how many, excluding the apron. */
  sampleSpan: [number, number];
  /** First sample held in the texture and how many columns it has. */
  textureSpan: [number, number];
  pingOffset: number;
  pings: number;
}

export interface ReduceRequest {
  /** Per ping geometry of the level and channel the tiles belong to. */
  geometry: GPUBuffer;
  tiles: ReduceTile[];
  x: [number, number];
  y: [number, number];
  /** Lowest and highest value the histogram covers. */
  range: [number, number];
  nodata: number;
  bins?: number;
}

export interface ReduceResult extends Accumulated {
  histogram: Histogram;
}

export class Reducer {
  private readback: Readback;
  private pipeline?: GPUComputePipeline;
  private bins?: GPUBuffer;
  private partials?: GPUBuffer;
  private region: GPUBuffer;
  private tile: GPUBuffer;
  private partialCount = 0;

  constructor(private context: GpuContext) {
    this.readback = new Readback({
      device: context.device,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      mapMode: GPUMapMode.READ,
      label: 'reduction',
    });
    this.region = context.device.createBuffer({
      label: 'reduce region',
      size: REGION_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.tile = context.device.createBuffer({
      label: 'reduce tile',
      size: TILE_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Abandon a reduction in flight, so its answer is never applied. */
  cancel() {
    this.readback.cancel();
  }

  /**
   * Reduce, or return undefined when there is nothing resident to reduce.
   *
   * Throws Cancelled if the view moved while the device was working.
   */
  async run(request: ReduceRequest): Promise<ReduceResult | undefined> {
    if (!request.tiles.length) return undefined;
    const device = this.context.device;
    const bins = request.bins ?? DEFAULT_BINS;
    const pipeline = await this.ensurePipeline();

    const blocks = request.tiles.map((tile) => ({
      across: Math.max(1, Math.ceil(tile.sampleSpan[1] / BLOCK)),
      down: Math.max(1, Math.ceil(tile.pings / BLOCK)),
    }));
    const total = blocks.reduce((sum, block) => sum + block.across * block.down, 0);

    this.ensureBuffers(bins, total);
    this.writeRegion(request, bins);
    device.queue.writeBuffer(this.bins!, 0, new Uint32Array(bins));
    device.queue.writeBuffer(this.partials!, 0, new Uint32Array(total * 4));

    // One dispatch per tile, and one tile uniform rewritten between them, so
    // the encoder is built after each write rather than interleaved with it.
    let base = 0;
    for (let index = 0; index < request.tiles.length; index += 1) {
      const tile = request.tiles[index];
      const block = blocks[index];
      this.writeTile(tile, base, block.across);

      const encoder = device.createCommandEncoder({ label: 'reduce' });
      const pass = encoder.beginComputePass({ label: `reduce tile ${index}` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.bindGroup(pipeline, request.geometry, tile));
      pass.dispatchWorkgroups(block.across, block.down, 1);
      pass.end();
      device.queue.submit([encoder.finish()]);
      base += block.across * block.down;
    }

    const partialBytes = await this.readback.read(this.partials!, total * PARTIAL_BYTES);
    const binBytes = await this.readback.read(this.bins!, bins * 4);

    return {
      ...accumulate(partialBytes, total),
      histogram: {
        counts: new Uint32Array(binBytes.slice(0, bins * 4)),
        range: request.range,
      },
    };
  }

  private async ensurePipeline(): Promise<GPUComputePipeline> {
    if (this.pipeline) return this.pipeline;
    const device = this.context.device;
    const module = device.createShaderModule({ label: 'reduce', code: source });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length) {
      throw new Error(
        `reduce failed to compile\n${errors
          .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`)
          .join('\n')}`,
      );
    }
    this.pipeline = device.createComputePipeline({
      label: 'reduce',
      layout: 'auto',
      compute: { module, entryPoint: 'reduce' },
    });
    return this.pipeline;
  }

  private ensureBuffers(bins: number, blocks: number) {
    const device = this.context.device;
    if (!this.bins || this.bins.size < bins * 4) {
      this.bins?.destroy();
      this.bins = device.createBuffer({
        label: 'histogram bins',
        size: bins * 4,
        usage:
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    }
    if (!this.partials || this.partialCount < blocks) {
      this.partials?.destroy();
      this.partialCount = Math.max(blocks, 64);
      this.partials = device.createBuffer({
        label: 'reduce partials',
        size: this.partialCount * PARTIAL_BYTES,
        usage:
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    }
  }

  private writeRegion(request: ReduceRequest, bins: number) {
    const block = new ArrayBuffer(REGION_BYTES);
    const floats = new Float32Array(block);
    const uints = new Uint32Array(block);
    floats[0] = request.x[0];
    floats[1] = request.x[1];
    floats[2] = request.y[0];
    floats[3] = request.y[1];
    floats[4] = request.range[0];
    floats[5] = request.range[1];
    floats[6] = request.nodata;
    uints[7] = bins;
    this.context.device.queue.writeBuffer(this.region, 0, block);
  }

  private writeTile(tile: ReduceTile, base: number, across: number) {
    const block = new ArrayBuffer(TILE_BYTES);
    const floats = new Float32Array(block);
    const uints = new Uint32Array(block);
    floats[0] = tile.sampleSpan[0];
    floats[1] = tile.sampleSpan[1];
    floats[2] = tile.textureSpan[0];
    floats[3] = tile.textureSpan[1];
    uints[4] = tile.pingOffset;
    uints[5] = tile.pings;
    uints[6] = base;
    uints[7] = across;
    this.context.device.queue.writeBuffer(this.tile, 0, block);
  }

  private bindGroup(
    pipeline: GPUComputePipeline,
    geometry: GPUBuffer,
    tile: ReduceTile,
  ): GPUBindGroup {
    return this.context.device.createBindGroup({
      label: 'reduce inputs',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.region } },
        { binding: 1, resource: { buffer: this.tile } },
        { binding: 2, resource: { buffer: geometry } },
        { binding: 3, resource: { buffer: this.bins! } },
        { binding: 4, resource: { buffer: this.partials! } },
        { binding: 5, resource: tile.texture.createView() },
      ],
    });
  }

  destroy() {
    this.readback.destroy();
    this.region.destroy();
    this.tile.destroy();
    this.bins?.destroy();
    this.partials?.destroy();
  }
}
