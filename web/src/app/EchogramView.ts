/**
 * One echogram view.
 *
 * Holds a store, a channel and a viewport with two scales. The lifecycle is the
 * part meant to last: a container, a store, and a destroy that releases GPU
 * resources, because a host application opens and closes panels.
 *
 * Which level is drawn is an answer, not a setting. The viewport says how much
 * survey is on screen, that picks the coarsest level still holding a ping for
 * every pixel, and the level's tiles are fetched. A slot whose tile has not
 * arrived draws from the finest coarser level that has, and the coarsest level
 * is kept resident survey wide, so a viewport inside the data never draws
 * blank, only coarser.
 */

import {
  type ReduceTile,
  type RegionStatistics,
  type Histogram,
  DEFAULT_RANGE,
  Reducer,
  percentileLimits,
  statistics,
} from '../compute';
import { FetchStore } from '../data/FetchStore';
import type { ArrayCache } from '../data/cache';
import { type DecodePool, type SpawnWorker, createDecodePool } from '../data/decode';
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
import { type Summaries, loadSummaries } from '../data/summaries';
import { Uploader } from '../data/uploader';
import type { GpuContext } from '../device/context';
import type { TexturePool } from '../device/texturePool';
import { writeValues } from '../device/textures';
import {
  type AxisContext,
  type XUnit,
  type YUnit,
  assertXUnit,
  assertYUnit,
  validXUnits,
  validYUnits,
  xAxisLabel,
  yAxisLabel,
} from '../geometry/axes';
import {
  type Extent,
  type VerticalGeometry,
  type XAxisValues,
  type XSource,
  buildXAxis,
  clipMatrix,
  medianSpacing,
  rangeToSample,
  remapRange,
  sampleToRange,
  verticalExtent,
  verticalFor,
} from '../geometry/coords';
import {
  type SlotDraw,
  PIXELS_PER_PING,
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
import {
  type ResolvedWindow,
  type WindowRequest,
  resolveWindow,
} from '../geometry/window';
import { NODATA_COLOR } from '../render/colormaps';
import {
  type LayerPass,
  type TileView,
  LayerStack,
  packGeometry,
} from '../render/drawLayer';
import { attachInteraction } from './interaction';
import { type AlignmentProblem, checkAlignment } from './alignment';
import {
  type Layer,
  type LayerSpec,
  VALUE_CLIM,
  channelsOf,
  channelsUsed,
  drawn,
  resolveLayers,
} from './layers';
import { type ViewSettings, SETTINGS_VERSION, copySettings } from './settings';
import { type AspectMode, Viewport, fitAll } from './viewport';

/** Level chosen from the view rather than named. */
export type LevelChoice = number | 'auto';

export interface EchogramViewOptions {
  container: HTMLElement;
  context: GpuContext;
  /** Page background, seen outside the data extent. */
  background?: GPUColorDict;
  /** Reports failures that happen outside a call, such as device loss. */
  onError?: (error: unknown) => void;
  /** Called when a gesture moves the view, so a host can update its readouts. */
  onViewChange?: () => void;
  /**
   * How to start a decode worker, for a host with its own bundler.
   *
   * The built in one is resolved against this project's build. A copy of this
   * library inside another application is compiled by that application's
   * bundler, which has its own idea of where the worker file ends up, so an
   * embedding host supplies its own. Leaving it out is not an error: without a
   * worker the tiles decode on the main thread and only the frame time suffers.
   */
  spawnWorker?: SpawnWorker;
  /** Decode workers to run. More than the link can feed is queue, not speed. */
  decodeWorkers?: number;
}

export interface SetStoreOptions {
  /** A level to hold, or 'auto' to take it from the view. */
  level?: LevelChoice;
  /**
   * Device pixels wanted per drawn ping, which is what 'auto' aims for.
   *
   * One draws a ping to a pixel, which is the finest the screen can show and
   * what the pyramid is built to serve. Above one the view coarsens sooner,
   * trading a wider cell for fewer of them.
   */
  pixelsPerPing?: number;
  /**
   * The stack, bottom first. Replaces whatever was there.
   *
   * The single layer options below describe the base layer and are what a
   * one channel view needs; naming a stack supersedes them.
   */
  layers?: LayerSpec[];
  channel?: number;
  colormap?: string;
  clim?: [number, number];
  opacity?: number;
  /** How the value texture is sampled between texels. See DEFAULT_FILTER. */
  filter?: GPUFilterMode;
  xUnit?: XUnit;
  yUnit?: YUnit;
  aspect?: { mode: AspectMode; exaggeration?: number; hold?: 'x' | 'y' };
  /** Open at a window. The attained extent comes back through info. */
  window?: WindowRequest;
  /** Show the whole level, adopting the factor the fit implies. */
  fit?: boolean;
}

/** What is on screen and what is still on its way there. */
export interface TileStatus {
  rows: number;
  columns: number;
  /** Slots the view is divided into at the target level. */
  slots: number;
  /** Slots drawing from a coarser level than the target. */
  standingIn: number;
  /** Slots with nothing to draw at all, which pinning should keep at zero. */
  blank: number;
  resident: number;
  loading: number;
  /** Tiles a read failed on, which are not asked for again until told to. */
  failed: number;
  /** Tiles never requested because the store says they hold nothing. */
  skipped: number;
  /** Tiles read and waiting for a frame with upload budget left in it. */
  uploading: number;
  /** Decoded tiles held, which an evicted texture is rebuilt from. */
  cachedBytes: number;
  /**
   * Rolling cost of encoding one redraw, in milliseconds.
   *
   * The processor side only. What the GPU then takes is not readable without a
   * timestamp query, so this measures the part a tile count actually drives:
   * whether a pan is rebuilding command streams or replaying one.
   */
  redrawMs: number;
}

export interface ViewInfo {
  levels: number;
  /** The level being drawn, which 'auto' resolves to. */
  level: number;
  /** Device pixels wanted per drawn ping. */
  pixelsPerPing: number;
  /** What was asked for, so a host can show whether it is choosing. */
  levelChoice: LevelChoice;
  /** Source pings merged into one at the level being drawn. */
  factor: number;
  channels: number;
  channel: number;
  /** Names for the channels, where the store carries them. */
  channelNames?: string[];
  /** Nominal frequency per channel in hertz, which names a layer best. */
  channelFrequencies?: number[];
  /** The stack as resolved, which is what the legend and controls describe. */
  layers: Layer[];
  /** Layers left out because their two channels cannot be differenced. */
  problems: { layer: string; message: string }[];
  pings: number;
  samples: number;
  valueName: string;
  verticalRef: string;
  xUnit: XUnit;
  yUnit: YUnit;
  xLabel: string;
  yLabel: string;
  validX: XUnit[];
  validY: YUnit[];
  x: Extent;
  y: Extent;
  aspect: AspectMode;
  exaggeration: number;
  /** True scale means nothing without a physical ratio between the axes. */
  trueScaleAvailable: boolean;
  /** Whole data extent in the current units, which a window sits inside. */
  bounds: { x: Extent; y: Extent };
  window?: ResolvedWindow;
  tiles: TileStatus;
}

const DEFAULT_COLORMAP = 'viridis';

/**
 * One cell is one measurement, and interpolating between cells invents
 * structure that is not in the data. matplotlib magnifies with nearest for the
 * same reason, so this is also what keeps the viewer comparable to the existing
 * figures.
 */
const DEFAULT_FILTER: GPUFilterMode = 'nearest';

/** Bytes one value occupies, which is what r16float means. */
const VALUE_BYTES = 2;

/** Share of what the pool holds live that a survey wide pin may take. */
const PIN_SHARE = 4;

/** Percentiles auto contrast clips to, which is what FR-18 sets limits from. */
const CONTRAST: [number, number] = [0.02, 0.98];

/**
 * Milliseconds of stillness that count as having stopped.
 *
 * Long enough that the gaps between pointer events inside one drag do not read
 * as rests, short enough that letting go feels like it began loading at once.
 */
const SETTLE_MS = 140;

/** The settings that persist between calls, as opposed to the one shot ones. */
interface Settings {
  level: LevelChoice;
  pixelsPerPing: number;
  /** The base layer's channel, and what a single channel view means by it. */
  channel: number;
  colormap: string;
  clim: [number, number];
  opacity: number;
  filter: GPUFilterMode;
  xUnit: XUnit;
  yUnit: YUnit;
  layers: Layer[];
}

/** One level, everything derived from it, and what it currently holds. */
interface LevelState {
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

export interface StatisticsRequest {
  /** Which channel to measure. Defaults to the bottom layer's. */
  channel?: number;
  /** The rectangle, in the units on screen. Defaults to the whole view. */
  x?: Extent;
  y?: Extent;
  bins?: number;
}

export interface ViewStatistics extends RegionStatistics {
  histogram: Histogram;
  channel: number;
  /** The level measured, since the numbers describe its cells and not the source. */
  level: number;
}

/** Source pings whose cell centre falls inside a range. */
function pingsWithin(axis: XAxisValues, x: Extent): number {
  let inside = 0;
  for (let i = 0; i < axis.centre.length; i += 1) {
    if (axis.centre[i] >= x[0] && axis.centre[i] <= x[1]) inside += 1;
  }
  return inside;
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

interface Resident {
  texture: GPUTexture;
  /** Which channel's values it holds, and which tile, since the key joins both. */
  channel: number;
  tile: string;
  /** Kept so a rebuilt layer can be refilled without refetching anything. */
  view: TileView;
  /** When this tile was last wanted, for choosing what to drop. */
  seen: number;
}

export class EchogramView {
  readonly canvas: HTMLCanvasElement;

  private context: GpuContext;
  private surface: GPUCanvasContext;
  private background: GPUColorDict;
  private onError?: (error: unknown) => void;
  private onViewChange?: () => void;
  private observer: ResizeObserver;
  private unwatchDevice: () => void;
  private detach: () => void;
  private destroyed = false;

  private store?: EchogramStore;
  private viewport?: Viewport;
  private window?: ResolvedWindow;

  /** The shared pool and cache, which outlive this view. See GpuContext. */
  private get pool(): TexturePool {
    return this.context.pool;
  }
  private get cache(): ArrayCache<ChannelValues> {
    return this.context.tiles;
  }
  private layer?: LayerStack;
  private reducer?: Reducer;

  /**
   * The data path, in the order bytes travel it.
   *
   * The store the requests go through, a worker pool that decodes them off the
   * main thread, a cache of what came back, a scheduler that decides what is
   * worth asking for, and an uploader that spreads the writes across frames.
   * Section 4.5 is the whole of that: bandwidth is not the only cost between
   * object storage and a drawn pixel.
   */
  private chunks?: PriorityStore;
  private decode?: DecodePool;
  private scheduler?: TileScheduler<ChannelValues>;
  private uploader: Uploader;
  private summaries?: Summaries;
  /** Whether the store is one a decode worker can open again from its URL. */
  private reopenable = false;
  private frameHandle = 0;

  /**
   * Tiles read and queued for upload but not yet written.
   *
   * Counted as held, or the scheduler delivers them again on the next pointer
   * move: they are in the cache and not yet resident, which is exactly the
   * state a cache hit is for. Without this a drag queues the same tile once per
   * frame and the duplicates spend the upload budget the real tiles needed.
   */
  private queued = new Set<string>();

  /**
   * How fast the view is moving, and whether it still is.
   *
   * Both are policy inputs rather than measurements for their own sake: the
   * ring reaches further ahead at speed, and the target level is not asked for
   * until the motion settles.
   */
  private motion = { at: 0, centre: 0, velocity: 0, moving: false };
  private settleTimer?: ReturnType<typeof setTimeout>;

  /** Loaded levels by index. The target and the pinned coarsest at least. */
  private states = new Map<number, LevelState>();
  /** Loads in flight, so a zoom does not start one level load per pointer move. */
  private pending = new Map<number, Promise<LevelState>>();
  private target = 0;
  private coarsest = 0;
  private passes: LayerPass[] = [];
  private slots = 0;
  private blank = 0;
  private standingIn = 0;
  private problems = new Map<string, AlignmentProblem>();
  private clock = 0;
  private redrawMs = 0;

  /** A store just opened, so selections carried from the last one may not fit. */
  private fresh = false;

  private settings: Settings = {
    level: 'auto',
    pixelsPerPing: PIXELS_PER_PING,
    channel: 0,
    colormap: DEFAULT_COLORMAP,
    clim: [...VALUE_CLIM],
    opacity: 1,
    filter: DEFAULT_FILTER,
    xUnit: 'pings',
    yUnit: 'meters',
    layers: [],
  };

  /** Bumped by every call, so a slower earlier call cannot install its result. */
  private generation = 0;

  /** Bumped only when tiles stop meaning anything, which a colormap does not. */
  private tileGeneration = 0;

  /** Bumped when every level is dropped, so a load in flight cannot install. */
  private levelGeneration = 0;

  constructor(options: EchogramViewOptions) {
    this.context = options.context;
    this.background = options.background ?? { r: 0, g: 0, b: 0, a: 1 };
    this.onError = options.onError;
    this.onViewChange = options.onViewChange;

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    options.container.appendChild(this.canvas);

    const surface = this.canvas.getContext('webgpu');
    if (!surface) throw new Error('canvas.getContext("webgpu") returned null');
    this.surface = surface;
    this.configure();
    this.uploader = new Uploader({ onQueued: () => this.scheduleFrame() });
    // Undefined where a worker cannot run, and every caller has a main thread
    // path, so the only thing lost is the frame time it was there to save.
    this.decode = createDecodePool(options.decodeWorkers, options.spawnWorker);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(options.container);
    this.unwatchDevice = this.context.onDeviceLost((error) => {
      if (error) {
        this.onError?.(error);
        return;
      }
      this.rebuild().catch((failure) => this.onError?.(failure));
    });
    this.detach = attachInteraction({
      element: this.canvas,
      viewport: () => this.viewport,
      onChange: () => this.moved(),
    });
    this.resize();
  }

  /** Open a store and draw one channel. */
  async setStore(source: string | ChunkStore, options: SetStoreOptions = {}) {
    const source_ = typeof source === 'string' ? new FetchStore(source) : source;
    const chunks = new PriorityStore(source_);
    this.reopenable = source_ instanceof FetchStore;
    const store = await openEchogramStore(chunks);
    if (this.destroyed) return;
    this.store = store;
    this.chunks = chunks;
    this.viewport = undefined;
    this.window = undefined;
    this.dropLevels();
    this.uploader.clear();
    this.queued.clear();
    this.scheduler = new TileScheduler<ChannelValues>({
      cache: this.cache,
      // The cache belongs to the context and every view reads it, so what
      // separates this store's tiles from another's has to be in the key.
      namespace: chunks.href ?? 'store',
      hooks: {
        read: (key, options) => this.readTile(key, options),
        weigh: (values) => values.data.byteLength,
        deliver: (key, values, priority) => this.install(key, values, priority),
        held: (key) => this.stillWanted(key),
        empty: (key) => this.isEmpty(key),
        onError: (error) => this.onError?.(error),
      },
    });
    // Only ever removes work, so a store without the sidecar simply asks for
    // every chunk and nothing about this is conditional on it arriving.
    this.summaries = store.summaryPath
      ? await loadSummaries(chunks, store.summaryPath)
      : undefined;
    if (this.destroyed) return;
    // The stack holds the nodata threshold, which belongs to the store that
    // was open when it was built.
    this.layer?.destroy();
    this.layer = undefined;
    this.coarsest = store.levelCount - 1;
    this.target = this.coarsest;
    // A channel, unit or layer from the last store may not exist in this one,
    // and a stack naming channels this store does not have would ask for reads
    // that cannot be served.
    this.settings = { ...this.settings, level: 'auto', channel: 0, layers: [] };
    this.fresh = true;
    await this.setOptions(options);
  }

  /**
   * Change what is shown without reopening the store.
   *
   * Only what changed is rebuilt: limits and opacity write the params buffer,
   * an axis unit repacks the geometry buffers, a colormap builds a table, and a
   * channel reloads every level.
   */
  async setOptions(options: SetStoreOptions) {
    const store = this.store;
    if (!store) throw new Error('no store: call setStore first');
    const previous = this.settings;
    const next: Settings = { ...previous, ...options, layers: previous.layers };
    next.layers = this.resolveStack(options, previous, next);
    const generation = (this.generation += 1);
    const current = () => generation === this.generation && !this.destroyed;

    // Tiles are per channel, so a stack that reads a channel nothing read
    // before has nothing resident for it. Only the channels that went away are
    // dropped; the ones that stayed keep everything they hold.
    this.dropChannels(channelsUsed(next.layers));

    // The coarsest level is what opens the view and what stands in for
    // everything else, so it is loaded before anything asks a question that
    // needs an axis.
    const pinned = await this.ensureLevel(this.coarsest, next.channel);
    if (!current()) return;

    if (this.fresh) {
      // Carried over rather than asked for, so adjust it instead of refusing.
      if (!validXUnits(pinned.context).includes(next.xUnit)) next.xUnit = 'pings';
      if (!validYUnits(pinned.context).includes(next.yUnit)) next.yUnit = 'meters';
      this.fresh = false;
    }
    assertXUnit(next.xUnit, pinned.context);
    assertYUnit(next.yUnit, pinned.context);

    if (!this.layer) {
      this.buildStack();
      if (!current()) return;
    }

    const unitsChanged =
      next.xUnit !== previous.xUnit || next.yUnit !== previous.yUnit;
    const wasAxis = this.state?.axis;
    const wasUnits = { x: previous.xUnit, y: previous.yUnit };
    this.settings = next;
    if (unitsChanged) this.replaceAxes();

    if (!this.viewport) {
      this.resetViewport();
    } else if (unitsChanged) {
      // A unit change is a change of label, not of subject, so it re-expresses
      // the picture rather than reshaping it. A level change needs nothing:
      // every axis counts source pings, seconds or metres, not level indices.
      this.reexpress(wasUnits, next, wasAxis);
    }
    if (options.fit) this.viewport!.reframe(this.xBounds, this.yBounds);
    if (options.aspect) this.applyAspect(options.aspect);
    if (options.window) this.applyWindow(options.window);
    // The note describes the last window asked for. Once anything else moves
    // the view it no longer describes what is on screen.
    else this.window = undefined;

    // A read that failed is not retried by a gesture, so changing any control
    // is what asks again.
    for (const index of this.states.keys()) this.scheduler?.retry(index);
    // Checked after the levels are loaded, since the answer comes from the
    // sidecars. A layer that cannot be differenced is left out of the stack
    // rather than drawn empty, and named through info so a host can say why.
    this.problems = this.alignmentProblems(next.layers);
    await this.applyLayers(
      next.layers.filter((layer) => !this.problems.has(layer.id)),
    );
    if (!current()) return;
    await this.retarget(generation);
    if (!current()) return;

    this.uploadGeometry();
    this.applyView();
    this.refreshTiles();
    this.render();
  }

  /**
   * Work out the stack this call asks for.
   *
   * Naming layers replaces the stack. Naming none keeps the one that is there
   * and rewrites its base layer from the single channel options, so a view that
   * never mentions layers behaves as it always did and one that does is not
   * quietly overruled by a colormap setting it did not send.
   */
  private resolveStack(
    options: SetStoreOptions,
    previous: Settings,
    next: Settings,
  ): Layer[] {
    if (options.layers) {
      return this.clampChannels(resolveLayers(options.layers, this.layerDefaults(next)));
    }
    const base: LayerSpec[] = previous.layers.length
      ? previous.layers.map((layer) => ({ ...layer }))
      : [{ channel: next.channel }];
    const touched =
      options.channel !== undefined ||
      options.colormap !== undefined ||
      options.clim !== undefined ||
      options.opacity !== undefined ||
      options.filter !== undefined;
    if (touched) {
      base[0] = {
        ...base[0],
        channel: next.channel,
        color: options.colormap !== undefined ? { colormap: next.colormap } : base[0].color,
        clim: options.clim !== undefined ? next.clim : base[0].clim,
        opacity: options.opacity !== undefined ? next.opacity : base[0].opacity,
        filter: options.filter !== undefined ? next.filter : base[0].filter,
      };
    }
    return this.clampChannels(resolveLayers(base, this.layerDefaults(next)));
  }

  /**
   * Hold every layer to a channel the store has.
   *
   * A stack outlives the store it was built against, through a saved
   * configuration or a controls panel that was not redrawn. Clamping here means
   * a channel that is gone draws the last one instead of failing every tile
   * read for it one at a time.
   */
  private clampChannels(layers: Layer[]): Layer[] {
    const count = this.someState?.level.channels;
    if (!count) return layers;
    return layers.map((layer) =>
      layer.channel < count
        ? layer
        : { ...layer, channel: count - 1 },
    );
  }

  private layerDefaults(settings: Settings) {
    return {
      color: { colormap: settings.colormap },
      clim: settings.clim,
      opacity: settings.opacity,
      filter: settings.filter,
    };
  }

  /** Hand the stack to the renderer, which is what compiles what it needs. */
  private async applyLayers(layers: Layer[]) {
    if (!this.layer) return;
    await this.layer.setLayers(layers);
  }

  /**
   * Report any layer whose two channels cannot be differenced.
   *
   * A differing sample interval is not one of them: the shader reads the second
   * channel at the fragment's depth, so 200 kHz against 38 kHz resamples rather
   * than refusing. What is refused is a pair that does not describe the same
   * water, which would otherwise draw as an empty layer with no explanation.
   */
  private alignmentProblems(layers: Layer[]): Map<string, AlignmentProblem> {
    const problems = new Map<string, AlignmentProblem>();
    const state = this.someState;
    if (!state) return problems;
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
    return problems;
  }

  private channelName(channel: number): string {
    const frequency = this.store?.multiscales.channelFrequencies?.[channel];
    if (frequency) return `${Math.round(frequency / 1000)} kHz`;
    return this.store?.multiscales.channelNames?.[channel] ?? `channel ${channel}`;
  }

  /**
   * Statistics over a rectangle, from the tiles already resident.
   *
   * Defaults to what is on screen. The numbers describe the level being drawn,
   * so at a coarse level they count coarse cells, each already a linear mean of
   * the source samples it merged. That is the honest answer to a question about
   * what is visible, and it is not the same number a full resolution pass over
   * the same rectangle would give.
   *
   * Exposed rather than presented, per FR-19: what a host does with a mean and
   * a NASC is the host's business.
   */
  async statistics(options: StatisticsRequest = {}): Promise<ViewStatistics | undefined> {
    const state = this.state;
    if (!state || !this.viewport || !this.layer || !this.store) return undefined;
    const channel = options.channel ?? this.settings.layers[0]?.channel ?? 0;
    const geometry = this.layer.geometryBuffer(state.index, channel);
    if (!geometry) return undefined;

    const x = options.x ?? this.viewport.x;
    const y = options.y ?? this.viewport.y;
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

    this.reducer ??= new Reducer(this.context);
    const result = await this.reducer.run({
      geometry,
      tiles,
      x,
      y,
      range: this.histogramRange(),
      nodata: this.store.multiscales.nodataThreshold,
      bins: options.bins,
    });
    if (!result) return undefined;

    // The depth integral is averaged over the pings the rectangle spans, which
    // the axis knows and the device does not.
    const pings = pingsWithin(state.axis, x) * state.factor;
    return {
      ...statistics(result, pings),
      histogram: result.histogram,
      channel,
      level: state.index,
    };
  }

  /**
   * Set every layer's limits from percentiles of its own channel.
   *
   * Per channel and not once for the stack, because FR-9 gives each layer its
   * own limits and two frequencies of the same water do not share a
   * distribution. A channel with nothing resident keeps the limits it had.
   */
  async autoContrast(
    low = CONTRAST[0],
    high = CONTRAST[1],
  ): Promise<[number, number] | undefined> {
    const limits = new Map<number, [number, number]>();
    for (const channel of channelsUsed(this.settings.layers)) {
      const found = await this.statistics({ channel });
      const range = found && percentileLimits(found.histogram, low, high);
      if (range) limits.set(channel, range);
    }
    if (!limits.size) return undefined;

    const layers = this.settings.layers.map((layer) => ({
      ...layer,
      clim: limits.get(layer.channel) ?? layer.clim,
    }));
    await this.setOptions({ layers });
    return limits.get(this.settings.layers[0]?.channel ?? 0);
  }

  /** Where the histogram starts and stops, from the store where it says. */
  private histogramRange(): [number, number] {
    const range = this.store?.multiscales.histRange;
    return range && range.length === 2 ? [range[0], range[1]] : [...DEFAULT_RANGE];
  }

  /** Change the horizontal unit, which touches geometry and nothing else. */
  async setAxis(unit: XUnit) {
    await this.setOptions({ xUnit: unit });
  }

  /**
   * Move the viewport, in the units currently on screen.
   *
   * The linking primitive. A gesture in one panel reports its extent, and every
   * panel linked to it is told the same rectangle, so all of them move together
   * without any of them owning the others. Silent about it: this does not call
   * onViewChange, or two linked panels would answer each other forever.
   */
  setViewport(x: Extent, y: Extent) {
    if (!this.viewport) return;
    this.viewport.reframe(x, y);
    this.viewport.clampInto(this.xBounds, this.yBounds);
    this.window = undefined;
    this.applyView();
    this.refreshTiles();
    this.render();
    const generation = this.generation;
    if (this.wantedLevel() !== this.target) {
      void this.retarget(generation)
        .then(() => {
          if (generation !== this.generation || this.destroyed) return;
          this.uploadGeometry();
          this.refreshTiles();
          this.render();
        })
        .catch((error) => this.onError?.(error));
    }
  }

  /**
   * Everything a second panel needs to show the same thing.
   *
   * Configuration only, per settings.ts: what is resident and which level is
   * drawn are answers the receiving view works out for itself from its own
   * panel size.
   */
  get settingsObject(): ViewSettings | undefined {
    if (!this.store) return undefined;
    const { settings, viewport } = this;
    return copySettings({
      version: SETTINGS_VERSION,
      store: this.chunks?.href,
      layers: settings.layers,
      level: settings.level,
      pixelsPerPing: settings.pixelsPerPing,
      colormap: settings.colormap,
      filter: settings.filter as 'nearest' | 'linear',
      xUnit: settings.xUnit,
      yUnit: settings.yUnit,
      aspect: {
        mode: viewport?.mode ?? 'free',
        exaggeration: viewport?.exaggeration ?? 1,
      },
      window: viewport ? { x: [...viewport.x], y: [...viewport.y] } : undefined,
    });
  }

  /**
   * Adopt a configuration, opening its store first where that is not the one
   * already open.
   */
  async applySettings(settings: ViewSettings) {
    const wanted = settings.store;
    if (wanted && wanted !== this.chunks?.href) await this.setStore(wanted);
    if (this.destroyed) return;
    await this.setOptions({
      layers: settings.layers,
      level: settings.level,
      pixelsPerPing: settings.pixelsPerPing,
      colormap: settings.colormap,
      filter: settings.filter,
      xUnit: settings.xUnit as XUnit,
      yUnit: settings.yUnit as YUnit,
      aspect: {
        mode: settings.aspect.mode,
        exaggeration: settings.aspect.exaggeration,
      },
      // As a window rather than through setViewport, because the units may
      // have changed with it and the extent is expressed in the new ones.
      window: settings.window
        ? {
            x: { min: settings.window.x[0], max: settings.window.x[1] },
            y: { min: settings.window.y[0], max: settings.window.y[1] },
          }
        : undefined,
    });
  }

  get info(): ViewInfo | undefined {
    const state = this.state;
    if (!this.store || !state || !this.viewport) return undefined;
    const { settings } = this;
    return {
      levels: this.store.levelCount,
      level: state.index,
      levelChoice: settings.level,
      pixelsPerPing: settings.pixelsPerPing,
      factor: state.factor,
      channels: state.level.channels,
      channel: settings.channel,
      channelNames: this.store.multiscales.channelNames,
      channelFrequencies: this.store.multiscales.channelFrequencies,
      layers: settings.layers,
      problems: [...this.problems].map(([layer, problem]) => ({
        layer,
        message: problem.message,
      })),
      pings: state.shape.pings,
      samples: state.shape.samples,
      valueName: this.store.multiscales.name,
      verticalRef: this.store.multiscales.verticalRef,
      xUnit: settings.xUnit,
      yUnit: settings.yUnit,
      xLabel: xAxisLabel(settings.xUnit, state.context),
      yLabel: yAxisLabel(settings.yUnit, state.context),
      validX: validXUnits(state.context),
      validY: validYUnits(state.context),
      x: this.viewport.x,
      y: this.viewport.y,
      aspect: this.viewport.mode,
      exaggeration: this.viewport.exaggeration,
      trueScaleAvailable: settings.xUnit === 'meters' && settings.yUnit === 'meters',
      bounds: { x: this.xBounds, y: this.yBounds },
      window: this.window,
      tiles: {
        rows: state.grid.rows,
        columns: state.grid.columns,
        slots: this.slots,
        standingIn: this.standingIn,
        blank: this.blank,
        resident: this.count((s) => s.resident.size),
        loading: this.scheduler?.inFlight ?? 0,
        failed: this.scheduler?.failures ?? 0,
        skipped: this.scheduler?.skipped ?? 0,
        uploading: this.uploader.pending,
        cachedBytes: this.cache.size,
        redrawMs: this.redrawMs,
      },
    };
  }

  render() {
    if (!this.layer || this.destroyed) return;
    const started = performance.now();
    const encoder = this.context.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.surface.getCurrentTexture().createView(),
          clearValue: this.background,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    this.layer.draw(pass);
    pass.end();
    this.context.device.queue.submit([encoder.finish()]);
    // Smoothed, because one redraw either records the bundle or replays it and
    // the two differ by an order of magnitude.
    this.redrawMs = this.redrawMs * 0.9 + (performance.now() - started) * 0.1;
  }

  destroy() {
    this.destroyed = true;
    this.generation += 1;
    this.tileGeneration += 1;
    this.observer.disconnect();
    this.unwatchDevice();
    this.detach();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.scheduler?.abortAll();
    this.decode?.destroy();
    this.uploader.clear();
    this.queued.clear();
    // Released, not destroyed. The pool and the cache belong to the context and
    // outlive this view, so what closing a panel has to do is hand back every
    // texture it took: NFR-18 is that N panels opened and closed leave the
    // allocation where it started.
    this.dropLevels();
    this.layer?.destroy();
    this.reducer?.destroy();

    this.surface.unconfigure();
    this.canvas.remove();
    this.layer = undefined;
    this.states.clear();
  }

  /** The level being drawn. */
  private get state(): LevelState | undefined {
    return this.states.get(this.target);
  }

  /**
   * A level to answer from when the target has not loaded yet.
   *
   * The extent, the axis and the vertical geometry are the same survey at every
   * level, so any loaded level answers them, and the pinned coarsest is always
   * one of them.
   */
  private get anyState(): LevelState {
    return this.state ?? this.states.get(this.coarsest)!;
  }

  /** Any loaded level, or none while the first one is still on its way. */
  private get someState(): LevelState | undefined {
    return this.state ?? this.states.get(this.coarsest);
  }

  private count(of: (state: LevelState) => number): number {
    let total = 0;
    for (const state of this.states.values()) total += of(state);
    return total;
  }

  private configure() {
    this.surface.configure({
      device: this.context.device,
      format: this.context.format,
      alphaMode: 'opaque',
    });
  }

  /**
   * Load a level, or return the one already loaded.
   *
   * Reads the sidecars and the shape. The values themselves arrive a tile at a
   * time, so opening a level costs a few small arrays whatever its size.
   */
  private ensureLevel(index: number, channel: number): Promise<LevelState> {
    const held = this.states.get(index);
    if (held) return Promise.resolve(held);
    const started = this.pending.get(index);
    if (started) return started;

    const load = this.loadLevel(index, channel);
    this.pending.set(index, load);
    load.catch(() => undefined).then(() => this.pending.delete(index));
    return load;
  }

  private async loadLevel(index: number, channel: number): Promise<LevelState> {
    const store = this.store!;
    const stamp = this.levelGeneration;
    const level = await store.level(index);
    if (channel < 0 || channel >= level.channels) {
      throw new Error(`channel ${channel} outside 0 to ${level.channels - 1}`);
    }
    const shape = { pings: level.pings, samples: level.samples };
    // Every channel, not only the one asked for. The sidecar is one array for
    // the whole level and is read whole either way, so slicing the rest of it
    // costs nothing and a layer added later needs no second read.
    const verticals = new Map<number, VerticalGeometry>();
    for (let index = 0; index < level.channels; index += 1) {
      const geometry = await level.geometry(index);
      verticals.set(index, { ...geometry, samples: shape.samples });
    }
    const vertical = spanChannels(verticals, shape.samples);

    const pingTime = await level.readSidecar('ping_time');
    if (!pingTime) throw new Error(`level ${index} has no ping_time sidecar`);
    const xDistance = await level.readSidecar('x_distance');
    const binStart = await level.readSidecar('bin_ping_start');
    const binEnd = await level.readSidecar('bin_ping_end');

    const multiscales = store.multiscales;
    const context: AxisContext = {
      dataType: multiscales.dataType,
      verticalRef: multiscales.verticalRef,
      hasGps: Boolean(xDistance),
      pingSpan:
        binStart && binEnd ? [binStart[0], binEnd[binEnd.length - 1]] : undefined,
    };

    const factor = level.entry.factors.ping ?? 1;
    const source: XSource = { pingTime, xDistance, factor };
    const axis = buildXAxis(this.settings.xUnit, source);
    const grid = planTiles(shape, {
      maxDimension: this.context.limits.maxTextureDimension2D,
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
    if (this.destroyed || stamp !== this.levelGeneration) return state;

    this.states.set(index, state);
    return state;
  }

  /**
   * Choose the level from the view and load it, keeping what is still useful.
   *
   * The level being replaced is kept while the new one loads, so a zoom refines
   * from what was on screen rather than dropping to the pinned coarsest.
   */
  private async retarget(generation: number) {
    const previous = this.target;
    const wanted = this.wantedLevel();
    // Loaded, not merely unchanged. A channel change drops every level and
    // reloads only the pinned coarsest, so the level the view is already
    // sitting on is the one that has to be asked for again, and it is exactly
    // the one an unchanged answer would skip.
    if (wanted !== previous || !this.states.has(wanted)) {
      await this.ensureLevel(wanted, this.settings.channel);
      if (generation !== this.generation || this.destroyed) return;
      this.target = wanted;
    }
    const fallbacks = this.fallbacks();
    this.syncLevels(new Set([this.target, previous, this.coarsest, ...fallbacks]));

    // Not awaited. These are what a slot stands on while the target's own
    // tiles are in flight, and waiting for them would put the fallback in
    // front of the thing it is covering for.
    for (const level of fallbacks) {
      if (this.states.has(level)) continue;
      void this.ensureLevel(level, this.settings.channel)
        .then(() => {
          if (generation !== this.generation || this.destroyed) return;
          this.refreshTiles();
        })
        .catch((error) => this.onError?.(error));
    }
  }

  /**
   * The coarser levels held alongside the target.
   *
   * The pyramid is a latency ladder as well as a resolution one. Each of these
   * covers about twice the water of the one below for the same bytes, so a
   * viewport that moves has something to draw before its own level arrives.
   * Capped where substitution is capped, since a level a slot would refuse to
   * stand on is bytes spent on nothing.
   */
  private fallbacks(): number[] {
    const out: number[] = [];
    for (let step = 1; step <= SUBSTITUTION_CAP; step += 1) {
      const level = this.target + step;
      if (level >= this.store!.levelCount || level === this.coarsest) break;
      out.push(level);
    }
    return out;
  }

  /** What the view asks for, or what was named if a level was named. */
  private wantedLevel(): number {
    const store = this.store!;
    const held = this.settings.level;
    const last = store.levelCount - 1;
    if (held !== 'auto') return Math.min(Math.max(Math.trunc(held), 0), last);

    const state = this.state ?? this.states.get(this.coarsest);
    if (!state || !this.viewport) return this.coarsest;
    const span = this.viewport.x[1] - this.viewport.x[0];
    const pings = sourcePings(span, state.spacing, state.factor);
    const factors = store.multiscales.datasets.map((d) => d.factors.ping ?? 1);
    const wanted = wantedFactor(
      pings,
      this.viewport.panel.width,
      this.settings.pixelsPerPing,
    );
    return chooseLevel(this.target, wanted, factors);
  }

  /** Let go of levels that are neither the target nor a fallback for it. */
  private syncLevels(keep: Set<number>) {
    for (const index of [...this.states.keys()]) {
      if (keep.has(index)) continue;
      const state = this.states.get(index)!;
      for (const key of [...state.resident.keys()]) this.release(state, key);
      this.states.delete(index);
      this.layer?.dropLevel(index);
      this.scheduler?.dropLevel(index);
    }
  }

  /** Vertical geometry of one level in the unit currently chosen. */
  private verticalOf(state: LevelState): VerticalGeometry {
    return verticalFor(this.settings.yUnit, state.vertical);
  }

  /** Shallowest and deepest the data reaches, in the current vertical unit. */
  private get yBounds(): Extent {
    return verticalExtent(this.verticalOf(this.anyState));
  }

  /**
   * Horizontal extent of the whole survey in the current unit.
   *
   * Derived rather than stored, because it changes with the axis: the same
   * data spans 1211 pings and 7466 metres.
   */
  private get xBounds(): Extent {
    const axis = this.anyState.axis;
    return [axis.left[0], axis.right[axis.right.length - 1]];
  }

  /** Open on the whole survey, free, filling the canvas. */
  private resetViewport() {
    this.viewport = fitAll(this.xBounds, this.yBounds, {
      width: this.canvas.width,
      height: this.canvas.height,
    });
    this.window = undefined;
  }

  private replaceAxes() {
    for (const state of this.states.values()) {
      state.axis = buildXAxis(this.settings.xUnit, state.source);
      state.spacing = medianSpacing(state.axis.centre);
      state.packed.clear();
      this.placeTiles(state);
    }
  }

  /**
   * Put the current picture into whatever coordinates are now in force.
   *
   * A viewport range is in the units of the axis that was current when it was
   * set, so carrying it across unmodified would leave a metres view showing the
   * first sixth of a track it had been showing all of. Both ranges are computed
   * and handed over together, because setting one at a time under a lock
   * derives the other from a factor that belonged to the coordinates being
   * replaced.
   */
  private reexpress(
    was: { x: XUnit; y: YUnit },
    next: Settings,
    wasAxis: XAxisValues | undefined,
  ) {
    const view = this.viewport!;
    let [x, y] = [view.x, view.y];
    if (next.xUnit !== was.x && wasAxis) {
      x = remapRange(wasAxis, this.anyState.axis, x);
    }
    if (next.yUnit !== was.y) y = this.convertY(y, was.y, next.yUnit);
    if (x !== view.x || y !== view.y) view.reframe(x, y);
  }

  /**
   * Keep the same water on screen when the vertical unit changes.
   *
   * Converted through the first ping, so under heave the depths a sample index
   * covers differ slightly from ping to ping. A viewport range is one pair of
   * numbers and has to pick one.
   */
  private convertY(y: Extent, from: YUnit, to: YUnit): Extent {
    const index = (unit: YUnit) => unit !== 'meters';
    if (index(from) === index(to)) return y;
    const geometry = this.anyState.vertical;
    const convert = index(to)
      ? (value: number) => rangeToSample(geometry, 0, value)
      : (value: number) => sampleToRange(geometry, 0, value);
    return [convert(y[0]), convert(y[1])];
  }

  /**
   * A mode change and a factor change hold different axes, so they cannot both
   * go through setMode. See the note on Viewport.setExaggeration.
   *
   * Locking with no factor named adopts the shape already on screen, so
   * choosing the policy on its own does not move the picture. Going free names
   * nothing, because a free policy has no factor to hold.
   */
  private applyAspect(aspect: {
    mode: AspectMode;
    exaggeration?: number;
    hold?: 'x' | 'y';
  }) {
    const view = this.viewport!;
    if (aspect.mode !== view.mode) {
      const factor = aspect.exaggeration ?? view.exaggeration;
      view.setMode(aspect.mode, aspect.mode === 'locked' ? factor : undefined);
      return;
    }
    if (aspect.exaggeration !== undefined) {
      view.setExaggeration(aspect.exaggeration, aspect.hold ?? 'y');
    }
  }

  private applyWindow(request: WindowRequest) {
    const state = this.state ?? this.states.get(this.coarsest)!;
    const view = this.viewport!;
    this.window = resolveWindow(request, {
      axis: state.axis,
      epochNs: state.source.pingTime[0],
      vertical: this.yBounds,
    });
    const x = request.x ? this.window.attained.x : undefined;
    const y = request.y && !this.window.empty ? this.window.attained.y : undefined;
    // Whichever axis was asked for is the one to honour, and under a lock the
    // other follows from the factor, which is what the lock is for. Naming both
    // is a statement about the rectangle, and no factor honours both, so there
    // the factor gives instead, which is the trade fitting the extent makes.
    if (x && y) view.reframe(x, y);
    else if (y) view.setY(y);
    else if (x) view.setX(x);
  }

  private geometryFor(
    state: LevelState,
    channel: number,
  ): Float32Array<ArrayBuffer> {
    const geometry = state.verticals.get(channel) ?? state.vertical;
    const vertical = verticalFor(this.settings.yUnit, geometry);
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
  private uploadGeometry() {
    if (!this.layer) return;
    const units = { x: this.settings.xUnit, y: this.settings.yUnit };
    const channels = channelsUsed(this.settings.layers);
    for (const state of this.states.values()) {
      for (const channel of channels) {
        const packed = state.packed.get(channel);
        if (packed?.x === units.x && packed.y === units.y) continue;
        this.layer.setGeometry(state.index, channel, this.geometryFor(state, channel));
        state.packed.set(channel, { ...units });
      }
    }
  }

  private applyView() {
    if (!this.layer || !this.viewport) return;
    this.layer.setView(
      clipMatrix(this.viewport.x, this.viewport.y),
      this.viewport.yPerPixel,
    );
  }

  /** A gesture moved the view. Nothing is refetched that is already resident. */
  private moved() {
    if (!this.viewport) return;
    this.viewport.clampInto(this.xBounds, this.yBounds);
    this.trackMotion();
    this.applyView();
    this.refreshTiles();
    this.render();
    this.onViewChange?.();
    // Choosing a level reads the store, so it happens after the frame that
    // used the level already loaded rather than in front of it.
    const generation = this.generation;
    if (this.wantedLevel() !== this.target) {
      void this.retarget(generation)
        .then(() => {
          if (generation !== this.generation || this.destroyed) return;
          this.uploadGeometry();
          this.refreshTiles();
          this.render();
          this.onViewChange?.();
        })
        .catch((error) => this.onError?.(error));
    }
  }

  /**
   * How fast the view is travelling, and whether it has stopped.
   *
   * In source pings a second, because that is the unit the ring is measured in
   * and it is the same at every level and in every x unit. A view that is still
   * moving asks only for the coarse fill, and this is what says so: the timer
   * is what turns a drag into a rest, and a rest is when the target level is
   * finally worth the bytes.
   */
  private trackMotion() {
    const state = this.state;
    if (!this.viewport || !state) return;
    const now = performance.now();
    const centre = (this.viewport.x[0] + this.viewport.x[1]) / 2;
    const elapsed = (now - this.motion.at) / 1000;

    // A first move, or one after a long pause, has no speed to report. Taking
    // one from a stale timestamp would read as an enormous velocity and reach
    // the ring across the whole survey.
    if (elapsed > 0 && elapsed < 0.5) {
      const travelled = sourcePings(
        Math.abs(centre - this.motion.centre),
        state.spacing,
        state.factor,
      );
      const direction = centre >= this.motion.centre ? 1 : -1;
      const speed = (travelled / elapsed) * direction;
      // Smoothed, because a pointer moves in jerks and an unsmoothed speed
      // would swing the ring from one side of the view to the other.
      this.motion.velocity = this.motion.velocity * 0.6 + speed * 0.4;
    } else {
      this.motion.velocity = 0;
    }

    this.motion.at = now;
    this.motion.centre = centre;
    this.motion.moving = true;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settled(), SETTLE_MS);
  }

  /** The view stopped. Ask for the target level it has come to rest on. */
  private settled() {
    this.settleTimer = undefined;
    if (this.destroyed) return;
    this.motion.moving = false;
    this.motion.velocity = 0;
    this.refreshTiles();
  }

  /**
   * Work out where each tile of a level falls in data space.
   *
   * Culling is a rectangle test rather than an index calculation, because heave
   * moves a sample index up and down by a metre or so and the vertical unit can
   * change under it. The boxes are recomputed when an axis changes and are good
   * for every frame until it does.
   */
  private placeTiles(state: LevelState) {
    const vertical = this.verticalOf(state);
    state.boxes = new Map(
      state.tiles.map((tile) => [tile.key, tileBox(tile, state.axis, vertical)]),
    );
  }

  /**
   * Decide what draws, fetch what is missing, drop what is stale.
   *
   * The view is divided into slots at the target level. Each slot resolves to
   * the finest level holding it, which is the slot's own tile once it arrives
   * and a range inside a coarser tile until then.
   */
  private refreshTiles() {
    const state = this.state;
    if (!this.layer || !this.viewport || !state) return;
    const x = this.viewport.x;
    const y = this.viewport.y;
    this.clock += 1;

    const factors = this.store!.multiscales.datasets.map((d) => d.factors.ping ?? 1);
    const visible = drawn(this.settings.layers).filter(
      (layer) => !this.problems.has(layer.id),
    );
    const channels = channelsUsed(this.settings.layers);

    const onScreen = state.tiles.filter((tile) => {
      const box = state.boxes.get(tile.key);
      return box !== undefined && boxOverlaps(box, x, y);
    });

    this.scheduler?.request(this.wants(state, onScreen, channels, factors));

    let blank = 0;
    let standingIn = 0;
    const passes: LayerPass[] = [];
    for (const layer of visible) {
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
        exempt: this.coarsest,
      };
      const draws: SlotDraw[] = [];
      for (const tile of onScreen) {
        const slot = resolveSlot(tile, state.index, context);
        if (!slot) {
          blank += 1;
          continue;
        }
        if (slot.level !== state.index) standingIn += 1;
        const from = this.states.get(slot.level)!;
        for (const channel of wanted) {
          from.resident.get(held(channel, `${slot.row}:${slot.column}`))!.seen = this.clock;
        }
        draws.push(slot);
      }
      passes.push({ layer: layer.id, draws });
    }

    this.slots = onScreen.length * Math.max(visible.length, 1);
    this.blank = blank;
    this.standingIn = standingIn;
    this.passes = passes;
    this.layer.setDraws(passes);
    this.evict();
  }

  /**
   * The tiles worth holding, highest priority first.
   *
   * The footprint policy decides the shape of it, and this turns that into one
   * want per channel: two layers on one channel share a tile, which is what
   * makes a second colormap of the same frequency free.
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
    const rows = extent(onScreen.map((tile) => tile.row));
    const columns = extent(onScreen.map((tile) => tile.column));

    const tiles = onScreen.length
      ? plan({
          target: state.index,
          visible: { rows, columns },
          levels: [...this.states.values()].map((held) => ({
            index: held.index,
            rows: held.grid.rows,
            columns: held.grid.columns,
          })),
          factors,
          tilePings: state.grid.tilePings,
          velocity: this.motion.velocity,
          moving: this.motion.moving,
          depth: SUBSTITUTION_CAP,
        })
      : [];

    const wants: TileWant[] = [];
    for (const tile of tiles) {
      for (const channel of channels) wants.push({ ...tile, channel });
    }

    const coarsest = this.states.get(this.coarsest);
    if (coarsest && coarsest !== state) {
      const survey = this.pinnable(coarsest, channels.length);
      const x = this.viewport!.x;
      const y = this.viewport!.y;
      for (const tile of coarsest.tiles) {
        const box = coarsest.boxes.get(tile.key);
        if (!survey && !(box && boxOverlaps(box, x, y))) continue;
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
    this.chunks?.tag(options.signal, options.priority);

    // Only where the worker can reopen the store for itself. A caller may pass
    // any ChunkStore, and one that fetches over something other than plain HTTP
    // cannot be rebuilt in a worker from a URL: it would silently become a
    // FetchStore against an address that means nothing to it.
    const href = this.reopenable ? this.chunks?.href : undefined;
    const entry = this.store!.multiscales.datasets[key.level];
    if (this.decode && href) {
      return this.decode.read(
        {
          href,
          path: entry.path,
          valueName: this.store!.multiscales.name,
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
    resident.seen = this.clock;
    return true;
  }

  /** Whether the builder already looked and found nothing in this tile. */
  private isEmpty(key: { level: number; channel: number; row: number; column: number }) {
    const state = this.states.get(key.level);
    const chunks = this.store?.multiscales.datasets[key.level]?.chunks;
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
    this.uploader.queue({
      bytes: values.data.byteLength,
      priority,
      run: () => {
        this.queued.delete(pending);
        if (this.destroyed || generation !== this.tileGeneration) return;
        const state = this.states.get(key.level);
        if (!state || state.resident.has(resident)) return;

        const tile = tileAt(state.grid, key.row, key.column);
        const size = { samples: values.samples, pings: values.pings };
        const texture = this.pool.acquire(size.samples, size.pings);
        writeValues(this.context.device, texture, values.data, size);

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
          seen: this.clock,
        });
        this.layer?.setTile(state.index, key.channel, tile.key, texture, view);
      },
    });
  }

  /**
   * Drain the upload queue on the next frame, then draw what landed.
   *
   * One refresh and one draw per frame rather than per tile. Tiles arrive in
   * bursts and redrawing for each of them is the same stutter the upload cap
   * exists to avoid, one layer up.
   */
  private scheduleFrame() {
    if (this.frameHandle || this.destroyed) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = 0;
      if (this.destroyed) return;
      if (this.uploader.drain()) {
        this.refreshTiles();
        this.render();
        this.onViewChange?.();
      }
      if (this.uploader.pending) this.scheduleFrame();
    });
  }

  /**
   * Drop the tiles wanted least recently, once tiles in use hold more than the
   * pool's share for them. What is left of the budget is the free list the pool
   * reuses from, which is what keeps a pan off the allocator.
   *
   * The pinned coarsest level is exempt. It is the last thing standing between
   * a viewport and an empty panel, and it is a megabyte or two.
   */
  private evict() {
    if (this.pool.inUse <= this.pool.share) return;
    const channels = Math.max(channelsUsed(this.settings.layers).length, 1);
    const spare: { state: LevelState; key: string; seen: number }[] = [];
    for (const state of this.states.values()) {
      if (state.index === this.coarsest && this.pinnable(state, channels)) continue;
      for (const [key, held] of state.resident) {
        if (held.seen !== this.clock) spare.push({ state, key, seen: held.seen });
      }
    }
    spare.sort((a, b) => a.seen - b.seen);
    while (spare.length && this.pool.inUse > this.pool.share) {
      const oldest = spare.shift()!;
      this.release(oldest.state, oldest.key);
    }
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
    // Counted across the channels the stack reads, because pinning a level
    // pins it for every one of them: three tinted frequencies is three times
    // the resident coarsest, and whether that fits is the question.
    const bytes = state.shape.pings * state.shape.samples * VALUE_BYTES * channels;
    return bytes <= this.pool.share / PIN_SHARE;
  }

  private release(state: LevelState, key: string) {
    const resident = state.resident.get(key);
    if (!resident) return;
    this.layer?.dropTile(state.index, resident.channel, resident.tile);
    state.resident.delete(key);
    this.pool.release(resident.texture);
  }

  /** Let go of every level, as when the channel changes or the store is replaced. */
  private dropLevels(giveBack = true) {
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
      this.layer?.dropLevel(state.index);
      this.scheduler?.dropLevel(state.index);
    }
    this.scheduler?.abortAll();
    this.uploader.clear();
    this.queued.clear();
    this.states.clear();
    this.pending.clear();
    this.passes = [];
    this.slots = 0;
    this.blank = 0;
    this.standingIn = 0;
    this.layer?.setDraws([]);
  }

  /**
   * Build the renderer, which holds the stack and everything it draws with.
   *
   * Split from installing the layers because the two happen at different rates:
   * this runs once per device, and setLayers runs whenever the stack changes.
   */
  private buildStack() {
    const stack = LayerStack.create({
      context: this.context,
      format: this.context.format,
      nodataColor: NODATA_COLOR,
      nodataThreshold: this.store!.multiscales.nodataThreshold,
    });
    if (this.destroyed) {
      stack.destroy();
      return;
    }
    this.layer?.destroy();
    this.layer = stack;
    // A new stack holds no buffers, so what a level had packed is gone and
    // every tile already resident is reinstalled rather than refetched.
    for (const state of this.states.values()) {
      state.packed.clear();
      for (const resident of state.resident.values()) {
        stack.setTile(
          state.index,
          resident.channel,
          resident.tile,
          resident.texture,
          resident.view,
        );
      }
    }
    stack.setDraws(this.passes);
  }

  /**
   * Let go of the tiles of channels no layer reads any more.
   *
   * Not every channel: a stack that gains a fourth frequency keeps the three
   * it had, and a stack that changes a colormap changes no channel at all.
   */
  private dropChannels(keep: number[]) {
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

  /** Re-upload and rebuild after the device was replaced. */
  private async rebuild() {
    if (this.destroyed || !this.store) return;
    this.configure();
    // Every texture belonged to the device that went away, tiles included. The
    // context has already replaced the pool by the time this runs, so letting
    // the levels go is all this view has to do about it.
    this.dropLevels(false);
    this.layer = undefined;
    this.buildStack();
    await this.applyLayers(this.settings.layers);
    await this.ensureLevel(this.coarsest, this.settings.channel);
    await this.ensureLevel(this.target, this.settings.channel);
    this.uploadGeometry();
    this.applyView();
    this.refreshTiles();
    this.render();
  }

  private resize() {
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.viewport?.setPanel({ width, height });
    this.applyView();
    this.refreshTiles();
    this.render();
    if (this.viewport) this.onViewChange?.();
  }
}
