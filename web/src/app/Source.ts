/**
 * One dataset in a view.
 *
 * A view draws from one or more sources and shares the viewport, the layer
 * stack, the pools and the uploader between them. Everything that belongs to
 * one store lives here: the store, the levels loaded from it, the scheduler
 * asking for its tiles and the tiles it holds.
 *
 * The scheduler and the cache know a level by its index in this store, which
 * is what lets two views on the same store share cached tiles. The layer stack
 * knows it by a plane, a number the view hands out once per level of every
 * source, so two sources never name the same geometry buffer or tile.
 */

import type { ReduceTile } from '../compute';
import { FetchStore } from '../data/FetchStore';
import type { DecodePool } from '../data/decode';
import { plan } from '../data/prefetch';
import { type TileWant, TileScheduler, tileKey } from '../data/scheduler';
import {
  type ChannelValues,
  type ChunkStore,
  EchogramStore,
  type LevelReader,
  PriorityStore,
  openEchogramStore,
} from '../data/store';
import type { Multiscales } from '../data/contract';
import type { PieceSetSpec } from '../data/pieces';
import { Summaries, loadSummaries } from '../data/summaries';
import type { Uploader } from '../data/uploader';
import type { GpuContext } from '../device/context';
import { halfToNumber } from '../data/values';
import { writeValues } from '../device/textures';
import type { AxisContext, XUnit, YUnit } from '../geometry/axes';
import {
  type Extent,
  type VerticalGeometry,
  type XAxisValues,
  type XSource,
  buildXAxis,
  medianSpacing,
  verticalExtent,
  verticalFor,
} from '../geometry/coords';
import {
  type SlotDraw,
  SUBSTITUTION_CAP,
  chooseLevel,
  resolveSlot,
  sourcePings,
  wantedFactor,
} from '../geometry/levels';
import {
  type Tile,
  type TileBox,
  type TileGrid,
  allTiles,
  boxOverlaps,
  planTiles,
  tileAt,
  tileBox,
} from '../geometry/tiles';
import { type LayerStack, type TileView, packGeometry } from '../render/drawLayer';
import { type AlignmentProblem, checkAlignment } from './alignment';
import { type Layer, channelsOf } from './layers';
import type { Viewport } from './viewport';

/** Level chosen from the view rather than named. */
export type LevelChoice = number | 'auto';

/** Bytes one value occupies, which is what r16float means. */
export const VALUE_BYTES = 2;

/** Share of what the pool holds live that a survey wide pin may take. */
const PIN_SHARE = 4;

/**
 * Milliseconds a tile stays protected after it leaves the frame.
 *
 * A pan that overshoots and comes back, or a zoom out and in, asks again for
 * the tiles it just left, and a tile evicted in between is a fetch that was
 * already paid for. Under pool pressure these go after tiles out of frame
 * longer, and nothing wanted this refresh goes at all.
 */
const RETAIN_MS = 5000;

/** What a source needs from the view it is drawn in. */
export interface SourceHost {
  readonly context: GpuContext;
  readonly decode: DecodePool | undefined;
  readonly uploader: Uploader;
  readonly layer: LayerStack | undefined;
  readonly viewport: Viewport | undefined;
  readonly xUnit: XUnit;
  readonly yUnit: YUnit;
  readonly levelChoice: LevelChoice;
  readonly pixelsPerPing: number;
  /** Bumped by every call on the view, so a stale load does not redraw. */
  readonly generation: number;
  /** Bumped by every refresh, which is how eviction tells wanted from not. */
  readonly clock: number;
  readonly destroyed: boolean;
  /** Velocity in x units a second, and whether the view is still moving. */
  readonly motion: { velocity: number; moving: boolean };
  /** Sources sharing the texture pool, which divide its share between them. */
  readonly sourceCount: number;
  /** The view's time origin, adopting the first one offered. */
  epoch(firstPingNs: number): number;
  /** A level the footprint asked for has loaded. */
  levelLoaded(): void;
  onError(error: unknown): void;
}

/** One level, everything derived from it, and what it currently holds. */
export interface LevelState {
  index: number;
  factor: number;
  level: LevelReader;
  shape: { pings: number; samples: number };
  /**
   * The vertical every channel spans together: the shallowest start and the
   * widest step of any of them.
   *
   * Bounds, culling boxes and the unit conversion all use it, because a stack
   * shows several channels at once and the extent that holds one may not hold
   * another. Being a superset it can only ever draw a tile that turned out not
   * to be visible, never cull one that was.
   */
  vertical: VerticalGeometry;
  /** Per channel geometry, which is what the shader positions quads from. */
  verticals: Map<number, VerticalGeometry>;
  source: XSource;
  context: AxisContext;
  axis: XAxisValues;
  /** Median cell width, cached because choosing a level asks for it per frame. */
  spacing: number;
  /** Units each channel's geometry buffer was packed in, if it is packed. */
  packed: Map<number, { x: XUnit; y: YUnit }>;
  grid: TileGrid;
  tiles: Tile[];
  boxes: Map<string, TileBox>;
  /** Tiles held, keyed by channel and tile, since a channel has its own. */
  resident: Map<string, Resident>;
}

interface Resident {
  texture: GPUTexture;
  /** Which channel's values it holds, and which tile, since the key joins both. */
  channel: number;
  tile: string;
  /** Kept so a rebuilt layer can be refilled without refetching anything. */
  view: TileView;
  /** When this tile was last wanted, for choosing what to drop. */
  seen: number;
  /** Milliseconds clock of the last refresh that found it in frame. */
  onScreenAt: number;
}

/** What one refresh decided for the layers reading a source. */
export interface SourceRefresh {
  draws: Map<string, SlotDraw[]>;
  /** Tiles of the target level in frame. */
  onScreen: number;
  blank: number;
  standingIn: number;
}

/** A resident tile eviction may take, and how to let it go. */
export interface Spare {
  graced: boolean;
  /** Levels between this tile's and the target. */
  distance: number;
  idle: number;
  release(): void;
}

/** What the statistics pass reads from a source. */
export interface ReduceInput {
  geometry: GPUBuffer;
  tiles: ReduceTile[];
  /** Source pings the rectangle spans, which the depth integral averages over. */
  pings: number;
  level: number;
}

/**
 * One channel under a point: the cell drawn there and the value it holds.
 *
 * `value` is null where the cell holds no data, and undefined where the tile
 * is drawn but its values are no longer held in memory to read.
 */
export interface CellProbe {
  level: number;
  /** Source pings the cell merges. */
  factor: number;
  ping: number;
  sample: number;
  /** The cell's edges, in the units on screen. */
  x: Extent;
  y: Extent;
  value: number | null | undefined;
  /**
   * Where the value sits in the texture being drawn, for reading it back when
   * the host cache no longer holds it. `held` says whether the texture still
   * holds this tile, since an evicted one is reused for another.
   */
  texel?: { texture: GPUTexture; x: number; y: number; held: () => boolean };
}

/** Counts behind the view's tile status. */
export interface SourceStatus {
  resident: number;
  loading: number;
  failed: number;
  skipped: number;
  levelsHeld: number;
}

/**
 * What a view asks of a source, whichever kind it is.
 *
 * A pyramid source is one store with many levels. A piece source is many
 * single level datasets side by side in time, each opened as a pyramid
 * source of one level, which is why most of what it does is to forward.
 */
export interface ViewSource {
  readonly id: string;
  readonly kind: 'pyramid' | 'pieces';
  /** Where the store is, where there is one store and it can say. */
  readonly href: string | undefined;
  readonly multiscales: Multiscales;
  readonly levelCount: number;
  readonly target: number;
  readonly channels: number | undefined;
  /** The level the view's single store questions are answered from. */
  readonly state: LevelState | undefined;
  readonly someState: LevelState | undefined;
  /** Whether the view now calls for something other than what is loaded. */
  readonly stale: boolean;
  /** What units the source allows, once `prepare` has said. */
  readonly context: AxisContext | undefined;
  readonly status: SourceStatus;
  /** Load what placing the source needs, and say which units it allows. */
  prepare(): Promise<AxisContext>;
  bounds(): { x: Extent; y: Extent } | undefined;
  /** An x axis over the whole source, for resolving a window. */
  windowAxis(): XAxisValues | undefined;
  /** Where to open the view, where the whole would be too much to load. */
  openingX(channels: number): Extent | undefined;
  retarget(current: () => boolean): Promise<void>;
  refresh(layers: Layer[], channels: number[]): SourceRefresh;
  stamp(now: number): void;
  spare(now: number, channels: number): Spare[];
  prune(): void;
  uploadGeometry(channels: number[]): void;
  replaceAxes(): void;
  dropChannels(keep: number[]): void;
  reinstall(stack: LayerStack): void;
  retry(): void;
  /** Load again what the view was showing, after a device loss. */
  reload(): Promise<void>;
  dropLevels(giveBack?: boolean): void;
  destroy(giveBack?: boolean): void;
  channelName(channel: number): string;
  alignmentProblems(layers: Layer[], problems: Map<string, AlignmentProblem>): void;
  reduceInput(channel: number, x: Extent, y: Extent): ReduceInput | undefined;
  /** The cell drawn at a point for one channel, if there is one. */
  probe(x: number, y: number, channel: number): CellProbe | undefined;
  /** Things worth telling the user that are not errors. */
  notes(): string[];
  /** How a second window opens this source again, if it can. */
  setting(): { id: string; store?: string; spec?: PieceSetSpec } | undefined;
}

/** Source pings whose cell centre falls inside a range. */
function pingsWithin(axis: XAxisValues, x: Extent): number {
  let inside = 0;
  for (let i = 0; i < axis.centre.length; i += 1) {
    if (axis.centre[i] >= x[0] && axis.centre[i] <= x[1]) inside += 1;
  }
  return inside;
}

/**
 * The ping whose cell holds an x value, or undefined in a gap between cells.
 * The edges rise with the index, so the search halves.
 */
export function pingAt(axis: XAxisValues, x: number): number | undefined {
  let low = 0;
  let high = axis.left.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (x < axis.left[middle]) high = middle - 1;
    else if (x >= axis.right[middle]) low = middle + 1;
    else return middle;
  }
  return undefined;
}

/**
 * The tile column a sample falls in.
 *
 * Interior tiles hold `tileSamples` each; a level narrow enough for one
 * column holds every sample in it.
 */
function columnOf(tileSamples: number, columns: number, sample: number): number {
  return Math.min(Math.floor(sample / tileSamples), columns - 1);
}

/** Tiles are per channel, so every map over them is keyed by both. */
function held(channel: number, key: string): string {
  return `${channel}:${key}`;
}

/** The same key, from the coordinates the scheduler names a tile by. */
function residentKey(key: { channel: number; row: number; column: number }): string {
  return tileKey(key);
}

/** A tile across every level, which is what an upload queue is keyed by. */
function identify(key: {
  level: number;
  channel: number;
  row: number;
  column: number;
}): string {
  return `${key.level}:${tileKey(key)}`;
}

/** Lowest and highest of a list, which is the tile span a viewport covers. */
function extent(values: number[]): [number, number] {
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Pings on screen at a level, end exclusive, scanned over the tiles in frame.
 *
 * Tighter than the tiles, which hold 2048 pings against a viewport showing
 * perhaps a thousand. The finer levels are held over this rather than over the
 * tiles, so what they cost is about the viewport and not about where the tile
 * boundaries happened to fall.
 */
function pingsOnScreen(
  axis: XAxisValues,
  tiles: Tile[],
  x: Extent,
): [number, number] | undefined {
  let first = -1;
  let last = -1;
  for (const tile of tiles) {
    for (let ping = tile.pings[0]; ping < tile.pings[1]; ping += 1) {
      if (axis.right[ping] > x[0] && axis.left[ping] < x[1]) {
        if (first < 0) first = ping;
        last = ping;
      }
    }
  }
  return first < 0 ? undefined : [first, last + 1];
}

/**
 * The vertical every channel of a level covers together.
 *
 * The shallowest start and the widest step, which is a superset of each
 * channel's own grid. Used for the extent, for culling and for converting the
 * vertical unit, all of which are questions about the view rather than about
 * one layer's geometry.
 */
function spanChannels(
  verticals: Map<number, VerticalGeometry>,
  samples: number,
): VerticalGeometry {
  const parts = [...verticals.values()];
  const first = parts[0];
  const rangeStart = Float64Array.from(first.rangeStart);
  const rangeStep = Float64Array.from(first.rangeStep);
  for (const part of parts.slice(1)) {
    for (let ping = 0; ping < rangeStart.length; ping += 1) {
      rangeStart[ping] = Math.min(rangeStart[ping], part.rangeStart[ping]);
      rangeStep[ping] = Math.max(rangeStep[ping], part.rangeStep[ping]);
    }
  }
  return { rangeStart, rangeStep, samples };
}

/** A store with levels, drawn at whichever level the view calls for. */
export class PyramidSource implements ViewSource {
  readonly kind = 'pyramid';

  /** Loaded levels by index. The target and the pinned coarsest at least. */
  private states = new Map<number, LevelState>();
  /**
   * Levels the footprint named the last time the view was at rest.
   *
   * What keeps a level loaded once its tiles are gone. Taken at rest rather
   * than on every refresh because a drag names only the coarse fill, and a
   * level let go for that would be loaded again the moment the drag ends.
   */
  private wantedLevels = new Set<number>();
  /**
   * Levels whose load failed, not asked for again until a control changes.
   *
   * The footprint names them on every pointer move, and asking again each
   * time would turn one unreadable level into a stream of requests and error
   * reports, which is the scheduler's reasoning about a tile applied a level up.
   */
  private failedLevels = new Set<number>();
  /** Loads in flight, so a zoom does not start one level load per pointer move. */
  private pending = new Map<number, Promise<LevelState>>();
  /**
   * Tiles read and queued for upload but not yet written.
   *
   * Counted as held, or the scheduler delivers them again on the next pointer
   * move: they are in the cache and not yet resident, which is exactly the
   * state a cache hit is for. Without this a drag queues the same tile once per
   * frame and the duplicates spend the upload budget the real tiles needed.
   */
  private queued = new Set<string>();
  private scheduler: TileScheduler<ChannelValues>;

  /** Bumped only when tiles stop meaning anything, which a colormap does not. */
  private tileGeneration = 0;
  /** Bumped when every level is dropped, so a load in flight cannot install. */
  private levelGeneration = 0;

  target: number;
  readonly coarsest: number;

  private constructor(
    readonly id: string,
    /** First plane of this source's levels. Level i is planeBase + i. */
    readonly planeBase: number,
    readonly store: EchogramStore,
    private chunks: PriorityStore,
    /** Whether the store is one a decode worker can open again from its URL. */
    private reopenable: boolean,
    private summaries: Summaries | undefined,
    private host: SourceHost,
    /**
     * Whether the coarsest level may be held for the whole survey. A piece
     * of a mapped step is a source of one level, and that level being pinned
     * would make every piece ever opened exempt from eviction.
     */
    private pins = true,
  ) {
    this.coarsest = store.levelCount - 1;
    this.target = this.coarsest;
    this.scheduler = new TileScheduler<ChannelValues>({
      cache: host.context.tiles,
      // The cache belongs to the context and every view reads it, so what
      // separates this store's tiles from another's has to be in the key.
      namespace: chunks.href ?? `store:${id}`,
      hooks: {
        read: (key, options) => this.readTile(key, options),
        weigh: (values) => values.data.byteLength,
        deliver: (key, values, priority) => this.install(key, values, priority),
        held: (key) => this.stillWanted(key),
        empty: (key) => this.isEmpty(key),
        onError: (error) => host.onError(error),
      },
    });
  }

  /**
   * Open a store.
   *
   * `allocate` hands out planes, one per level, once the level count is
   * known.
   */
  static async open(
    id: string,
    source: string | ChunkStore,
    allocate: (count: number) => number,
    host: SourceHost,
  ): Promise<PyramidSource> {
    const store_ = typeof source === 'string' ? new FetchStore(source) : source;
    const chunks = new PriorityStore(store_);
    const store = await openEchogramStore(chunks);
    // Only ever removes work, so a store without the sidecar simply asks for
    // every chunk and nothing about this is conditional on it arriving.
    let summaries: Summaries | undefined;
    if (store.summaryPath) summaries = await loadSummaries(chunks, store.summaryPath);
    else if (store.inlineSummaries) summaries = new Summaries(store.inlineSummaries);
    return PyramidSource.fromStore(
      id,
      store,
      chunks,
      store_ instanceof FetchStore,
      summaries,
      allocate,
      host,
    );
  }

  /**
   * Wrap a store already open, such as one built from a server header.
   *
   * `pins` false leaves the coarsest level to eviction like any other, which
   * is what a piece of a mapped step needs.
   */
  static fromStore(
    id: string,
    store: EchogramStore,
    chunks: PriorityStore,
    reopenable: boolean,
    summaries: Summaries | undefined,
    allocate: (count: number) => number,
    host: SourceHost,
    pins = true,
  ): PyramidSource {
    const planeBase = allocate(store.levelCount);
    return new PyramidSource(
      id,
      planeBase,
      store,
      chunks,
      reopenable,
      summaries,
      host,
      pins,
    );
  }

  get multiscales(): Multiscales {
    return this.store.multiscales;
  }

  async prepare(): Promise<AxisContext> {
    const state = await this.ensureLevel(this.coarsest);
    return state.context;
  }

  get context(): AxisContext | undefined {
    return this.someState?.context;
  }

  setting() {
    return this.href ? { id: this.id, store: this.href } : undefined;
  }

  windowAxis(): XAxisValues | undefined {
    return this.someState?.axis;
  }

  /** A pyramid opens on its whole extent, which its coarsest level makes cheap. */
  openingX(): Extent | undefined {
    return undefined;
  }

  async reload() {
    await this.ensureLevel(this.coarsest);
    await this.ensureLevel(this.target);
  }

  notes(): string[] {
    return [];
  }

  /** Where the store is, where it can say. */
  get href(): string | undefined {
    return this.chunks.href;
  }

  get levelCount(): number {
    return this.store.levelCount;
  }

  /** The plane the layer stack knows a level of this source by. */
  plane(level: number): number {
    return this.planeBase + level;
  }

  /** The level being drawn. */
  get state(): LevelState | undefined {
    return this.states.get(this.target);
  }

  /**
   * A level to answer from when the target has not loaded yet.
   *
   * The extent, the axis and the vertical geometry are the same survey at every
   * level, so any loaded level answers them, and the pinned coarsest is always
   * one of them.
   */
  get anyState(): LevelState {
    return this.state ?? this.states.get(this.coarsest)!;
  }

  /** Any loaded level, or none while the first one is still on its way. */
  get someState(): LevelState | undefined {
    return this.state ?? this.states.get(this.coarsest);
  }

  /** Levels held, for the view's status. */
  get levelsHeld(): number {
    return this.states.size;
  }

  get channels(): number | undefined {
    return this.someState?.level.channels;
  }

  channelName(channel: number): string {
    const frequency = this.store.multiscales.channelFrequencies?.[channel];
    if (frequency) return `${Math.round(frequency / 1000)} kHz`;
    return this.store.multiscales.channelNames?.[channel] ?? `channel ${channel}`;
  }

  /**
   * Load a level, or return the one already loaded.
   *
   * Reads the sidecars and the shape. The values themselves arrive a tile at a
   * time, so opening a level costs a few small arrays whatever its size.
   */
  ensureLevel(index: number): Promise<LevelState> {
    const found = this.states.get(index);
    if (found) return Promise.resolve(found);
    const started = this.pending.get(index);
    if (started) return started;

    const load = this.loadLevel(index);
    this.pending.set(index, load);
    load.catch(() => undefined).then(() => this.pending.delete(index));
    return load;
  }

  private async loadLevel(index: number): Promise<LevelState> {
    const stamp = this.levelGeneration;
    const level = await this.store.level(index);
    const shape = { pings: level.pings, samples: level.samples };
    // Every channel, not only the one asked for. The sidecar is one array for
    // the whole level and is read whole either way, so slicing the rest of it
    // costs nothing and a layer added later needs no second read.
    const verticals = new Map<number, VerticalGeometry>();
    for (let channel = 0; channel < level.channels; channel += 1) {
      const geometry = await level.geometry(channel);
      verticals.set(channel, { ...geometry, samples: shape.samples });
    }
    const vertical = spanChannels(verticals, shape.samples);

    const pingTime = await level.readSidecar('ping_time');
    if (!pingTime) throw new Error(`level ${index} has no ping_time sidecar`);
    const xDistance = await level.readSidecar('x_distance');
    const binStart = await level.readSidecar('bin_ping_start');
    const binEnd = await level.readSidecar('bin_ping_end');

    const multiscales = this.store.multiscales;
    const context: AxisContext = {
      dataType: multiscales.dataType,
      verticalRef: multiscales.verticalRef,
      hasGps: Boolean(xDistance),
      pingSpan:
        binStart && binEnd ? [binStart[0], binEnd[binEnd.length - 1]] : undefined,
    };

    const factor = level.entry.factors.ping ?? 1;
    const source: XSource = {
      pingTime,
      xDistance,
      factor,
      epoch: this.host.epoch(pingTime[0]),
    };
    const axis = buildXAxis(this.host.xUnit, source);
    const grid = planTiles(shape, {
      maxDimension: this.host.context.limits.maxTextureDimension2D,
    });
    const state: LevelState = {
      index,
      factor,
      level,
      shape,
      vertical,
      verticals,
      source,
      context,
      axis,
      spacing: medianSpacing(axis.centre),
      packed: new Map(),
      grid,
      tiles: allTiles(grid),
      boxes: new Map(),
      resident: new Map(),
    };
    this.placeTiles(state);
    // A load started before the levels were dropped is reading the channel
    // that was showing then. Its sidecars are per channel, so installing it
    // now would give the new channel the old one's vertical geometry.
    if (this.host.destroyed || stamp !== this.levelGeneration) return state;

    this.states.set(index, state);
    return state;
  }

  /**
   * Choose the level from the view and load it.
   *
   * Only the target is loaded here. The levels held around it, coarser for a
   * slot to stand on and finer for a zoom to land on, are named by the
   * footprint on the next refresh and loaded from there. The level being
   * replaced is not let go: its tiles are in frame, and retention keeps a
   * level for as long as it holds any, so a zoom refines from what was on
   * screen rather than dropping to the pinned coarsest.
   */
  async retarget(current: () => boolean) {
    const wanted = this.wantedLevel();
    // Loaded, not merely unchanged. A channel change drops every level and
    // reloads only the pinned coarsest, so the level the view is already
    // sitting on is the one that has to be asked for again, and it is exactly
    // the one an unchanged answer would skip.
    if (wanted === this.target && this.states.has(wanted)) return;
    await this.ensureLevel(wanted);
    if (!current()) return;
    this.target = wanted;
  }

  /** Whether the view now calls for a different level than the one drawn. */
  get stale(): boolean {
    return this.wantedLevel() !== this.target;
  }

  /**
   * Load a level the footprint named and the view does not hold, then ask again.
   *
   * Not awaited by anything. A coarser level is what a slot stands on while
   * the target's own tiles are in flight, and waiting for it would put the
   * stand-in behind the thing it is covering for. A finer one is speculative
   * and has nothing to wait for it at all.
   */
  private loadWanted(level: number) {
    if (this.states.has(level) || this.pending.has(level)) return;
    if (this.failedLevels.has(level)) return;
    const generation = this.host.generation;
    void this.ensureLevel(level)
      .then(() => {
        if (generation !== this.host.generation || this.host.destroyed) return;
        this.host.levelLoaded();
      })
      .catch((error) => {
        this.failedLevels.add(level);
        this.host.onError(error);
      });
  }

  /** What the view asks for, or what was named if a level was named. */
  private wantedLevel(): number {
    const choice = this.host.levelChoice;
    const last = this.store.levelCount - 1;
    if (choice !== 'auto') return Math.min(Math.max(Math.trunc(choice), 0), last);

    const state = this.someState;
    const viewport = this.host.viewport;
    if (!state || !viewport) return this.coarsest;
    const span = viewport.x[1] - viewport.x[0];
    const pings = sourcePings(span, state.spacing, state.factor);
    const wanted = wantedFactor(pings, viewport.panel.width, this.host.pixelsPerPing);
    return chooseLevel(this.target, wanted, this.factors);
  }

  private get factors(): number[] {
    return this.store.multiscales.datasets.map((d) => d.factors.ping ?? 1);
  }

  /**
   * Let go of levels holding nothing that are neither wanted nor pinned.
   *
   * A level is kept while any tile of it is resident, whatever the footprint
   * says. The tiles are what retention is for and the level is what places
   * them, so it goes only once eviction has taken the last of them, and with
   * it the geometry buffers and the sidecars.
   */
  prune() {
    for (const state of [...this.states.values()]) {
      if (state.index === this.target || state.index === this.coarsest) continue;
      if (this.wantedLevels.has(state.index) || state.resident.size) continue;
      this.dropLevel(state.index);
    }
  }

  private dropLevel(index: number) {
    const state = this.states.get(index);
    if (!state) return;
    for (const key of [...state.resident.keys()]) this.release(state, key);
    this.states.delete(index);
    this.host.layer?.dropLevel(this.plane(index));
    this.scheduler.dropLevel(index);
  }

  /** Whether a tile of a level overlaps the viewport, drawn from or not. */
  private inFrame(state: LevelState, key: string): boolean {
    const box = state.boxes.get(key);
    const viewport = this.host.viewport;
    return Boolean(box && viewport && boxOverlaps(box, viewport.x, viewport.y));
  }

  /** Vertical geometry of one level in the unit currently chosen. */
  private verticalOf(state: LevelState): VerticalGeometry {
    return verticalFor(this.host.yUnit, state.vertical);
  }

  /** Whole extent in the current units, or none before a level has loaded. */
  bounds(): { x: Extent; y: Extent } | undefined {
    const state = this.someState;
    if (!state) return undefined;
    const axis = state.axis;
    return {
      x: [axis.left[0], axis.right[axis.right.length - 1]],
      y: verticalExtent(this.verticalOf(state)),
    };
  }

  /** Rebuild every level's axis, after the x unit changed. */
  replaceAxes() {
    for (const state of this.states.values()) {
      state.axis = buildXAxis(this.host.xUnit, state.source);
      state.spacing = medianSpacing(state.axis.centre);
      state.packed.clear();
      this.placeTiles(state);
    }
  }

  /**
   * Work out where each tile of a level falls in data space.
   *
   * Culling is a rectangle test rather than an index calculation, because heave
   * moves a sample index up and down by a metre or so and the vertical unit can
   * change under it. The boxes are recomputed when an axis changes and are good
   * for every frame until it does.
   */
  placeTiles(state: LevelState) {
    const vertical = this.verticalOf(state);
    state.boxes = new Map(
      state.tiles.map((tile) => [tile.key, tileBox(tile, state.axis, vertical)]),
    );
  }

  private geometryFor(state: LevelState, channel: number): Float32Array<ArrayBuffer> {
    const geometry = state.verticals.get(channel) ?? state.vertical;
    const vertical = verticalFor(this.host.yUnit, geometry);
    return packGeometry(
      state.axis.left,
      state.axis.right,
      vertical.rangeStart,
      vertical.rangeStep,
    );
  }

  /**
   * Pack and upload the geometry of any level not already holding it.
   *
   * The one place that writes a geometry buffer, and it skips a level whose
   * buffer already describes the units in force. A level holds four floats per
   * ping, so repacking every level on every call would put a megabyte of work
   * behind a colour limit change.
   */
  uploadGeometry(channels: number[]) {
    const layer = this.host.layer;
    if (!layer) return;
    const units = { x: this.host.xUnit, y: this.host.yUnit };
    for (const state of this.states.values()) {
      for (const channel of channels) {
        const packed = state.packed.get(channel);
        if (packed?.x === units.x && packed.y === units.y) continue;
        layer.setGeometry(this.plane(state.index), channel, this.geometryFor(state, channel));
        state.packed.set(channel, { ...units });
      }
    }
  }

  /**
   * Stamp every resident tile in frame.
   *
   * At every level and drawn from or not, because a tile still in frame is the
   * one thing retention promises to keep.
   */
  stamp(now: number) {
    for (const level of this.states.values()) {
      for (const resident of level.resident.values()) {
        if (this.inFrame(level, resident.tile)) resident.onScreenAt = now;
      }
    }
  }

  /**
   * Decide what draws, fetch what is missing.
   *
   * The view is divided into slots at the target level. Each slot resolves to
   * the finest level holding it, which is the slot's own tile once it arrives
   * and a range inside a coarser tile until then. The draws come back in plane
   * terms, which is what the layer stack is keyed by.
   */
  refresh(layers: Layer[], channels: number[]): SourceRefresh {
    const result: SourceRefresh = { draws: new Map(), onScreen: 0, blank: 0, standingIn: 0 };
    const state = this.state;
    const viewport = this.host.viewport;
    if (!state || !viewport) return result;
    const x = viewport.x;
    const y = viewport.y;
    const factors = this.factors;

    const onScreen = state.tiles.filter((tile) => {
      const box = state.boxes.get(tile.key);
      return box !== undefined && boxOverlaps(box, x, y);
    });
    result.onScreen = onScreen.length;

    this.scheduler.request(this.wants(state, onScreen, channels, factors));

    const clock = this.host.clock;
    for (const layer of layers) {
      // Every channel the layer reads, so a difference resolves to the finest
      // level holding both. One geometry buffer positions the quad, so two
      // tiles from different levels would be placed by one of their sidecars
      // and be wrong for the other.
      const wanted = channelsOf(layer);
      const context = {
        factors,
        tilePings: state.grid.tilePings,
        pingsAt: (level: number) => this.states.get(level)?.shape.pings ?? 0,
        resident: (level: number, row: number, column: number) =>
          wanted.every(
            (channel) =>
              this.states.get(level)?.resident.has(held(channel, `${row}:${column}`)) ??
              false,
          ),
      };
      const draws: SlotDraw[] = [];
      for (const tile of onScreen) {
        const slot = resolveSlot(tile, state.index, context);
        if (!slot) {
          result.blank += 1;
          continue;
        }
        if (slot.level !== state.index) result.standingIn += 1;
        const from = this.states.get(slot.level)!;
        for (const channel of wanted) {
          from.resident.get(held(channel, `${slot.row}:${slot.column}`))!.seen = clock;
        }
        draws.push({ ...slot, level: this.plane(slot.level) });
      }
      result.draws.set(layer.id, draws);
    }
    return result;
  }

  /**
   * The tiles worth holding, highest priority first.
   *
   * The footprint policy decides the shape of it, and this turns that into one
   * want per channel: two layers on one channel share a tile, which is what
   * makes a second colormap of the same frequency free.
   *
   * The footprint names levels as well as tiles. One not loaded is started
   * here and asked for on the refresh its load triggers, so the same policy
   * decides what is held and what is fetched.
   *
   * The pinned coarsest is appended rather than planned. It is not part of the
   * ladder around the target, it is the last thing standing between a viewport
   * and an empty panel, and where it is small enough it is held survey wide
   * rather than for the view.
   */
  private wants(
    state: LevelState,
    onScreen: Tile[],
    channels: number[],
    factors: number[],
  ): TileWant[] {
    if (!onScreen.length && !this.states.has(this.coarsest)) return [];
    const viewport = this.host.viewport!;
    const motion = this.host.motion;
    const rows = extent(onScreen.map((tile) => tile.row));
    const columns = extent(onScreen.map((tile) => tile.column));
    // The view measures speed in its own units. The ring is measured in source
    // pings, which this source converts to through its own cell width.
    const velocity =
      Math.sign(motion.velocity) *
      sourcePings(Math.abs(motion.velocity), state.spacing, state.factor);

    const tiles = onScreen.length
      ? plan({
          target: state.index,
          visible: { rows, columns },
          visiblePings: pingsOnScreen(state.axis, onScreen, viewport.x),
          levels: [...this.states.values()].map((level) => ({
            index: level.index,
            rows: level.grid.rows,
            columns: level.grid.columns,
          })),
          factors,
          tilePings: state.grid.tilePings,
          velocity,
          moving: motion.moving,
          depth: SUBSTITUTION_CAP,
          budget: this.footprintBudget(channels.length),
          tileBytes:
            state.grid.tilePings * state.grid.tileSamples * VALUE_BYTES * channels.length,
        })
      : [];

    const wants: TileWant[] = [];
    const missing = new Set<number>();
    for (const tile of tiles) {
      if (!this.states.has(tile.level)) {
        missing.add(tile.level);
        continue;
      }
      for (const channel of channels) wants.push({ ...tile, channel });
    }
    if (!motion.moving) this.wantedLevels = new Set(tiles.map((tile) => tile.level));
    for (const level of missing) this.loadWanted(level);

    const coarsest = this.states.get(this.coarsest);
    if (coarsest && coarsest !== state) {
      const survey = this.pinnable(coarsest, channels.length);
      for (const tile of coarsest.tiles) {
        const box = coarsest.boxes.get(tile.key);
        if (!survey && !(box && boxOverlaps(box, viewport.x, viewport.y))) continue;
        for (const channel of channels) {
          wants.push({
            level: this.coarsest,
            channel,
            row: tile.row,
            column: tile.column,
            priority: 'low',
          });
        }
      }
    }
    return wants;
  }

  /** Read one tile, in a worker where there is one. */
  private readTile(
    key: { level: number; channel: number; row: number; column: number },
    options: { signal: AbortSignal; priority: 'high' | 'low' },
  ): Promise<ChannelValues> {
    const state = this.states.get(key.level);
    if (!state) return Promise.reject(new Error(`level ${key.level} is not loaded`));
    const tile = tileAt(state.grid, key.row, key.column);
    this.chunks.tag(options.signal, options.priority);

    // Only where the worker can reopen the store for itself. A caller may pass
    // any ChunkStore, and one that fetches over something other than plain HTTP
    // cannot be rebuilt in a worker from a URL: it would silently become a
    // FetchStore against an address that means nothing to it.
    const href = this.reopenable ? this.chunks.href : undefined;
    const entry = this.store.multiscales.datasets[key.level];
    const decode = this.host.decode;
    if (decode && href) {
      return decode.read(
        {
          href,
          path: entry.path,
          valueName: this.store.multiscales.name,
          channel: key.channel,
          pings: tile.pings,
          samples: tile.texture,
          // Absent for a built store, which is float16 in the contract's axis
          // order. A plain dataset says what it actually is.
          order: state.level.source?.order,
          convert: state.level.source?.convert,
          priority: options.priority,
        },
        options.signal,
      );
    }
    return state.level.readWindow(key.channel, tile.pings, tile.texture, {
      signal: options.signal,
      priority: options.priority,
    });
  }

  /**
   * Whether a tile is held already, and a note that it is still wanted.
   *
   * Both, because they are the same question. The draw list only marks what it
   * actually draws, and the ring around the viewport is deliberately not drawn,
   * so without marking here every prefetched tile is the oldest thing in the
   * pool the moment it lands. Eviction would take it, the next frame's
   * footprint would ask for it again, and the ring would spend the link
   * fetching the same tiles over and over.
   */
  private stillWanted(key: {
    level: number;
    channel: number;
    row: number;
    column: number;
  }): boolean {
    if (this.queued.has(identify(key))) return true;
    const resident = this.states.get(key.level)?.resident.get(residentKey(key));
    if (!resident) return false;
    resident.seen = this.host.clock;
    return true;
  }

  /** Whether the builder already looked and found nothing in this tile. */
  private isEmpty(key: { level: number; channel: number; row: number; column: number }) {
    const state = this.states.get(key.level);
    const chunks = this.store.multiscales.datasets[key.level]?.chunks;
    if (!state || !this.summaries || !chunks) return false;
    const tile = tileAt(state.grid, key.row, key.column);
    return this.summaries.allNodata(key.level, key.channel, chunks, tile.pings, tile.texture);
  }

  /**
   * Queue a tile's upload.
   *
   * Not written here. A burst of tiles arrives together, because the requests
   * went out together and the link delivers them together, and every one of
   * them calling writeTexture in the same frame is the stutter section 4.5 is
   * about. The uploader spends a fixed number of bytes per frame.
   */
  private install(
    key: { level: number; channel: number; row: number; column: number },
    values: ChannelValues,
    priority: 'high' | 'low',
  ) {
    const generation = this.tileGeneration;
    const resident = residentKey(key);
    const pending = identify(key);
    this.queued.add(pending);
    this.host.uploader.queue({
      bytes: values.data.byteLength,
      priority,
      run: () => {
        this.queued.delete(pending);
        if (this.host.destroyed || generation !== this.tileGeneration) return;
        const state = this.states.get(key.level);
        if (!state || state.resident.has(resident)) return;

        const tile = tileAt(state.grid, key.row, key.column);
        const size = { samples: values.samples, pings: values.pings };
        const texture = this.host.context.pool.acquire(size.samples, size.pings);
        writeValues(this.host.context.device, texture, values.data, size);

        const view: TileView = {
          sampleSpan: [tile.samples[0], tile.samples[1] - tile.samples[0]],
          textureSpan: [tile.texture[0], size.samples],
          pingOffset: tile.pings[0],
          textureRows: texture.height,
        };
        state.resident.set(resident, {
          texture,
          channel: key.channel,
          tile: tile.key,
          view,
          seen: this.host.clock,
          onScreenAt: this.inFrame(state, tile.key) ? performance.now() : 0,
        });
        this.host.layer?.setTile(this.plane(state.index), key.channel, tile.key, texture, view);
      },
    });
  }

  /**
   * Resident tiles eviction may take, with what eviction orders them by.
   *
   * Nothing wanted this refresh is offered. The pinned coarsest level is
   * exempt: it is the last thing standing between a viewport and an empty
   * panel, and it is a megabyte or two.
   */
  spare(now: number, channels: number): Spare[] {
    const clock = this.host.clock;
    const spare: Spare[] = [];
    for (const state of this.states.values()) {
      if (state.index === this.coarsest && this.pinnable(state, channels)) continue;
      const distance = Math.abs(state.index - this.target);
      for (const [key, found] of state.resident) {
        if (found.seen === clock) continue;
        const idle = now - found.onScreenAt;
        spare.push({
          graced: idle < RETAIN_MS,
          distance,
          idle,
          release: () => this.release(state, key),
        });
      }
    }
    return spare;
  }

  /**
   * Bytes the footprint may cost in textures.
   *
   * This source's part of the pool's live share, less the pinned coarsest,
   * which is held whatever the footprint asks. Everything the footprint names
   * is wanted again on every refresh and so is never evicted, which is why it
   * has to fit: a footprint over the share is a pool held over its share for
   * as long as the view rests there, with nothing left for what retention
   * would keep.
   */
  private footprintBudget(channels: number): number {
    const coarsest = this.states.get(this.coarsest);
    const pinned =
      coarsest && this.pinnable(coarsest, channels)
        ? coarsest.shape.pings * coarsest.shape.samples * VALUE_BYTES * channels
        : 0;
    const share = this.host.context.pool.share / Math.max(1, this.host.sourceCount);
    return Math.max(0, share - pinned);
  }

  /**
   * Whether a level is small enough to hold for the whole survey.
   *
   * A deep pyramid reduces the coarsest level to a megabyte or two, which is
   * what makes pinning it free. A shallow one does not: two levels over 300,000
   * pings leaves a coarsest level of 150,000 by 1,000, which is 300 MB that
   * would never be evicted because it is the level that is never evicted.
   */
  private pinnable(state: LevelState, channels = 1): boolean {
    if (!this.pins) return false;
    // Counted across the channels the stack reads, because pinning a level
    // pins it for every one of them: three tinted frequencies is three times
    // the resident coarsest, and whether that fits is the question.
    const bytes = state.shape.pings * state.shape.samples * VALUE_BYTES * channels;
    return bytes <= this.host.context.pool.share / PIN_SHARE;
  }

  private release(state: LevelState, key: string) {
    const resident = state.resident.get(key);
    if (!resident) return;
    this.host.layer?.dropTile(this.plane(state.index), resident.channel, resident.tile);
    state.resident.delete(key);
    this.host.context.pool.release(resident.texture);
  }

  /** Let go of every level, as when the store is replaced or the device lost. */
  dropLevels(giveBack = true) {
    this.tileGeneration += 1;
    this.levelGeneration += 1;
    for (const state of this.states.values()) {
      // Not given back after a device loss. The pool those textures came from
      // has been destroyed and replaced, and handing one to the new pool is
      // handing it a texture it never allocated.
      for (const key of [...state.resident.keys()]) {
        if (giveBack) this.release(state, key);
        else state.resident.delete(key);
      }
      this.host.layer?.dropLevel(this.plane(state.index));
      this.scheduler.dropLevel(state.index);
    }
    this.scheduler.abortAll();
    this.queued.clear();
    this.states.clear();
    this.pending.clear();
    this.wantedLevels.clear();
    this.failedLevels.clear();
  }

  /**
   * Let go of the tiles of channels no layer reads any more.
   *
   * Not every channel: a stack that gains a fourth frequency keeps the three
   * it had, and a stack that changes a colormap changes no channel at all.
   */
  dropChannels(keep: number[]) {
    const wanted = new Set(keep);
    for (const state of this.states.values()) {
      for (const [key, resident] of [...state.resident]) {
        if (wanted.has(resident.channel)) continue;
        this.release(state, key);
      }
      for (const channel of [...state.packed.keys()]) {
        if (!wanted.has(channel)) state.packed.delete(channel);
      }
    }
  }

  /**
   * Hand every resident tile to a new layer stack.
   *
   * A new stack holds no buffers, so what a level had packed is gone and every
   * tile already resident is reinstalled rather than refetched.
   */
  reinstall(stack: LayerStack) {
    for (const state of this.states.values()) {
      state.packed.clear();
      for (const resident of state.resident.values()) {
        stack.setTile(
          this.plane(state.index),
          resident.channel,
          resident.tile,
          resident.texture,
          resident.view,
        );
      }
    }
  }

  /**
   * Forget failed reads and levels, so the next refresh asks again.
   *
   * A read that failed is not retried by a gesture, so changing any control
   * is what asks again.
   */
  retry() {
    for (const index of this.states.keys()) this.scheduler.retry(index);
    this.failedLevels.clear();
  }

  /**
   * Report any layer whose two channels cannot be differenced.
   *
   * A differing sample interval is not one of them: the shader reads the second
   * channel at the fragment's depth, so 200 kHz against 38 kHz resamples rather
   * than refusing. What is refused is a pair that does not describe the same
   * water, which would otherwise draw as an empty layer with no explanation.
   */
  alignmentProblems(layers: Layer[], problems: Map<string, AlignmentProblem>) {
    const state = this.someState;
    if (!state) return;
    for (const layer of layers) {
      if (layer.against === undefined) continue;
      const first = state.verticals.get(layer.channel);
      const second = state.verticals.get(layer.against);
      if (!first || !second) continue;
      const problem = checkAlignment(first, second, [
        this.channelName(layer.channel),
        this.channelName(layer.against),
      ]);
      if (problem) problems.set(layer.id, problem);
    }
  }

  /**
   * The cell of one channel drawn at a point, and its value.
   *
   * The level is the one a slot there draws from: the target where its tile
   * is resident, otherwise the finest coarser level that is, which is what
   * `resolveSlot` chooses. The value is read from the decoded tile in the
   * cache, so nothing is fetched and nothing is read back from the GPU.
   */
  probe(x: number, y: number, channel: number): CellProbe | undefined {
    const target = this.state;
    if (!target) return undefined;
    for (let index = target.index; index <= this.coarsest; index += 1) {
      const state = this.states.get(index);
      if (!state) continue;
      const ping = pingAt(state.axis, x);
      if (ping === undefined) continue;
      const geometry = verticalFor(
        this.host.yUnit,
        state.verticals.get(channel) ?? state.vertical,
      );
      const start = geometry.rangeStart[ping];
      const step = geometry.rangeStep[ping];
      if (!(step > 0)) continue;
      const sample = Math.round((y - start) / step);
      if (sample < 0 || sample >= state.shape.samples) return undefined;

      const row = Math.floor(ping / state.grid.tilePings);
      const column = columnOf(state.grid.tileSamples, state.grid.columns, sample);
      const key = held(channel, `${row}:${column}`);
      if (!state.resident.has(key)) continue;

      const tile = tileAt(state.grid, row, column);
      const resident = state.resident.get(key)!;
      const values = this.scheduler.peek({ level: index, channel, row, column });
      let value: number | null | undefined;
      if (values) {
        const at = (ping - tile.pings[0]) * values.samples + (sample - tile.texture[0]);
        const found = halfToNumber(values.data[at]);
        const threshold = this.store.multiscales.nodataThreshold;
        value = Number.isFinite(found) && found > threshold ? found : null;
      }
      return {
        level: index,
        factor: state.factor,
        ping,
        sample,
        x: [state.axis.left[ping], state.axis.right[ping]],
        y: [start + (sample - 0.5) * step, start + (sample + 0.5) * step],
        value,
        texel: {
          texture: resident.texture,
          x: sample - tile.texture[0],
          y: ping - tile.pings[0],
          held: () => state.resident.get(key)?.texture === resident.texture,
        },
      };
    }
    return undefined;
  }

  /** The resident tiles of one channel inside a rectangle, for statistics. */
  reduceInput(channel: number, x: Extent, y: Extent): ReduceInput | undefined {
    const state = this.state;
    const geometry = state && this.host.layer?.geometryBuffer(this.plane(state.index), channel);
    if (!state || !geometry) return undefined;
    const tiles: ReduceTile[] = [];
    for (const tile of state.tiles) {
      const box = state.boxes.get(tile.key);
      if (!box || !boxOverlaps(box, x, y)) continue;
      const resident = state.resident.get(held(channel, tile.key));
      if (!resident) continue;
      tiles.push({
        texture: resident.texture,
        sampleSpan: resident.view.sampleSpan,
        textureSpan: resident.view.textureSpan,
        pingOffset: resident.view.pingOffset,
        pings: resident.view.textureRows,
      });
    }
    if (!tiles.length) return undefined;
    return {
      geometry,
      tiles,
      pings: pingsWithin(state.axis, x) * state.factor,
      level: state.index,
    };
  }

  get status(): SourceStatus {
    let resident = 0;
    for (const state of this.states.values()) resident += state.resident.size;
    return {
      resident,
      loading: this.scheduler.inFlight,
      failed: this.scheduler.failures,
      skipped: this.scheduler.skipped,
      levelsHeld: this.states.size,
    };
  }

  /** Release everything this source holds. The store itself needs no closing. */
  destroy(giveBack = true) {
    this.dropLevels(giveBack);
  }
}
