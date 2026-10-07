/**
 * Many datasets laid side by side in time, as one source.
 *
 * What a step mapped over raw files leaves: one dataset per file, possibly
 * thousands, never merged because their sample grids differ. The spec the
 * host hands over places every one of them in time, so the source is laid
 * out before any of it is read. Which pieces to open is decided from the view,
 * nearest the centre first, within a budget (`geometry/pieces.ts`), and a
 * piece is opened whole: its header, then a one level pyramid source drawn
 * the way any other is.
 *
 * Every piece counts its pings from its own start, so a view holding pieces
 * offers only time against metres.
 */

import { FetchStore } from '../data/FetchStore';
import type { Multiscales } from '../data/contract';
import {
  type Header,
  type PieceSetSpec,
  type PieceSpec,
  describedStore,
  fetchJson,
  multiscalesOf,
} from '../data/pieces';
import { PriorityStore } from '../data/store';
import type { AxisContext } from '../geometry/axes';
import { type Extent, type XAxisValues, cellEdges } from '../geometry/coords';
import { type PieceExtent, choosePieces, openingExtent } from '../geometry/pieces';
import type { LayerStack } from '../render/drawLayer';
import type { AlignmentProblem } from './alignment';
import type { Layer } from './layers';
import {
  type LevelState,
  type ReduceInput,
  type SourceHost,
  type SourceRefresh,
  type SourceStatus,
  type Spare,
  type ViewSource,
  PyramidSource,
  VALUE_BYTES,
} from './Source';

/**
 * Bytes a piece source may fetch for what is held, compressed.
 *
 * The texture budget follows from the pool; this one is about the link. Sv at
 * full resolution is tens of megabytes a file, so it is what keeps a wide
 * window of Sv from asking for a gigabyte, while MVBS fits hundreds of files.
 */
export const DEFAULT_TRANSFER_BUDGET = 512 * 1024 * 1024;

/** Most pieces held open at once, each a store with its own scheduler. */
export const DEFAULT_PIECE_COUNT = 128;

/**
 * Most points the window axis holds.
 *
 * A survey of EK80 files runs to millions of pings, and an axis with one
 * point each is hundreds of megabytes to resolve a window against. Beyond
 * this, each piece is sampled evenly, which costs a window only how finely
 * it snaps.
 */
export const WINDOW_POINTS = 200_000;

interface Piece {
  instance: PieceSpec;
  /**
   * Seconds from the view's time origin, first ping to last. Set by `place`,
   * since the origin is the view's and is only settled once it opens.
   */
  x: Extent;
  source?: PyramidSource;
  opening?: Promise<void>;
  failed?: boolean;
}

export class PieceSource implements ViewSource {
  readonly kind = 'pieces';
  readonly levelCount = 1;
  readonly target = 0;
  readonly href = undefined;

  private pieces: Piece[];
  /** Chosen for the view, nearest the centre first. */
  private active: Piece[] = [];
  private deferred = 0;
  private header?: Header;
  private prepared?: AxisContext;
  private placed = false;
  private destroyed = false;
  private axis?: XAxisValues;
  /** Channels the stack reads, which is what a piece costs to draw. */
  private channelsUsed = 1;
  /** Costs per piece, which change only with the channels drawn. */
  private costs?: { channels: number; extents: PieceExtent[] };
  /** The last choice and what it was made for, since a move asks twice. */
  private choice?: { key: string; chosen: Piece[]; deferred: number };

  constructor(
    readonly id: string,
    readonly spec: PieceSetSpec,
    private allocate: (count: number) => number,
    private host: SourceHost,
    private transferBudget = DEFAULT_TRANSFER_BUDGET,
    private countBudget = DEFAULT_PIECE_COUNT,
  ) {
    const instances = spec.pieces;
    if (!instances.length) throw new Error(`${spec.name} has no dataset to draw`);
    this.pieces = instances
      .map((instance) => ({ instance, x: [0, 0] as Extent }))
      .sort((a, b) => a.instance.start - b.instance.start);
  }

  /**
   * Put every piece on the view's time axis.
   *
   * Not in the constructor: a view replacing its sources opens the new one
   * before it lets the old go, and the time origin is reset in between. Placed
   * against the origin that held when the piece was built, every piece would
   * be offset from the tiles drawn for it.
   */
  place() {
    if (this.placed) return;
    const first = Math.min(...this.pieces.map((piece) => piece.instance.start));
    const epoch = this.host.epoch(first);
    for (const piece of this.pieces) {
      piece.x = [(piece.instance.start - epoch) / 1e9, (piece.instance.end - epoch) / 1e9];
    }
    this.placed = true;
  }

  get context(): AxisContext | undefined {
    return this.prepared;
  }

  /** What a second window needs to open this source again. */
  setting() {
    return { id: this.id, spec: this.spec };
  }

  get multiscales(): Multiscales {
    if (this.header) return multiscalesOf(this.header);
    return {
      name: 'Sv',
      axes: [],
      datasets: [{ path: '', factors: { ping: 1, sample: 1 } }],
      aggregation: 'none',
      nodata: -9999,
      nodataThreshold: -5000,
      dataType: 'Sv',
      channelDim: null,
      verticalRef: 'depth',
    };
  }

  get channels(): number | undefined {
    return this.header?.channels ?? this.pieces[0].instance.channels;
  }

  /** The open piece nearest the centre, which single store questions use. */
  private get nearest(): PyramidSource | undefined {
    const open = this.active.find((piece) => piece.source)?.source;
    return open ?? this.pieces.find((piece) => piece.source)?.source;
  }

  get state(): LevelState | undefined {
    return this.nearest?.state;
  }

  get someState(): LevelState | undefined {
    return this.nearest?.someState;
  }

  /**
   * Open the piece in the middle, which is what says how deep the data goes
   * and what it holds. The rest wait for a view to choose them.
   */
  async prepare(): Promise<AxisContext> {
    this.place();
    if (!this.header) {
      const middle = (this.pieces[0].x[0] + this.pieces[this.pieces.length - 1].x[1]) / 2;
      const piece = this.pieces.reduce((best, next) =>
        Math.abs(next.x[0] - middle) < Math.abs(best.x[0] - middle) ? next : best,
      );
      await this.open(piece);
      if (!piece.source) throw new Error(`could not open ${piece.instance.store}`);
    }
    const header = this.header!;
    this.prepared = {
      dataType: header.dataType,
      verticalRef: header.verticalRef,
      hasGps: false,
      timeOnly: true,
    };
    return this.prepared;
  }

  bounds(): { x: Extent; y: Extent } | undefined {
    if (!this.placed) return undefined;
    const ys = this.pieces.flatMap((piece) => {
      const found = piece.source?.bounds();
      return found ? [found.y] : [];
    });
    if (!ys.length) return undefined;
    return {
      x: [this.pieces[0].x[0], Math.max(...this.pieces.map((piece) => piece.x[1]))],
      y: [Math.min(...ys.map((y) => y[0])), Math.max(...ys.map((y) => y[1]))],
    };
  }

  /**
   * An axis over the pings of every piece, placed evenly between each
   * piece's first and last ping, and sampled where there are more than
   * WINDOW_POINTS of them. Close enough to resolve a window against, and
   * built from the index alone.
   */
  windowAxis(): XAxisValues | undefined {
    if (!this.placed) return undefined;
    if (this.axis) return this.axis;
    const total = this.pieces.reduce((sum, piece) => sum + piece.instance.pings, 0);
    const stride = Math.max(1, Math.ceil(total / WINDOW_POINTS));
    const counts = this.pieces.map((piece) =>
      Math.max(1, Math.min(piece.instance.pings, Math.ceil(piece.instance.pings / stride))),
    );
    const centre = new Float64Array(counts.reduce((sum, count) => sum + count, 0));
    let at = 0;
    this.pieces.forEach((piece, index) => {
      const count = counts[index];
      const span = piece.x[1] - piece.x[0];
      for (let i = 0; i < count; i += 1) {
        centre[at] = piece.x[0] + (count > 1 ? (span * i) / (count - 1) : 0);
        at += 1;
      }
    });
    const { left, right } = cellEdges(centre);
    this.axis = { unit: this.host.xUnit, centre, left, right };
    return this.axis;
  }

  openingX(channels: number): Extent | undefined {
    if (!this.placed) return undefined;
    return openingExtent(this.extents(channels), this.budget());
  }

  private budget() {
    return {
      texture: this.host.context.pool.share / Math.max(1, this.host.sourceCount),
      transfer: this.transferBudget / Math.max(1, this.host.sourceCount),
      count: this.countBudget,
    };
  }

  /** What each piece costs to draw this many channels of. */
  private extents(channels: number): PieceExtent[] {
    const used = Math.max(channels, 1);
    if (this.costs?.channels === used) return this.costs.extents;
    const extents = this.pieces.map((piece) => {
      const { pings, samples, bytes } = piece.instance;
      const share = Math.min(used / Math.max(piece.instance.channels, 1), 1);
      const stored = bytes ?? pings * samples * 4 * piece.instance.channels;
      return {
        x: piece.x,
        texture: pings * samples * VALUE_BYTES * used,
        transfer: stored * share,
      };
    });
    this.costs = { channels: used, extents };
    return extents;
  }

  /**
   * The pieces for the view as it stands.
   *
   * Remembered for the view it was made for: every pointer move asks whether
   * the choice is stale and then makes it, and with thousands of pieces the
   * second pass is not free.
   */
  private choose(): { chosen: Piece[]; deferred: number } {
    const viewport = this.host.viewport;
    if (!viewport || !this.placed) return { chosen: [], deferred: 0 };
    const budget = this.budget();
    const key = [
      viewport.x[0],
      viewport.x[1],
      this.channelsUsed,
      budget.texture,
      budget.transfer,
    ].join('|');
    if (this.choice?.key === key) return this.choice;
    const found = choosePieces(this.extents(this.channelsUsed), viewport.x, budget);
    this.choice = {
      key,
      chosen: found.chosen.map((index) => this.pieces[index]),
      deferred: found.deferred,
    };
    return this.choice;
  }

  get stale(): boolean {
    const { chosen } = this.choose();
    if (chosen.length !== this.active.length) return true;
    return chosen.some((piece, index) => piece !== this.active[index]);
  }

  /**
   * Choose the pieces for the view and start opening the ones not open.
   *
   * Not awaited: each piece redraws the view as it arrives, nearest the
   * centre first because that is the order they are asked for in.
   */
  async retarget(current: () => boolean) {
    const { chosen, deferred } = this.choose();
    if (!current()) return;
    this.active = chosen;
    this.deferred = deferred;
    for (const piece of chosen) {
      if (piece.source || piece.opening || piece.failed) continue;
      void this.open(piece).then(() => {
        if (piece.source && !this.destroyed) this.host.levelLoaded();
      });
    }
  }

  /** Fetch a piece's header and open it as a one level store. */
  private open(piece: Piece): Promise<void> {
    if (piece.opening) return piece.opening;
    piece.opening = (async () => {
      const header = await fetchJson<Header>(piece.instance.header);
      this.header ??= header;
      const chunks = new PriorityStore(new FetchStore(piece.instance.store));
      const store = await describedStore(header, chunks);
      const source = PyramidSource.fromStore(
        `${this.id}:${piece.instance.id.slice(0, 12)}`,
        store,
        chunks,
        true,
        undefined,
        this.allocate,
        this.host,
        false,
      );
      await source.ensureLevel(0);
      if (this.destroyed) {
        source.destroy();
        return;
      }
      piece.source = source;
    })()
      .catch((error) => {
        piece.failed = true;
        this.host.onError(error);
      })
      .finally(() => {
        piece.opening = undefined;
      });
    return piece.opening;
  }

  private get held(): PyramidSource[] {
    return this.pieces.flatMap((piece) => (piece.source ? [piece.source] : []));
  }

  refresh(layers: Layer[], channels: number[]): SourceRefresh {
    this.channelsUsed = channels.length;
    const result: SourceRefresh = { draws: new Map(), onScreen: 0, blank: 0, standingIn: 0 };
    for (const piece of this.active) {
      if (!piece.source) continue;
      const found = piece.source.refresh(layers, channels);
      for (const [layer, draws] of found.draws) {
        const held = result.draws.get(layer);
        if (held) held.push(...draws);
        else result.draws.set(layer, [...draws]);
      }
      result.onScreen += found.onScreen;
      result.blank += found.blank;
      result.standingIn += found.standingIn;
    }
    return result;
  }

  stamp(now: number) {
    for (const source of this.held) source.stamp(now);
  }

  /**
   * Tiles eviction may take. A piece the view no longer chooses goes before
   * any it does, and among those the farthest from the centre first.
   */
  spare(now: number, channels: number): Spare[] {
    const viewport = this.host.viewport;
    const middle = viewport ? (viewport.x[0] + viewport.x[1]) / 2 : 0;
    const width = viewport ? viewport.x[1] - viewport.x[0] || 1 : 1;
    const chosen = new Set(this.active);
    const spare: Spare[] = [];
    for (const piece of this.pieces) {
      if (!piece.source) continue;
      const distance = Math.abs((piece.x[0] + piece.x[1]) / 2 - middle) / width;
      const wanted = chosen.has(piece);
      for (const found of piece.source.spare(now, channels)) {
        spare.push({ ...found, graced: wanted && found.graced, distance });
      }
    }
    return spare;
  }

  /** Close pieces the view does not choose once eviction has emptied them. */
  prune() {
    const chosen = new Set(this.active);
    for (const piece of this.pieces) {
      const source = piece.source;
      if (!source) continue;
      source.prune();
      if (chosen.has(piece) || source.status.resident) continue;
      source.destroy();
      piece.source = undefined;
    }
  }

  uploadGeometry(channels: number[]) {
    for (const source of this.held) source.uploadGeometry(channels);
  }

  replaceAxes() {
    this.axis = undefined;
    for (const source of this.held) source.replaceAxes();
  }

  dropChannels(keep: number[]) {
    for (const source of this.held) source.dropChannels(keep);
  }

  reinstall(stack: LayerStack) {
    for (const source of this.held) source.reinstall(stack);
  }

  retry() {
    for (const piece of this.pieces) piece.failed = false;
    for (const source of this.held) source.retry();
  }

  async reload() {
    await Promise.all(this.held.map((source) => source.reload()));
  }

  dropLevels(giveBack = true) {
    for (const source of this.held) source.dropLevels(giveBack);
  }

  destroy(giveBack = true) {
    this.destroyed = true;
    for (const piece of this.pieces) {
      piece.source?.destroy(giveBack);
      piece.source = undefined;
    }
  }

  channelName(channel: number): string {
    const frequency = this.header?.channelFrequencies?.[channel];
    if (frequency) return `${Math.round(frequency / 1000)} kHz`;
    return this.header?.channelNames?.[channel] ?? `channel ${channel}`;
  }

  alignmentProblems(layers: Layer[], problems: Map<string, AlignmentProblem>) {
    this.nearest?.alignmentProblems(layers, problems);
  }

  /** The cell under a point, from the open piece whose span holds it. */
  probe(x: number, y: number, channel: number) {
    const piece = this.pieces.find(
      (candidate) => candidate.source && x >= candidate.x[0] && x <= candidate.x[1],
    );
    return piece?.source?.probe(x, y, channel);
  }

  /** Statistics from the piece nearest the centre. */
  reduceInput(channel: number, x: Extent, y: Extent): ReduceInput | undefined {
    return this.nearest?.reduceInput(channel, x, y);
  }

  get status(): SourceStatus {
    const total: SourceStatus = {
      resident: 0,
      loading: 0,
      failed: 0,
      skipped: 0,
      levelsHeld: 0,
    };
    for (const source of this.held) {
      const found = source.status;
      total.resident += found.resident;
      total.loading += found.loading;
      total.failed += found.failed;
      total.skipped += found.skipped;
      total.levelsHeld += found.levelsHeld;
    }
    total.loading += this.pieces.filter((piece) => piece.opening).length;
    return total;
  }

  notes(): string[] {
    const notes: string[] = [];
    if (this.deferred) {
      notes.push(
        `${this.deferred} of the files in view are not loaded, past what ` +
          `${this.spec.name} may hold at once. Zoom in to load them.`,
      );
    }
    const failed = this.pieces.filter((piece) => piece.failed).length;
    if (failed) notes.push(`${failed} files of ${this.spec.name} failed to open.`);
    return notes;
  }
}
