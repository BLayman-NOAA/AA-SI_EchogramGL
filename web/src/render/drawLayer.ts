/**
 * A stack of value layers, one draw per layer per slot.
 *
 * Four things are shared at four different scopes. The view matrix belongs to
 * the pass. The pipeline, the color table, the sampler and the limits belong to
 * a layer. The per ping geometry belongs to a level and a channel, because a
 * coarse tile standing in for a fine slot is positioned from its own level's
 * sidecar and a channel has its own sample interval. The texture belongs to a
 * tile of one channel.
 *
 * That layering is what keeps a pan cheap: the matrix is in the buffer every
 * bind group already points at, so moving the view writes one small buffer and
 * replays a recorded bundle. It is also what keeps a toggle or an opacity
 * change off the compiler, per NFR-5: neither is in a pipeline key.
 *
 * A slot drawn from a coarser tile is an instance range inside that tile,
 * passed as a first instance. `instance_index` is both the geometry offset and
 * the texture row, so the shader needs to know nothing about substitution.
 */

import {
  type Color,
  type Layer,
  channelsOf,
  colorMode,
  filterFor,
  pipelineConstants,
  pipelineKey,
} from '../app/layers';
import type { GpuContext } from '../device/context';
import type { SlotDraw } from '../geometry/levels';
import { blendFor } from './blend';
import { buildLut, buildTintLut, createLutTexture } from './colormaps';
import { buildPalette } from './palettes';
import { BundleCache } from './bundles';
import source from './passes/value.wgsl?raw';

/** Bytes in ViewUniforms: a mat3x3f padded to 48, then one f32. */
const VIEW_BYTES = 64;

/** Bytes in LayerParams. */
const PARAMS_BYTES = 32;

/** Bytes in TileUniforms: two vec2f and two u32, padded to a 16 byte multiple. */
const TILE_BYTES = 32;

/** Floats per ping in the geometry buffer: xLeft, xRight, rangeStart, step. */
export const GEOMETRY_STRIDE = 4;

/**
 * Labels a categorical table covers, counting from -1.
 *
 * Fixed rather than measured. The table costs four bytes an entry, and which
 * labels are actually present is a question for the histogram in milestone 8,
 * which is also what the legend needs before it can report shares.
 */
const PALETTE_LABELS = 64;

export type NodataMode = 'paint' | 'transparent';

export interface LayerStackOptions {
  context: GpuContext;
  format: GPUTextureFormat;
  /** Painted where a layer's nodata mode is 'paint'. */
  nodataColor: [number, number, number];
  /** Anything at or below this is nodata. */
  nodataThreshold: number;
}

/** Where one tile sits in its level, and how its texture is laid out. */
export interface TileView {
  /** First sample the quads span, and how many they span. */
  sampleSpan: [number, number];
  /** First sample held in the texture, and how many columns it has. */
  textureSpan: [number, number];
  /** Index in this level's geometry of the tile's first ping. */
  pingOffset: number;
  /** Rows in the texture, which the ping coordinate is divided by. */
  textureRows: number;
}

/** What one layer draws, in slot order. */
export interface LayerPass {
  layer: string;
  draws: SlotDraw[];
}

interface LayerEntry {
  layer: Layer;
  pipeline: GPURenderPipeline;
  params: GPUBuffer;
  sampler: GPUSampler;
  table: TableEntry;
  /**
   * Bind groups this layer holds, by level for group 0 and by tile for group 1.
   *
   * Per layer and not shared, because pipelines are created with an automatic
   * layout: two pipelines declaring the same bindings still have distinct
   * layout objects, and a bind group belongs to the one it was made against.
   * Both caches are dropped whenever anything they name is replaced.
   */
  groups: Map<number, GPUBindGroup>;
  tileGroups: Map<string, { group: GPUBindGroup; stamp: string }>;
}

interface TableEntry {
  key: string;
  texture: GPUTexture;
  view: GPUTextureView;
  /** How many layers point at it, so a shared table outlives one of them. */
  users: number;
}

interface GeometryEntry {
  buffer: GPUBuffer;
  pings: number;
}

interface TileEntry {
  buffer: GPUBuffer;
  view: GPUTextureView;
  /** Raised on every install, so a bundle holding the old one is re-recorded. */
  stamp: number;
}

export class LayerStack {
  private viewBuffer: GPUBuffer;
  private bundles: BundleCache;
  private nodataColor: [number, number, number];
  private nodataThreshold: number;

  private layers: LayerEntry[] = [];
  private tables = new Map<string, TableEntry>();
  private geometry = new Map<string, GeometryEntry>();
  private tiles = new Map<string, TileEntry>();
  private passes: LayerPass[] = [];
  private stamps = 0;

  private constructor(
    private context: GpuContext,
    private format: GPUTextureFormat,
    options: LayerStackOptions,
  ) {
    this.nodataColor = options.nodataColor;
    this.nodataThreshold = options.nodataThreshold;
    this.viewBuffer = context.device.createBuffer({
      label: 'view uniforms',
      size: VIEW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bundles = new BundleCache(context.device, {
      label: 'layer stack',
      colorFormats: [format],
    });
  }

  static create(options: LayerStackOptions): LayerStack {
    return new LayerStack(options.context, options.format, options);
  }

  private get device(): GPUDevice {
    return this.context.device;
  }

  /** Tiles installed across every level and channel, whether drawn or not. */
  get resident(): number {
    return this.tiles.size;
  }

  /** Times the draw list has been recorded, which a pan must not raise. */
  get recordings(): number {
    return this.bundles.recordings;
  }

  /** Distinct pipelines the current stack needs, which a toggle must not move. */
  get pipelines(): number {
    return new Set(this.layers.map((entry) => pipelineKey(entry.layer, this.format)))
      .size;
  }

  /**
   * Install the stack.
   *
   * Everything a layer needs is rebuilt here, and nothing else is: pipelines
   * come from the cache, so a layer whose key is already known costs no
   * compilation, and a color table is shared by every layer asking for the same
   * color. A layer that has not changed keeps the buffer it had, which is what
   * makes changing one layer of five cost one layer's work.
   */
  async setLayers(layers: Layer[]) {
    const previous = new Map(this.layers.map((entry) => [entry.layer.id, entry]));
    const built: LayerEntry[] = [];

    for (const layer of layers) {
      const held = previous.get(layer.id);
      const entry = await this.buildLayer(layer, held);
      previous.delete(layer.id);
      built.push(entry);
    }

    for (const stale of previous.values()) this.releaseLayer(stale);
    const differs = !sameShape(this.layers, built);
    this.layers = built;
    // Only when the recording would differ. A dragged opacity and a stepped
    // limit rewrite a uniform buffer and name the same pipelines, bind groups
    // and draw ranges, so re-recording every frame of a drag is work with no
    // effect on the picture.
    if (differs) this.bundles.invalidate();
  }

  private async buildLayer(
    layer: Layer,
    held: LayerEntry | undefined,
  ): Promise<LayerEntry> {
    const pipeline = await this.context.pipelines.render({
      key: pipelineKey(layer, this.format),
      label: `value pass ${colorMode(layer.color)}`,
      code: source,
      vertex: 'vs_main',
      fragment: 'fs_value',
      constants: pipelineConstants(layer),
      targets: [{ format: this.format, blend: blendFor(layer.blend) }],
    });

    // The limits and the opacity live in this buffer, so a layer keeping its
    // identity keeps it and changing them is a write rather than a rebuild.
    const params =
      held?.params ??
      this.device.createBuffer({
        label: `layer params ${layer.id}`,
        size: PARAMS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    const table = this.table(layer.color, held);
    const filter = filterFor(layer);
    const sampler =
      held && filterFor(held.layer) === filter
        ? held.sampler
        : this.device.createSampler({
            label: `layer ${layer.id} ${filter}`,
            magFilter: filter,
            minFilter: filter,
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          });

    // The channels are in here because group 0 names their geometry buffers,
    // at binding 4 and binding 5. Without them, changing a layer's channel kept
    // the bind group built for the previous one, so the new channel's samples
    // were positioned by the old channel's range_step: switching an 18 kHz
    // layer to 70 kHz drew it on an 0.188 m grid instead of 0.179, which is
    // three and a half metres of error at the bottom of this survey and reads
    // exactly as two channels refusing to line up.
    const same =
      held !== undefined &&
      held.layer.channel === layer.channel &&
      held.layer.against === layer.against &&
      held.pipeline === pipeline &&
      held.sampler === sampler &&
      held.table === table;

    const entry: LayerEntry = {
      layer,
      pipeline,
      params,
      sampler,
      table,
      groups: same ? held.groups : new Map(),
      tileGroups: same ? held.tileGroups : new Map(),
    };
    this.writeParams(entry);
    return entry;
  }

  /**
   * Acquire a color table, sharing one that already matches.
   *
   * Taken before the old one is let go, so a layer keeping its color never
   * destroys the texture it is about to point at again.
   */
  private table(color: Color, held: LayerEntry | undefined): TableEntry {
    const key = tableKey(color);
    let entry = this.tables.get(key);
    if (!entry) {
      const texture = createLutTexture(this.device, tableBytes(color), key);
      entry = { key, texture, view: texture.createView(), users: 0 };
      this.tables.set(key, entry);
    }
    entry.users += 1;
    if (held) this.dropTable(held.table);
    return entry;
  }

  private dropTable(table: TableEntry) {
    table.users -= 1;
    if (table.users > 0) return;
    this.tables.delete(table.key);
    table.texture.destroy();
  }

  private releaseLayer(entry: LayerEntry) {
    entry.params.destroy();
    this.dropTable(entry.table);
  }

  /**
   * Give a level and channel their per ping geometry, four floats each: xLeft,
   * xRight, rangeStart, rangeStep. Changing the x axis rewrites this and
   * nothing else, which is what keeps an axis switch free of any refetch.
   */
  setGeometry(level: number, channel: number, data: Float32Array<ArrayBuffer>) {
    const pings = data.length / GEOMETRY_STRIDE;
    if (!Number.isInteger(pings)) {
      throw new Error(`geometry is ${data.length} floats, not a whole number of pings`);
    }

    const key = `${level}:${channel}`;
    const existing = this.geometry.get(key);
    if (existing && existing.pings === pings) {
      this.device.queue.writeBuffer(existing.buffer, 0, data);
      return;
    }
    existing?.buffer.destroy();

    const buffer = this.device.createBuffer({
      label: `ping geometry ${key}`,
      size: Math.max(1, pings) * GEOMETRY_STRIDE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    this.geometry.set(key, { buffer, pings });
    // A layer's group 0 names two geometry buffers, its own channel's at
    // binding 4 and the one it differences against at binding 5, so a new
    // buffer invalidates every group naming it either way. Checking only the
    // first left a difference layer holding a group that points at the second
    // channel's destroyed buffer.
    for (const entry of this.layers) {
      const reads = entry.layer.channel === channel || entry.layer.against === channel;
      if (reads) entry.groups.delete(level);
    }
    this.bundles.invalidate();
  }

  /**
   * The geometry buffer of one level and channel, for a pass that is not this
   * one. The compute reduction bounds itself in data space and so needs the
   * same per ping positions the quads are placed from.
   */
  geometryBuffer(level: number, channel: number): GPUBuffer | undefined {
    return this.geometry.get(`${level}:${channel}`)?.buffer;
  }

  /** Let go of a level, across every channel. */
  dropLevel(level: number) {
    for (const [key, entry] of [...this.geometry]) {
      if (!key.startsWith(`${level}:`)) continue;
      entry.buffer.destroy();
      this.geometry.delete(key);
    }
    for (const key of [...this.tiles.keys()]) {
      if (key.startsWith(`${level}:`)) this.dropTileNamed(key);
    }
    for (const entry of this.layers) {
      entry.groups.delete(level);
      for (const name of [...entry.tileGroups.keys()]) {
        if (name.startsWith(`${level}:`)) entry.tileGroups.delete(name);
      }
    }
    this.bundles.invalidate();
  }

  /**
   * Column major mat3x3, padded, from `clipMatrix`, and the vertical data units
   * one device pixel covers, which is what says how many samples to average.
   */
  setView(matrix: Float32Array<ArrayBuffer>, yPerPixel: number) {
    const block = new Float32Array(VIEW_BYTES / 4);
    block.set(matrix, 0);
    block[12] = yPerPixel;
    this.device.queue.writeBuffer(this.viewBuffer, 0, block);
  }

  /** Rewrite every layer's limits and opacity, which costs no compilation. */
  refreshParams() {
    for (const entry of this.layers) this.writeParams(entry);
  }

  private writeParams(entry: LayerEntry) {
    const block = new Float32Array(PARAMS_BYTES / 4);
    block[0] = entry.layer.clim[0];
    block[1] = entry.layer.clim[1];
    block[2] = this.nodataThreshold;
    block[3] = entry.layer.opacity;
    block[4] = this.nodataColor[0];
    block[5] = this.nodataColor[1];
    block[6] = this.nodataColor[2];
    block[7] = 1;
    this.device.queue.writeBuffer(entry.params, 0, block);
  }

  /**
   * Install a tile of one channel.
   *
   * The texture belongs to whoever allocated it. This holds a view against it
   * and lets go on `dropTile`, so a pool decides when the memory is reused
   * rather than the stack.
   */
  setTile(
    level: number,
    channel: number,
    key: string,
    texture: GPUTexture,
    view: TileView,
  ) {
    const name = tileName(level, channel, key);
    const existing = this.tiles.get(name);
    const buffer =
      existing?.buffer ??
      this.device.createBuffer({
        label: `tile ${name}`,
        size: TILE_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    const block = new ArrayBuffer(TILE_BYTES);
    const floats = new Float32Array(block);
    const uints = new Uint32Array(block);
    floats[0] = view.sampleSpan[0];
    floats[1] = view.sampleSpan[1];
    floats[2] = view.textureSpan[0];
    floats[3] = view.textureSpan[1];
    uints[4] = view.pingOffset;
    uints[5] = view.textureRows;
    this.device.queue.writeBuffer(buffer, 0, block);

    this.stamps += 1;
    this.tiles.set(name, {
      buffer,
      view: texture.createView(),
      stamp: this.stamps,
    });
    this.bundles.invalidate();
  }

  dropTile(level: number, channel: number, key: string) {
    this.dropTileNamed(tileName(level, channel, key));
    this.bundles.invalidate();
  }

  private dropTileNamed(name: string) {
    const tile = this.tiles.get(name);
    if (!tile) return;
    tile.buffer.destroy();
    this.tiles.delete(name);
    for (const entry of this.layers) entry.tileGroups.delete(name);
  }

  /** Repaint every layer's nodata cells in a new color. No compilation. */
  setNodataColor(color: [number, number, number]) {
    this.nodataColor = color;
    this.refreshParams();
  }

  /** What each layer draws, in stack order. A slot with no tile is skipped. */
  setDraws(passes: LayerPass[]) {
    this.passes = passes;
  }

  draw(pass: GPURenderPassEncoder) {
    const ready: { entry: LayerEntry; draws: SlotDraw[] }[] = [];
    const stamped: string[] = [];

    for (const item of this.passes) {
      const entry = this.layers.find((held) => held.layer.id === item.layer);
      if (!entry || !entry.layer.visible) continue;
      // A difference layer needs both channels of a slot. Having one and not
      // the other is a slot that cannot be drawn rather than one drawn from
      // half its inputs.
      const channels = channelsOf(entry.layer);
      const draws = item.draws.filter((slot) =>
        channels.every(
          (channel) =>
            this.geometry.has(`${slot.level}:${channel}`) &&
            this.tiles.has(tileName(slot.level, channel, slotKey(slot))),
        ),
      );
      if (!draws.length) continue;
      ready.push({ entry, draws });
      // The key names every bind group the recording holds and the range each
      // one draws, so a tile refilled in place invalidates it and a pan does
      // not. The layer id carries its pipeline, table and limits with it.
      stamped.push(entry.layer.id);
      for (const slot of draws) {
        const stamps = channels
          .map((channel) => this.tiles.get(tileName(slot.level, channel, slotKey(slot)))!.stamp)
          .join('.');
        const name = tileName(slot.level, entry.layer.channel, slotKey(slot));
        stamped.push(`${name}#${stamps}@${slot.firstInstance}+${slot.instances}`);
      }
    }
    if (!ready.length) return;

    const bundle = this.bundles.bundle(stamped.join(','), (encoder) => {
      for (const { entry, draws } of ready) {
        encoder.setPipeline(entry.pipeline);
        let level = -1;
        for (const slot of draws) {
          if (slot.level !== level) {
            encoder.setBindGroup(0, this.passGroup(entry, slot.level));
            level = slot.level;
          }
          const name = tileName(slot.level, entry.layer.channel, slotKey(slot));
          const group = this.tileGroup(entry, name, slot);
          if (!group) continue;
          encoder.setBindGroup(1, group);
          encoder.draw(4, slot.instances, 0, slot.firstInstance);
        }
      }
    });
    pass.executeBundles([bundle]);
  }

  /** Group 0 for one layer at one level: the pass, the layer and the geometry. */
  private passGroup(entry: LayerEntry, level: number): GPUBindGroup {
    const held = entry.groups.get(level);
    if (held) return held;
    const geometry = this.geometry.get(`${level}:${entry.layer.channel}`)!;
    // A value layer points binding 5 back at its own geometry. The shader
    // never reads it, and one bind group layout across the stack is worth more
    // than a second layout that omits it.
    const second = entry.layer.against ?? entry.layer.channel;
    const other = this.geometry.get(`${level}:${second}`) ?? geometry;
    const group = this.device.createBindGroup({
      label: `layer ${entry.layer.id} level ${level}`,
      layout: entry.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.viewBuffer } },
        { binding: 1, resource: { buffer: entry.params } },
        { binding: 2, resource: entry.table.view },
        { binding: 3, resource: entry.sampler },
        { binding: 4, resource: { buffer: geometry.buffer } },
        { binding: 5, resource: { buffer: other.buffer } },
      ],
    });
    entry.groups.set(level, group);
    return group;
  }

  /**
   * Group 1 for one tile, against this layer's own layout.
   *
   * A difference layer names two textures of the same slot. Its second one is
   * bound here rather than in group 0 because it is per tile, and the uniform
   * beside it says which samples that texture holds; where the sample sits
   * comes from the second channel's geometry in group 0.
   */
  private tileGroup(
    entry: LayerEntry,
    name: string,
    slot: SlotDraw,
  ): GPUBindGroup | undefined {
    const tile = this.tiles.get(name)!;
    const second = entry.layer.against;
    const pairName =
      second === undefined ? name : tileName(slot.level, second, slotKey(slot));
    const pair = this.tiles.get(pairName);
    if (!pair) return undefined;

    // Both stamps, so refilling either texture rebuilds the group. Combined by
    // a string rather than arithmetic, since stamps only ever rise.
    const stamp = `${tile.stamp}:${pair.stamp}`;
    const held = entry.tileGroups.get(name);
    if (held && held.stamp === stamp) return held.group;

    const group = this.device.createBindGroup({
      label: `tile ${name}`,
      layout: entry.pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: tile.buffer } },
        { binding: 1, resource: tile.view },
        { binding: 2, resource: pair.view },
        { binding: 3, resource: { buffer: pair.buffer } },
      ],
    });
    entry.tileGroups.set(name, { group, stamp });
    return group;
  }

  destroy() {
    for (const tile of this.tiles.values()) tile.buffer.destroy();
    for (const entry of this.geometry.values()) entry.buffer.destroy();
    for (const entry of this.layers) entry.params.destroy();
    for (const table of this.tables.values()) table.texture.destroy();
    this.tiles.clear();
    this.geometry.clear();
    this.tables.clear();
    this.layers = [];
    this.passes = [];
    this.bundles.invalidate();
    this.viewBuffer.destroy();
  }
}

/**
 * Whether two stacks would record the same bundle.
 *
 * The limits and the opacity are absent on purpose: they live in a uniform
 * buffer the recording points at rather than in the recording, so changing them
 * reaches the next frame without re-recording anything. Everything a draw call
 * names is here, by identity, since a rebuilt pipeline or sampler is a
 * different object even where it is the same description.
 */
/**
 * Whether a new stack can reuse the entries the old one built.
 *
 * Exported for its test. Everything the bind groups were built from has to be
 * in here: an entry kept when one of them changed is an entry pointing at the
 * wrong buffer, and the picture is wrong rather than absent.
 */
export function sameShape(a: LayerEntry[], b: LayerEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      entry.layer.id === other.layer.id &&
      entry.layer.channel === other.layer.channel &&
      // Both channels, because both are named by the bind groups compared
      // below. buildLayer already gives a layer new groups when either moves,
      // so this agrees with it rather than catching anything it misses.
      entry.layer.against === other.layer.against &&
      entry.layer.visible === other.layer.visible &&
      entry.pipeline === other.pipeline &&
      entry.sampler === other.sampler &&
      entry.table === other.table &&
      entry.groups === other.groups
    );
  });
}

function tileName(level: number, channel: number, key: string): string {
  return `${level}:${channel}:${key}`;
}

function slotKey(slot: SlotDraw): string {
  return `${slot.row}:${slot.column}`;
}

/** Two layers asking for the same color share one table. */
export function tableKey(color: Color): string {
  if ('tint' in color) return `tint:${color.tint.join(',')}`;
  if ('palette' in color) return `palette:${color.palette}:${PALETTE_LABELS}`;
  return `colormap:${color.colormap}`;
}

function tableBytes(color: Color): Uint8Array<ArrayBuffer> {
  if ('tint' in color) return buildTintLut(color.tint);
  if ('palette' in color) return buildPalette(PALETTE_LABELS - 1);
  return buildLut(color.colormap);
}

/**
 * Pack per ping geometry for the storage buffer.
 *
 * Positions are f32 on the GPU. A time axis is already an offset in seconds
 * from the first ping, per section 5.2, so it holds sub millisecond precision
 * over a multi day range rather than losing the low bits of a nanosecond count.
 */
export function packGeometry(
  left: Float64Array,
  right: Float64Array,
  rangeStart: Float64Array,
  rangeStep: Float64Array,
): Float32Array<ArrayBuffer> {
  const count = left.length;
  const packed = new Float32Array(count * GEOMETRY_STRIDE);
  for (let i = 0; i < count; i += 1) {
    packed[i * GEOMETRY_STRIDE + 0] = left[i];
    packed[i * GEOMETRY_STRIDE + 1] = right[i];
    packed[i * GEOMETRY_STRIDE + 2] = rangeStart[i];
    packed[i * GEOMETRY_STRIDE + 3] = rangeStep[i];
  }
  return packed;
}
