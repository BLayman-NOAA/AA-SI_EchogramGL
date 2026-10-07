/**
 * One echogram view.
 *
 * Holds one or more sources, a layer stack drawn from them and a viewport with
 * two scales. The lifecycle is the part meant to last: a container, its
 * sources, and a destroy that releases GPU resources, because a host
 * application opens and closes panels.
 *
 * Which level is drawn is an answer, not a setting. The viewport says how much
 * survey is on screen, that picks the coarsest level still holding a ping for
 * every pixel, and the level's tiles are fetched. A slot whose tile has not
 * arrived draws from the finest coarser level that has, and the coarsest level
 * is kept resident survey wide, so a viewport inside the data never draws
 * blank, only coarser. Each source answers this for itself.
 *
 * What was fetched is kept. A tile stays resident while it is in frame, for a
 * grace period after it leaves, and beyond that for as long as the pool has
 * room, so a zoom out and back lands on what was drawn before. Finer levels
 * are fetched ahead over the water on screen, as many as a byte budget allows.
 *
 * Several sources share one x axis. A time axis counts from one origin for the
 * whole view, so a ping at the same instant in two datasets lands in the same
 * place, and with more than one source only the units that mean the same thing
 * in every dataset are offered: time against metres.
 */

import {
  type Histogram,
  type RegionStatistics,
  DEFAULT_RANGE,
  Reducer,
  percentileLimits,
  statistics,
} from '../compute';
import { type DecodePool, type SpawnWorker, createDecodePool } from '../data/decode';
import type { ChunkStore } from '../data/store';
import { Uploader } from '../data/uploader';
import type { GpuContext } from '../device/context';
import { TexelReader } from '../device/texels';
import type { TexturePool } from '../device/texturePool';
import {
  type AxisContext,
  type XUnit,
  type YUnit,
  AxisUnitError,
  SHARED_X_UNITS,
  SHARED_Y_UNITS,
  assertXUnit,
  assertYUnit,
  sharedXUnits,
  sharedYUnits,
  xAxisLabel,
  yAxisLabel,
} from '../geometry/axes';
import {
  type Extent,
  type XAxisValues,
  clipMatrix,
  rangeToSample,
  remapRange,
  sampleToRange,
} from '../geometry/coords';
import { type SlotDraw, PIXELS_PER_PING } from '../geometry/levels';
import {
  type ResolvedWindow,
  type WindowRequest,
  resolveWindow,
} from '../geometry/window';
import { NODATA_HEX, parseHex } from '../render/colormaps';
import { type LayerPass, LayerStack } from '../render/drawLayer';
import type { AlignmentProblem } from './alignment';
import { attachInteraction } from './interaction';
import {
  type Layer,
  type LayerSpec,
  VALUE_CLIM,
  channelsUsed,
  colorMode,
  drawn,
  resolveLayers,
} from './layers';
import { perFrame } from './schedule';
import {
  type SourceSetting,
  type ViewSettings,
  SETTINGS_VERSION,
  copySettings,
} from './settings';
import type { Multiscales } from '../data/contract';
import { type PieceSetSpec, isPieceSet } from '../data/pieces';
import { PieceSource } from './PieceSource';
import {
  type CellProbe,
  type LevelChoice,
  type SourceHost,
  type Spare,
  type ViewSource,
  PyramidSource,
} from './Source';
import { type AspectMode, Viewport, fitAll } from './viewport';

export type { LevelChoice } from './Source';
export type { PieceSetSpec, PieceSpec } from '../data/pieces';

/** What a source can be opened from: a store, or a step the server resolved. */
export type SourceInput = string | ChunkStore | PieceSetSpec;

/** The id a source opened through setStore is given. */
export const MAIN_SOURCE = 'main';

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
   * Called with what is under the pointer as it moves over the echogram, and
   * with undefined when it leaves. At most once a frame, and again when a
   * tile under the pointer arrives.
   */
  onHover?: (probe: Probe | undefined) => void;
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
  /**
   * Color of cells that hold no value, as #rrggbb: everything masked or
   * removed upstream (noise, seabed, surface, beyond the recorded range).
   */
  nodataColor?: string;
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
  /** Levels loaded: the target, its ladder, and any still holding tiles. */
  levelsHeld: number;
  /**
   * Rolling cost of encoding one redraw, in milliseconds.
   *
   * The processor side only. What the GPU then takes is not readable without a
   * timestamp query, so this measures the part a tile count actually drives:
   * whether a pan is rebuilding command streams or replaying one.
   */
  redrawMs: number;
}

/** One source as a host describes it to a user. */
export interface SourceInfo {
  id: string;
  /** One store, or many datasets laid side by side in time. */
  kind: 'pyramid' | 'pieces';
  /** Where it is, where it can say. */
  store?: string;
  levels: number;
  /** The level being drawn. */
  level: number;
  channels: number;
  channelNames?: string[];
  channelFrequencies?: number[];
  valueName: string;
  dataType: string;
  verticalRef: string;
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
  nodataColor: string;
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
  /**
   * Every source, in the order they were added. The single store fields above
   * describe the source the bottom layer reads.
   */
  sources: SourceInfo[];
  /**
   * Things a host should tell the user that are not errors, such as sources
   * drawn on different vertical references.
   */
  notes: string[];
}

const DEFAULT_COLORMAP = 'viridis';

/**
 * One cell is one measurement, and interpolating between cells invents
 * structure that is not in the data. matplotlib magnifies with nearest for the
 * same reason, so this is also what keeps the viewer comparable to the existing
 * figures.
 */
const DEFAULT_FILTER: GPUFilterMode = 'nearest';

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
  nodataColor: string;
  xUnit: XUnit;
  yUnit: YUnit;
  layers: Layer[];
}

/** One layer under the pointer. */
export interface ProbeLayer {
  layer: string;
  source: string;
  /** The channel it draws, and the one it subtracts for a difference. */
  label: string;
  /**
   * The value of the cell drawn there: decibels, a difference in decibels or
   * a label. Null where the cell holds no data; undefined where the tile is
   * still loading or its values are no longer in memory.
   */
  value: number | null | undefined;
  categorical: boolean;
  difference: boolean;
  /** The cell, where one is drawn under the pointer. */
  cell?: {
    level: number;
    /** Source pings the cell merges. */
    factor: number;
    x: Extent;
    y: Extent;
  };
}

/** What is under the pointer, in the units on screen. */
export interface Probe {
  x: number;
  y: number;
  xUnit: XUnit;
  yUnit: YUnit;
  /** Nanoseconds since 1970, where the x axis is time. */
  timeNs?: number;
  /** 'depth' or 'range', which names the vertical in metres. */
  verticalRef: string;
  /** Visible layers, top of the stack first. */
  layers: ProbeLayer[];
}

export interface StatisticsRequest {
  /** Which source to measure. Defaults to the bottom layer's. */
  source?: string;
  /** Which channel to measure. Defaults to the bottom layer's. */
  channel?: number;
  /** The rectangle, in the units on screen. Defaults to the whole view. */
  x?: Extent;
  y?: Extent;
  bins?: number;
}

export interface ViewStatistics extends RegionStatistics {
  histogram: Histogram;
  source: string;
  channel: number;
  /** The level measured, since the numbers describe its cells and not the source. */
  level: number;
}

/**
 * One value from the cells of a layer: the value itself, or the first minus
 * the second for a difference. No data in either is no data; a value not yet
 * known in either is not known.
 */
function combine(values: (number | null | undefined)[]): number | null | undefined {
  if (values.some((value) => value === null)) return null;
  if (values.some((value) => value === undefined)) return undefined;
  const [first, second] = values as number[];
  return values.length > 1 ? first - second : first;
}

/** The smallest extent holding every one given. */
function union(extents: Extent[]): Extent {
  return [
    Math.min(...extents.map((e) => e[0])),
    Math.max(...extents.map((e) => e[1])),
  ];
}

export class EchogramView {
  readonly canvas: HTMLCanvasElement;

  private context: GpuContext;
  private surface: GPUCanvasContext;
  private background: GPUColorDict;
  private onError?: (error: unknown) => void;
  private onViewChange?: () => void;
  private onHover?: (probe: Probe | undefined) => void;
  /** Where the pointer is over the canvas, in client pixels, if it is. */
  private pointer?: { x: number; y: number };
  private hover: () => void;
  private unhover: () => void;
  /** Bumped by every hover report, so a late read back is not shown. */
  private hoverGeneration = 0;
  private texels?: TexelReader;
  private observer: ResizeObserver;
  private unwatchDevice: () => void;
  private detach: () => void;
  private destroyed = false;

  /** In the order added. The first is what single store questions are about. */
  private sources = new Map<string, ViewSource>();
  /** Next plane to hand out. Planes are never reused within a view. */
  private nextPlane = 0;
  /** Nanoseconds the time axis counts from, set by the first source to load. */
  private epochNs?: number;
  private viewport?: Viewport;
  private window?: ResolvedWindow;
  private host: SourceHost;

  /** The shared pool, which outlives this view. See GpuContext. */
  private get pool(): TexturePool {
    return this.context.pool;
  }
  private layer?: LayerStack;
  private reducer?: Reducer;

  /**
   * The data path, in the order bytes travel it.
   *
   * Each source holds the store its requests go through and a scheduler that
   * decides what is worth asking for. Shared between them: a worker pool that
   * decodes off the main thread, the context's cache of what came back, and an
   * uploader that spreads the writes across frames. Section 4.5 is the whole
   * of that: bandwidth is not the only cost between object storage and a
   * drawn pixel.
   */
  private decode?: DecodePool;
  private uploader: Uploader;
  private frameHandle = 0;

  /**
   * How fast the view is moving, in x units a second, and whether it still is.
   *
   * Both are policy inputs rather than measurements for their own sake: the
   * ring reaches further ahead at speed, and the target level is not asked for
   * until the motion settles.
   */
  private motion = { at: 0, centre: 0, velocity: 0, moving: false };
  private settleTimer?: ReturnType<typeof setTimeout>;

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
    nodataColor: NODATA_HEX,
    xUnit: 'pings',
    yUnit: 'meters',
    layers: [],
  };

  /** Bumped by every call, so a slower earlier call cannot install its result. */
  private generation = 0;

  constructor(options: EchogramViewOptions) {
    this.context = options.context;
    this.background = options.background ?? { r: 0, g: 0, b: 0, a: 1 };
    this.onError = options.onError;
    this.onViewChange = options.onViewChange;
    this.onHover = options.onHover;
    this.hover = perFrame(() => this.reportHover());
    this.unhover = () => undefined;

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
    this.host = this.makeHost();

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
    if (this.onHover) this.unhover = this.watchPointer();
    this.resize();
  }

  /** Follow the pointer over the canvas, for the hover readout. */
  private watchPointer(): () => void {
    const move = (event: PointerEvent) => {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.hover();
    };
    const leave = () => {
      this.pointer = undefined;
      this.onHover?.(undefined);
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerleave', leave);
    return () => {
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerleave', leave);
    };
  }

  /**
   * Report what is under the pointer, then fill in any value the host cache
   * no longer held from the texture being drawn, and report again.
   *
   * The cache is bounded and fills with whatever arrived last, which is often
   * the prefetched levels rather than the one on screen, so the tile under the
   * pointer may be drawn with its decoded values long gone.
   */
  private reportHover() {
    if (!this.pointer || this.destroyed) return;
    const generation = (this.hoverGeneration += 1);
    const found = this.cellsAt(this.pointer.x, this.pointer.y);
    this.onHover?.(found?.probe);
    if (!found) return;
    const missing = found.cells.filter(
      ({ cells }) => cells.some((cell) => cell?.value === undefined && cell?.texel),
    );
    if (!missing.length) return;
    this.texels ??= new TexelReader(this.context.device);
    const reader = this.texels;
    void (async () => {
      for (const { index, cells, threshold } of missing) {
        const values: (number | null | undefined)[] = [];
        for (const cell of cells) {
          if (!cell || cell.value !== undefined || !cell.texel) {
            values.push(cell?.value);
            continue;
          }
          const { texture, x, y, held } = cell.texel;
          if (!held()) {
            values.push(undefined);
            continue;
          }
          const read = await reader.read(texture, x, y);
          // An evicted texture is reused for another tile, so a value read
          // after that belongs to somewhere else.
          if (!held()) values.push(undefined);
          else values.push(Number.isFinite(read) && read > threshold ? read : null);
        }
        found.probe.layers[index].value = combine(values);
      }
      if (generation === this.hoverGeneration && !this.destroyed) {
        this.onHover?.(found.probe);
      }
    })().catch(() => undefined);
  }

  /**
   * What is under a point on the canvas, in client pixels.
   *
   * One entry per visible layer, top of the stack first: the cell drawn
   * there, at whatever level it is drawn from, and its value where the host
   * cache still holds it. Undefined outside the canvas or before anything is
   * drawn. The hover readout goes further and reads a missing value back from
   * the GPU.
   */
  probe(clientX: number, clientY: number): Probe | undefined {
    return this.cellsAt(clientX, clientY)?.probe;
  }

  /** The probe, and the cells behind each of its layers. */
  private cellsAt(
    clientX: number,
    clientY: number,
  ):
    | {
        probe: Probe;
        cells: { index: number; cells: (CellProbe | undefined)[]; threshold: number }[];
      }
    | undefined {
    const viewport = this.viewport;
    if (!viewport) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return undefined;
    const x = viewport.x[0] + fx * (viewport.x[1] - viewport.x[0]);
    const y = viewport.y[0] + fy * (viewport.y[1] - viewport.y[0]);
    const { xUnit, yUnit } = this.settings;
    const time = xUnit === 'datetime' || xUnit === 'seconds';

    const layers: ProbeLayer[] = [];
    const cells: { index: number; cells: (CellProbe | undefined)[]; threshold: number }[] =
      [];
    const visible = drawn(this.settings.layers).filter(
      (layer) => !this.problems.has(layer.id),
    );
    for (const layer of [...visible].reverse()) {
      const source = layer.source ? this.sources.get(layer.source) : undefined;
      if (!source) continue;
      const first = source.probe(x, y, layer.channel);
      const second =
        layer.against === undefined ? undefined : source.probe(x, y, layer.against);
      const both = layer.against === undefined ? [first] : [first, second];
      const value = combine(both.map((cell) => cell?.value));
      cells.push({
        index: layers.length,
        cells: both,
        threshold: source.multiscales.nodataThreshold,
      });
      const label =
        layer.against === undefined
          ? source.channelName(layer.channel)
          : `${source.channelName(layer.channel)} − ${source.channelName(layer.against)}`;
      layers.push({
        layer: layer.id,
        source: source.id,
        label,
        value: first ? value : undefined,
        categorical: colorMode(layer.color) === 'palette',
        difference: layer.against !== undefined,
        cell: first
          ? { level: first.level, factor: first.factor, x: first.x, y: first.y }
          : undefined,
      });
    }
    const base = this.base;
    const probe: Probe = {
      x,
      y,
      xUnit,
      yUnit,
      timeNs: time && this.epochNs !== undefined ? this.epochNs + x * 1e9 : undefined,
      verticalRef: base?.multiscales.verticalRef ?? 'depth',
      layers,
    };
    return { probe, cells };
  }

  /** What every source reads from this view, live rather than copied. */
  private makeHost(): SourceHost {
    const view = this;
    return {
      get context() {
        return view.context;
      },
      get decode() {
        return view.decode;
      },
      get uploader() {
        return view.uploader;
      },
      get layer() {
        return view.layer;
      },
      get viewport() {
        return view.viewport;
      },
      get xUnit() {
        return view.settings.xUnit;
      },
      get yUnit() {
        return view.settings.yUnit;
      },
      get levelChoice() {
        return view.settings.level;
      },
      get pixelsPerPing() {
        return view.settings.pixelsPerPing;
      },
      get generation() {
        return view.generation;
      },
      get clock() {
        return view.clock;
      },
      get destroyed() {
        return view.destroyed;
      },
      get motion() {
        return view.motion;
      },
      get sourceCount() {
        return view.sources.size;
      },
      epoch(firstPingNs: number) {
        view.epochNs ??= firstPingNs;
        return view.epochNs;
      },
      levelLoaded() {
        view.uploadGeometry();
        view.refreshTiles();
        view.render();
      },
      onError(error: unknown) {
        view.onError?.(error);
      },
    };
  }

  /** Open a store and draw one channel. Replaces every source the view had. */
  async setStore(source: SourceInput, options: SetStoreOptions = {}) {
    const opened = await this.openSource(MAIN_SOURCE, source);
    if (this.destroyed) {
      opened.destroy();
      return;
    }
    this.clearSources();
    this.sources.set(MAIN_SOURCE, opened);
    // The stack holds the nodata threshold, which belongs to the store that
    // was open when it was built.
    this.layer?.destroy();
    this.layer = undefined;
    this.begin();
    await this.settle(MAIN_SOURCE, options);
  }

  /**
   * Start over on a first source.
   *
   * A channel, unit or layer from the last store may not exist in this one,
   * and a stack naming channels this store does not have would ask for reads
   * that cannot be served.
   */
  private begin() {
    this.settings = { ...this.settings, level: 'auto', channel: 0, layers: [] };
    this.fresh = true;
  }

  /** Let go of every source, and of the view they were placed in. */
  private clearSources() {
    for (const held of this.sources.values()) held.destroy();
    this.sources.clear();
    this.epochNs = undefined;
    this.viewport = undefined;
    this.window = undefined;
    this.uploader.clear();
    this.clearDraws();
  }

  /**
   * Apply options with a source just added, and take it out again if they
   * cannot be applied.
   *
   * A source left behind by a failed call is asked to prepare again by every
   * later one and fails each of them, with nothing a host can do short of
   * opening a new store.
   */
  private async settle(id: string, options: SetStoreOptions) {
    try {
      await this.setOptions(options);
    } catch (error) {
      this.sources.get(id)?.destroy();
      this.sources.delete(id);
      if (!this.sources.size) {
        this.clearSources();
        this.settings = { ...this.settings, layers: [] };
        this.render();
      } else {
        const layers = this.settings.layers.filter((layer) => layer.source !== id);
        await this.setOptions({ layers }).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Open another dataset beside the ones already shown.
   *
   * It draws nothing until a layer names it, which `options.layers` can do in
   * the same call. With a second source the axes narrow to the units every
   * dataset shares, so a view on pings moves to time.
   */
  async addSource(id: string, source: SourceInput, options: SetStoreOptions = {}) {
    if (this.sources.has(id)) throw new Error(`a source named ${id} is already open`);
    const opened = await this.openSource(id, source);
    if (this.destroyed) {
      opened.destroy();
      return;
    }
    if (!this.sources.size) {
      // The first source opens the view, which is what setStore does.
      this.clearSources();
      this.sources.set(id, opened);
      this.begin();
      await this.settle(id, options);
      return;
    }
    this.sources.set(id, opened);
    const units: SetStoreOptions = {};
    if (!SHARED_X_UNITS.includes(this.settings.xUnit)) units.xUnit = 'datetime';
    if (!SHARED_Y_UNITS.includes(this.settings.yUnit)) units.yUnit = 'meters';
    await this.settle(id, { ...units, ...options });
  }

  /**
   * Open a source again from newer input, as when a step was run again.
   *
   * It keeps its id, so its layers keep their place, color and limits, and
   * the view stays where it is. The old source is let go only once the new
   * one has been applied; if it cannot be, the old one is put back.
   */
  async replaceSource(id: string, source: SourceInput) {
    const old = this.sources.get(id);
    if (!old) {
      await this.addSource(id, source);
      return;
    }
    const opened = await this.openSource(id, source);
    if (this.destroyed) {
      opened.destroy();
      return;
    }
    this.swap(id, opened);
    try {
      await this.setOptions({});
    } catch (error) {
      this.swap(id, old);
      opened.destroy();
      await this.setOptions({}).catch(() => undefined);
      throw error;
    }
    old.destroy();
  }

  /** Put one source in another's place, keeping the order they were added in. */
  private swap(id: string, source: ViewSource) {
    this.sources = new Map(
      [...this.sources].map(([key, held]) => [key, key === id ? source : held]),
    );
  }

  /** Stop drawing a source, and every layer that read it. */
  async removeSource(id: string) {
    const source = this.sources.get(id);
    if (!source) return;
    source.destroy();
    this.sources.delete(id);
    const layers = this.settings.layers.filter((layer) => layer.source !== id);
    if (!this.sources.size) {
      this.clearSources();
      this.settings = { ...this.settings, layers: [] };
      this.render();
      return;
    }
    await this.setOptions({ layers });
  }

  /** Ids of the sources open, in the order they were added. */
  get sourceIds(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * Open a store, or a set of described datasets.
   *
   * A store is a pyramid, or a plain Sv dataset read as one level. A piece
   * set is one or more datasets placed in time, which open as a piece source
   * however many there are.
   */
  private async openSource(id: string, source: SourceInput): Promise<ViewSource> {
    const allocate = (count: number) => this.allocate(count);
    if (isPieceSet(source)) return new PieceSource(id, source, allocate, this.host);
    return PyramidSource.open(id, source, allocate, this.host);
  }

  private allocate(count: number): number {
    const base = this.nextPlane;
    this.nextPlane += count;
    return base;
  }

  /** The first source, which single store questions are answered from. */
  private get primary(): ViewSource | undefined {
    return this.sources.values().next().value;
  }

  /** The source the bottom layer reads, or the first where there is no layer. */
  private get base(): ViewSource | undefined {
    const id = this.settings.layers[0]?.source;
    return (id && this.sources.get(id)) || this.primary;
  }

  /** Channels the stack reads from one source. */
  private channelsFor(id: string, layers = this.settings.layers): number[] {
    return channelsUsed(layers.filter((layer) => layer.source === id));
  }

  /**
   * Change what is shown without reopening the store.
   *
   * Only what changed is rebuilt: limits and opacity write the params buffer,
   * an axis unit repacks the geometry buffers, a colormap builds a table, and a
   * channel reloads every level.
   */
  async setOptions(options: SetStoreOptions) {
    if (!this.sources.size) throw new Error('no store: call setStore first');
    const previous = this.settings;
    const next: Settings = { ...previous, ...options, layers: previous.layers };
    next.layers = this.resolveStack(options, previous, next);
    const generation = (this.generation += 1);
    const current = () => generation === this.generation && !this.destroyed;

    // Tiles are per channel, so a stack that reads a channel nothing read
    // before has nothing resident for it. Only the channels that went away are
    // dropped; the ones that stayed keep everything they hold.
    for (const source of this.sources.values()) {
      source.dropChannels(this.channelsFor(source.id, next.layers));
    }

    // The coarsest level is what opens the view and what stands in for
    // everything else, so it is loaded before anything asks a question that
    // needs an axis.
    const contexts = await Promise.all(
      [...this.sources.values()].map((source) => source.prepare()),
    );
    if (!current()) return;

    if (this.fresh) {
      // Carried over rather than asked for, so adjust it instead of refusing.
      const validX = sharedXUnits(contexts);
      if (!validX.includes(next.xUnit)) {
        next.xUnit = validX.includes('pings') ? 'pings' : validX[0];
      }
      if (!sharedYUnits(contexts).includes(next.yUnit)) next.yUnit = 'meters';
      this.fresh = false;
    }
    this.assertUnits(next.xUnit, next.yUnit, contexts);

    if (!this.layer) {
      this.buildStack();
      if (!current()) return;
    }

    const unitsChanged =
      next.xUnit !== previous.xUnit || next.yUnit !== previous.yUnit;
    const wasAxis = this.primary?.someState?.axis;
    const wasUnits = { x: previous.xUnit, y: previous.yUnit };
    parseHex(next.nodataColor);
    this.settings = next;
    this.layer?.setNodataColor(parseHex(next.nodataColor));
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

    for (const source of this.sources.values()) source.retry();
    // Checked after the levels are loaded, since the answer comes from the
    // sidecars. A layer that cannot be differenced is left out of the stack
    // rather than drawn empty, and named through info so a host can say why.
    this.problems = this.alignmentProblems(next.layers);
    await this.applyLayers(
      next.layers.filter((layer) => !this.problems.has(layer.id)),
    );
    if (!current()) return;
    await Promise.all(
      [...this.sources.values()].map((source) => source.retarget(current)),
    );
    if (!current()) return;

    this.uploadGeometry();
    this.applyView();
    this.refreshTiles();
    this.render();
  }

  private assertUnits(x: XUnit, y: YUnit, contexts: AxisContext[]) {
    if (contexts.length === 1) {
      assertXUnit(x, contexts[0]);
      assertYUnit(y, contexts[0]);
      return;
    }
    const validX = sharedXUnits(contexts);
    if (!validX.includes(x)) {
      throw new AxisUnitError(
        `x_axis_units '${x}' counts from one dataset's start. With several ` +
          `sources use one of ${validX.join(', ')}.`,
      );
    }
    if (!sharedYUnits(contexts).includes(y)) {
      throw new AxisUnitError(
        `y_axis_units '${y}' is a sample index of one dataset. With several ` +
          `sources use meters.`,
      );
    }
  }

  /** Contexts of the sources with a level loaded. */
  private get contexts(): AxisContext[] {
    const found: AxisContext[] = [];
    for (const source of this.sources.values()) {
      if (source.context) found.push(source.context);
    }
    return found;
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
      return this.placeLayers(resolveLayers(options.layers, this.layerDefaults(next)));
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
    return this.placeLayers(resolveLayers(base, this.layerDefaults(next)));
  }

  /**
   * Give every layer a source it can be drawn from, and a channel that source
   * has.
   *
   * A layer naming no source reads the first one, and the id is written in so
   * that removing the first source later does not move the layer onto another.
   * A layer naming a source that is gone is dropped rather than drawn from a
   * different dataset.
   *
   * A stack outlives the store it was built against, through a saved
   * configuration or a controls panel that was not redrawn. Clamping the
   * channel means a channel that is gone draws the last one instead of failing
   * every tile read for it one at a time.
   */
  private placeLayers(layers: Layer[]): Layer[] {
    const first = this.primary?.id;
    const placed: Layer[] = [];
    for (const layer of layers) {
      const id = layer.source ?? first;
      const source = id === undefined ? undefined : this.sources.get(id);
      if (!source) continue;
      const count = source.channels;
      const channel = count && layer.channel >= count ? count - 1 : layer.channel;
      placed.push({ ...layer, source: source.id, channel });
    }
    return placed;
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

  /** Layers whose two channels cannot be differenced, by source. */
  private alignmentProblems(layers: Layer[]): Map<string, AlignmentProblem> {
    const problems = new Map<string, AlignmentProblem>();
    for (const source of this.sources.values()) {
      source.alignmentProblems(
        layers.filter((layer) => layer.source === source.id),
        problems,
      );
    }
    return problems;
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
    const bottom = this.settings.layers[0];
    const id = options.source ?? bottom?.source ?? this.primary?.id;
    const source = id === undefined ? undefined : this.sources.get(id);
    if (!source || !this.viewport || !this.layer) return undefined;
    const channel = options.channel ?? bottom?.channel ?? 0;

    const x = options.x ?? this.viewport.x;
    const y = options.y ?? this.viewport.y;
    const input = source.reduceInput(channel, x, y);
    if (!input) return undefined;

    this.reducer ??= new Reducer(this.context);
    const result = await this.reducer.run({
      geometry: input.geometry,
      tiles: input.tiles,
      x,
      y,
      range: this.histogramRange(source.multiscales),
      nodata: source.multiscales.nodataThreshold,
      bins: options.bins,
    });
    if (!result) return undefined;

    // The depth integral is averaged over the pings the rectangle spans, which
    // the axis knows and the device does not.
    return {
      ...statistics(result, input.pings),
      histogram: result.histogram,
      source: source.id,
      channel,
      level: input.level,
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
    const limits = new Map<string, [number, number]>();
    const key = (source: string | undefined, channel: number) => `${source}:${channel}`;
    for (const source of this.sources.values()) {
      for (const channel of this.channelsFor(source.id)) {
        const found = await this.statistics({ source: source.id, channel });
        const range = found && percentileLimits(found.histogram, low, high);
        if (range) limits.set(key(source.id, channel), range);
      }
    }
    if (!limits.size) return undefined;

    const layers = this.settings.layers.map((layer) => ({
      ...layer,
      clim: limits.get(key(layer.source, layer.channel)) ?? layer.clim,
    }));
    await this.setOptions({ layers });
    const bottom = this.settings.layers[0];
    return bottom ? limits.get(key(bottom.source, bottom.channel)) : undefined;
  }

  /** Where the histogram starts and stops, from the store where it says. */
  private histogramRange(multiscales: Multiscales): [number, number] {
    const range = multiscales.histRange;
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
    this.retargetStale(false);
  }

  /**
   * Everything a second panel needs to show the same thing.
   *
   * Configuration only, per settings.ts: what is resident and which level is
   * drawn are answers the receiving view works out for itself from its own
   * panel size.
   */
  get settingsObject(): ViewSettings | undefined {
    const primary = this.primary;
    if (!primary) return undefined;
    const { settings, viewport } = this;
    const sources = [...this.sources.values()].flatMap((source) => {
      const found = source.setting();
      return found ? [found] : [];
    });
    // The list is what names a source's id, which a layer reads by. Left out
    // only where it would say no more than `store` does.
    const plain = sources.length === 1 && sources[0].id === MAIN_SOURCE && sources[0].store;
    return copySettings({
      version: SETTINGS_VERSION,
      store: primary.href,
      sources: plain ? undefined : sources,
      layers: settings.layers,
      level: settings.level,
      pixelsPerPing: settings.pixelsPerPing,
      colormap: settings.colormap,
      filter: settings.filter as 'nearest' | 'linear',
      nodataColor: settings.nodataColor,
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
   * Adopt a configuration, opening its stores first where they are not the ones
   * already open.
   */
  async applySettings(settings: ViewSettings) {
    const named = settings.store ? [{ id: MAIN_SOURCE, store: settings.store }] : [];
    const wanted = settings.sources ?? named;
    // A step is the same source while it names the same datasets.
    const key = (source: { id: string; store?: string; spec?: PieceSetSpec }) => {
      const datasets = source.spec?.pieces.map((piece) => piece.id);
      return `${source.id}=${source.store ?? JSON.stringify(datasets)}`;
    };
    const open = [...this.sources.values()].map((source) => {
      const found = source.setting();
      return found ? key(found) : `${source.id}=`;
    });
    const asked = wanted.map(key);
    if (wanted.length && open.join('|') !== asked.join('|')) {
      const input = (source: SourceSetting): SourceInput => source.store ?? source.spec!;
      const [first, ...rest] = wanted;
      if (first.id === MAIN_SOURCE) await this.setStore(input(first));
      else {
        for (const id of this.sourceIds) await this.removeSource(id);
        await this.addSource(first.id, input(first));
      }
      for (const source of rest) await this.addSource(source.id, input(source));
    }
    if (this.destroyed) return;
    await this.setOptions({
      layers: settings.layers,
      level: settings.level,
      pixelsPerPing: settings.pixelsPerPing,
      colormap: settings.colormap,
      filter: settings.filter,
      nodataColor: settings.nodataColor,
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
    const base = this.base;
    const state = base?.state;
    if (!base || !state || !this.viewport) return undefined;
    const { settings } = this;
    const multiscales = base.multiscales;
    const contexts = this.contexts;
    const sources = [...this.sources.values()];
    const status = sources.map((source) => source.status);
    const sum = (of: (s: (typeof status)[number]) => number) =>
      status.reduce((total, s) => total + of(s), 0);
    return {
      levels: base.levelCount,
      level: state.index,
      levelChoice: settings.level,
      pixelsPerPing: settings.pixelsPerPing,
      factor: state.factor,
      channels: state.level.channels,
      channel: settings.channel,
      channelNames: multiscales.channelNames,
      channelFrequencies: multiscales.channelFrequencies,
      layers: settings.layers,
      problems: [...this.problems].map(([layer, problem]) => ({
        layer,
        message: problem.message,
      })),
      pings: state.shape.pings,
      samples: state.shape.samples,
      valueName: multiscales.name,
      verticalRef: multiscales.verticalRef,
      xUnit: settings.xUnit,
      yUnit: settings.yUnit,
      nodataColor: settings.nodataColor,
      xLabel: xAxisLabel(settings.xUnit, state.context),
      yLabel: yAxisLabel(settings.yUnit, state.context),
      validX: sharedXUnits(contexts),
      validY: sharedYUnits(contexts),
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
        resident: sum((s) => s.resident),
        loading: sum((s) => s.loading),
        failed: sum((s) => s.failed),
        skipped: sum((s) => s.skipped),
        uploading: this.uploader.pending,
        cachedBytes: this.context.tiles.size,
        levelsHeld: sum((s) => s.levelsHeld),
        redrawMs: this.redrawMs,
      },
      sources: sources.map((source) => {
        const found = source.multiscales;
        return {
          id: source.id,
          kind: source.kind,
          store: source.href,
          levels: source.levelCount,
          level: source.target,
          channels: source.channels ?? 0,
          channelNames: found.channelNames,
          channelFrequencies: found.channelFrequencies,
          valueName: found.name,
          dataType: found.dataType,
          verticalRef: found.verticalRef,
        };
      }),
      notes: this.notes(),
    };
  }

  /** What a host should say about the sources, together and one by one. */
  private notes(): string[] {
    const sources = [...this.sources.values()];
    const notes = sources.flatMap((source) => source.notes());
    const references = new Set(sources.map((source) => source.multiscales.verticalRef));
    if (references.size < 2) return notes;
    return [
      'The sources are drawn on different vertical references, range from the ' +
        'transducer and depth from the surface, so they are offset by the ' +
        'transducer depth.',
      ...notes,
    ];
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
    this.observer.disconnect();
    this.unwatchDevice();
    this.detach();
    this.unhover();
    this.texels?.destroy();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.decode?.destroy();
    this.uploader.clear();
    // Released, not destroyed. The pool and the cache belong to the context and
    // outlive this view, so what closing a panel has to do is hand back every
    // texture it took: NFR-18 is that N panels opened and closed leave the
    // allocation where it started.
    for (const source of this.sources.values()) source.destroy();
    this.sources.clear();
    this.layer?.destroy();
    this.reducer?.destroy();

    this.surface.unconfigure();
    this.canvas.remove();
    this.layer = undefined;
  }

  private configure() {
    this.surface.configure({
      device: this.context.device,
      format: this.context.format,
      alphaMode: 'opaque',
    });
  }

  /** Shallowest and deepest any source reaches, in the current vertical unit. */
  private get yBounds(): Extent {
    return union(this.allBounds().map((bounds) => bounds.y));
  }

  /**
   * Horizontal extent of every source in the current unit.
   *
   * Derived rather than stored, because it changes with the axis: the same
   * data spans 1211 pings and 7466 metres.
   */
  private get xBounds(): Extent {
    return union(this.allBounds().map((bounds) => bounds.x));
  }

  private allBounds(): { x: Extent; y: Extent }[] {
    const found: { x: Extent; y: Extent }[] = [];
    for (const source of this.sources.values()) {
      const bounds = source.bounds();
      if (bounds) found.push(bounds);
    }
    return found;
  }

  /**
   * Open on the whole of the data, free, filling the canvas, or on as much of
   * it as the first source can load where the whole would be too much.
   */
  private resetViewport() {
    this.viewport = fitAll(this.xBounds, this.yBounds, {
      width: this.canvas.width,
      height: this.canvas.height,
    });
    const primary = this.primary;
    const opening = primary?.openingX(this.channelsFor(primary.id).length);
    if (opening) this.viewport.reframe(opening, this.yBounds);
    // Locked at the shape the fit produced, so a new view looks the same and
    // a zoom keeps its proportions. A setting naming a mode still wins.
    this.viewport.setMode('locked', this.viewport.exaggeration);
    this.window = undefined;
  }

  private replaceAxes() {
    for (const source of this.sources.values()) source.replaceAxes();
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
    const primary = this.primary!;
    let [x, y] = [view.x, view.y];
    // Datetime and seconds are one data space with two labellings.
    const time = (unit: XUnit) => unit === 'datetime' || unit === 'seconds';
    const sameSpace = time(next.xUnit) && time(was.x);
    if (next.xUnit !== was.x && wasAxis && !sameSpace && primary.someState) {
      x = remapRange(wasAxis, primary.someState.axis, x);
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
    const geometry = this.primary!.someState!.vertical;
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
    const axis = this.primary!.windowAxis()!;
    const view = this.viewport!;
    this.window = resolveWindow(request, {
      axis,
      epochNs: this.epochNs ?? 0,
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

  /** Pack and upload the geometry of any level not already holding it. */
  private uploadGeometry() {
    for (const source of this.sources.values()) {
      source.uploadGeometry(this.channelsFor(source.id));
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
    // A wheel zoom moves the data under a pointer that has not moved.
    if (this.pointer) this.hover();
    this.retargetStale(true);
  }

  /**
   * Load the level each source now calls for, then redraw.
   *
   * Choosing a level reads the store, so it happens after the frame that used
   * the level already loaded rather than in front of it.
   */
  private retargetStale(report: boolean) {
    const generation = this.generation;
    const current = () => generation === this.generation && !this.destroyed;
    for (const source of this.sources.values()) {
      if (!source.stale) continue;
      void source
        .retarget(current)
        .then(() => {
          if (!current()) return;
          this.uploadGeometry();
          this.refreshTiles();
          this.render();
          if (report) this.onViewChange?.();
        })
        .catch((error) => this.onError?.(error));
    }
  }

  /**
   * How fast the view is travelling, and whether it has stopped.
   *
   * In x units a second; each source converts that to its own source pings,
   * which is the unit the ring is measured in. A view that is still moving asks
   * only for the coarse fill, and this is what says so: the timer is what turns
   * a drag into a rest, and a rest is when the target level is finally worth
   * the bytes.
   */
  private trackMotion() {
    if (!this.viewport) return;
    const now = performance.now();
    const centre = (this.viewport.x[0] + this.viewport.x[1]) / 2;
    const elapsed = (now - this.motion.at) / 1000;

    // A first move, or one after a long pause, has no speed to report. Taking
    // one from a stale timestamp would read as an enormous velocity and reach
    // the ring across the whole survey.
    if (elapsed > 0 && elapsed < 0.5) {
      const speed = (centre - this.motion.centre) / elapsed;
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
   * Decide what draws, fetch what is missing, drop what is stale.
   *
   * Each source divides the view into slots at its own target level and says
   * what each layer reading it draws. The passes are put back in stack order,
   * which is draw order, whichever source a layer reads.
   */
  private refreshTiles() {
    if (!this.layer || !this.viewport) return;
    this.clock += 1;
    const now = performance.now();

    const visible = drawn(this.settings.layers).filter(
      (layer) => !this.problems.has(layer.id),
    );
    const draws = new Map<string, SlotDraw[]>();
    let slots = 0;
    let blank = 0;
    let standingIn = 0;
    for (const source of this.sources.values()) {
      source.stamp(now);
      const own = visible.filter((layer) => layer.source === source.id);
      const result = source.refresh(own, this.channelsFor(source.id));
      for (const [id, found] of result.draws) draws.set(id, found);
      slots += result.onScreen * Math.max(own.length, 1);
      blank += result.blank;
      standingIn += result.standingIn;
    }

    this.slots = slots;
    this.blank = blank;
    this.standingIn = standingIn;
    this.passes = visible.map((layer) => ({
      layer: layer.id,
      draws: draws.get(layer.id) ?? [],
    }));
    this.layer.setDraws(this.passes);
    this.evict();
    for (const source of this.sources.values()) source.prune();
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
        // A tile under the pointer may be among those that landed.
        if (this.pointer) this.hover();
      }
      if (this.uploader.pending) this.scheduleFrame();
    });
  }

  /**
   * Drop tiles once tiles in use hold more than the pool's share for them. What
   * is left of the budget is the free list the pool reuses from, which is what
   * keeps a pan off the allocator.
   *
   * Nothing wanted this refresh goes, and nothing goes at all under the share:
   * a tile no longer wanted stays while there is room, since the tile a zoom
   * out left behind is the tile a zoom back in asks for first. Over the share,
   * tiles out of frame for longer than the grace go first, the one out of frame
   * longest first. Then tiles in frame or barely out of it, farthest level
   * from the target first, because a level five steps finer than the one drawn
   * is five zooms from being drawn and a level one step away is one. Every
   * source offers its tiles to the same ordering, since they share one pool.
   */
  private evict() {
    if (this.pool.inUse <= this.pool.share) return;
    const now = performance.now();
    const spare: Spare[] = [];
    for (const source of this.sources.values()) {
      const channels = Math.max(this.channelsFor(source.id).length, 1);
      spare.push(...source.spare(now, channels));
    }
    spare.sort((a, b) => {
      if (a.graced !== b.graced) return a.graced ? 1 : -1;
      if (a.graced && a.distance !== b.distance) return b.distance - a.distance;
      return b.idle - a.idle;
    });
    while (spare.length && this.pool.inUse > this.pool.share) {
      spare.shift()!.release();
    }
  }

  /** Forget what was drawn, as when every source is replaced. */
  private clearDraws() {
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
      nodataColor: parseHex(this.settings.nodataColor),
      nodataThreshold: this.primary!.multiscales.nodataThreshold,
    });
    if (this.destroyed) {
      stack.destroy();
      return;
    }
    this.layer?.destroy();
    this.layer = stack;
    for (const source of this.sources.values()) source.reinstall(stack);
    stack.setDraws(this.passes);
  }

  /** Re-upload and rebuild after the device was replaced. */
  private async rebuild() {
    if (this.destroyed || !this.sources.size) return;
    this.configure();
    // Every texture belonged to the device that went away, tiles included. The
    // context has already replaced the pool by the time this runs, so letting
    // the levels go is all this view has to do about it.
    for (const source of this.sources.values()) source.dropLevels(false);
    this.uploader.clear();
    this.clearDraws();
    this.layer = undefined;
    this.buildStack();
    await this.applyLayers(this.settings.layers);
    for (const source of this.sources.values()) await source.reload();
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
