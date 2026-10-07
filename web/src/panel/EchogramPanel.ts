/**
 * An echogram with the controls that change how it is drawn.
 *
 * The view plus its layer stack, axes and aspect, display settings and tools,
 * each in a section that collapses to a one line header so the echogram can
 * take the room. What is under the pointer is shown in the corner of the
 * echogram.
 *
 * What it does not have is any way of choosing data. A host decides where
 * data comes from, from a recipe, a cache or a list of paths, and hands it to
 * `setStore`, `addSource` or `replaceSource`; its own picker can go in a
 * section of the panel through `addSection`.
 */

import {
  type EchogramViewOptions,
  type Probe,
  type SetStoreOptions,
  type SourceInput,
  type ViewInfo,
  type ViewStatistics,
  EchogramView,
} from '../app/EchogramView';
import { channelOptions } from '../app/channels';
import type { ViewSettings } from '../app/settings';
import { PIXELS_PER_PING } from '../geometry/levels';
import { colormapNames } from '../render/colormaps';
import { type AspectControls, createAspectControls } from './controls/aspect';
import { type AxisControls, createAxisControls } from './controls/axes';
import { type BoundsControls, createBoundsControls } from './controls/bounds';
import {
  type LayerControls,
  type SourceOption,
  createLayerControls,
} from './controls/layers';
import { defaultLayerFor } from './defaults';
import { formatProbe } from './readout';
import { type Section, createSection, readSections, writeSections } from './sections';
import { injectStyles } from './styles';

export interface EchogramPanelOptions
  extends Pick<EchogramViewOptions, 'context' | 'spawnWorker' | 'decodeWorkers' | 'background'> {
  container: HTMLElement;
  /** Told of every error the panel shows, for a host that logs them. */
  onError?: (error: unknown) => void;
  /** Called when the view moves or settles, as `EchogramView` calls it. */
  onViewChange?: () => void;
  /** Where to remember which sections are open. Absent remembers nothing. */
  storageKey?: string;
  /** Sections open when nothing is remembered. Layers alone by default. */
  open?: string[];
}

/** Errors kept in the box, newest first. Tile failures arrive in bursts. */
const SHOWN_ERRORS = 8;

/** The panel's own sections, in the order they are drawn. */
const SECTIONS: [string, string][] = [
  ['layers', 'Layers'],
  ['view', 'Axes and view'],
  ['display', 'Display and tools'],
];

export class EchogramPanel {
  readonly view: EchogramView;
  /** The panel's root, inside the container it was given. */
  readonly element: HTMLElement;

  private bars: HTMLElement;
  private sections = new Map<string, Section>();
  private state: Record<string, boolean>;
  private storageKey?: string;
  private readout: HTMLElement;
  private errorBox: HTMLElement;
  private shown: string[] = [];
  private onError?: (error: unknown) => void;
  private onViewChange?: () => void;

  private layers: LayerControls;
  private axes: AxisControls;
  private aspect: AspectControls;
  private bounds: BoundsControls;
  private level: HTMLSelectElement;
  private density: HTMLSelectElement;
  private colormap: HTMLSelectElement;
  private filter: HTMLSelectElement;
  private nodata: HTMLInputElement;
  private result: HTMLElement;

  constructor(options: EchogramPanelOptions) {
    injectStyles();
    this.onError = options.onError;
    this.onViewChange = options.onViewChange;
    this.storageKey = options.storageKey;
    this.state = options.storageKey
      ? readSections(storage(), options.storageKey)
      : {};
    const open = new Set(options.open ?? ['layers']);
    for (const [id] of SECTIONS) this.state[id] ??= open.has(id);

    this.element = node('div', 'egl-panel');
    this.bars = node('div', 'egl-bars');
    const plot = node('div', 'egl-plot');
    this.readout = node('div', 'egl-readout');
    this.errorBox = node('pre', 'egl-error');
    this.element.append(this.bars, plot);
    options.container.append(this.element);

    for (const [id, title] of SECTIONS) this.section(id, title);
    const layerBody = this.sections.get('layers')!.body;
    layerBody.classList.add('egl-stack');
    const add = button('add layer');
    const list = node('div');
    layerBody.append(row(add, text('bottom row draws first', 'egl-note')), list);
    this.layers = createLayerControls(list, add, () => void this.apply());

    const view = this.sections.get('view')!.body;
    const xUnit = node('select') as HTMLSelectElement;
    const yUnit = node('select') as HTMLSelectElement;
    this.axes = createAxisControls(xUnit, yUnit, () => void this.apply());
    const mode = options_(['free', 'locked']);
    const slider = node('input') as HTMLInputElement;
    slider.type = 'range';
    const exaggeration = text('1.00', 'egl-number');
    const trueScale = button('true scale');
    const fitAll = button('fit all');
    this.aspect = createAspectControls(
      { mode, slider, readout: exaggeration, trueScale },
      () => void this.apply(),
    );
    const boundInputs = ['x min', 'x max', 'y min', 'y max'].map(
      () => node('input') as HTMLInputElement,
    );
    const boundsNote = text('', 'egl-note');
    this.bounds = createBoundsControls(
      {
        xMin: boundInputs[0],
        xMax: boundInputs[1],
        yMin: boundInputs[2],
        yMax: boundInputs[3],
        note: boundsNote,
      },
      () => void this.apply(),
    );
    const sliderLabel = labelled('exaggeration', slider);
    sliderLabel.classList.add('egl-slider');
    sliderLabel.insertBefore(exaggeration, slider);
    const bounds = node('div', 'egl-row egl-bounds');
    bounds.style.padding = '0';
    bounds.append(
      ...['x min', 'x max', 'y min', 'y max'].map((name, i) =>
        labelled(name, boundInputs[i]),
      ),
      boundsNote,
    );
    view.append(
      labelled('x axis', xUnit),
      labelled('y axis', yUnit),
      labelled('aspect', mode),
      sliderLabel,
      trueScale,
      fitAll,
      bounds,
    );
    trueScale.addEventListener('click', () => {
      this.aspect.set('locked', 1);
      // A preset is closer to a policy change than to a drag, so it holds the
      // horizontal whether or not the policy was already locked.
      void this.apply('x');
    });
    // Both extents cannot fit at an arbitrary factor, and the factor is the
    // thing on screen the user can see and change, so it is what gives.
    fitAll.addEventListener('click', () => void this.apply(undefined, { fit: true }));

    const display = this.sections.get('display')!.body;
    this.level = options_(['auto']);
    // One is a ping to a pixel, which is what the pyramid is built to serve.
    // The wider settings coarsen sooner. Nothing below one: a drawn ping
    // narrower than a pixel is detail the screen cannot show.
    this.density = options_(['1', '2', '4', '8']);
    this.density.value = String(PIXELS_PER_PING);
    this.colormap = options_(colormapNames());
    this.filter = options_(['nearest', 'linear']);
    this.nodata = node('input') as HTMLInputElement;
    this.nodata.type = 'color';
    this.nodata.value = '#2e2e2e';
    const nodataLabel = labelled('no data', this.nodata);
    nodataLabel.title =
      'Cells with no value: removed noise, masked seabed and surface, beyond the ' +
      'recorded range';
    display.append(
      labelled('level', this.level),
      labelled('px/ping', this.density),
      labelled('colormap', this.colormap),
      nodataLabel,
      labelled('sampling', this.filter),
    );
    // Settings on what is open. None of them reopens anything.
    for (const input of [this.level, this.density, this.colormap, this.filter, this.nodata]) {
      input.addEventListener('change', () => void this.apply());
    }

    const contrast = button('auto contrast');
    const measure = button('measure');
    this.result = text('', 'egl-result');
    display.append(contrast, measure, this.result);
    contrast.addEventListener('click', () => {
      void this.guard(async () => {
        await this.view.autoContrast();
        // The limits it chose are on the layers now, so the rows follow what
        // the view settled on rather than showing the old ones.
        this.syncLayers();
      });
    });
    measure.addEventListener('click', () => {
      void this.guard(async () => {
        const found = await this.view.statistics();
        this.result.textContent = found ? describeStatistics(found) : 'nothing resident';
      });
    });

    plot.append(this.readout, this.errorBox);
    this.view = new EchogramView({
      container: plot,
      context: options.context,
      background: options.background,
      spawnWorker: options.spawnWorker,
      decodeWorkers: options.decodeWorkers,
      onError: (error) => this.showError(error),
      onViewChange: () => {
        this.describe();
        this.onViewChange?.();
      },
      onHover: (probe) => this.showReadout(probe),
    });
    // The canvas sits under the readout and the error box.
    plot.prepend(this.view.canvas);
  }

  /** Open a store, replacing every source. */
  async setStore(input: SourceInput, options: SetStoreOptions = {}) {
    this.clearErrors();
    await this.view.setStore(input, {
      colormap: this.colormap.value,
      filter: this.filter.value as GPUFilterMode,
      ...options,
    });
    this.syncLayers();
  }

  /**
   * Add a source, and a layer showing it unless `layer` is false.
   *
   * The layer goes on top of the stack. The first source of an empty panel
   * takes the bottom.
   */
  async addSource(id: string, input: SourceInput, options: { layer?: boolean } = {}) {
    this.clearErrors();
    const first = !this.view.sourceIds.length;
    const kept = first ? [] : this.layers.read();
    await this.view.addSource(id, input);
    const added = this.view.info?.sources.find((source) => source.id === id);
    if ((options.layer ?? true) && added) {
      const layer = defaultLayerFor(added, this.colormap.value);
      await this.view.setOptions({ layers: [...kept, layer] });
    }
    this.syncLayers();
  }

  /** Open a source again from newer input, keeping its layers and the view. */
  async replaceSource(id: string, input: SourceInput) {
    this.clearErrors();
    await this.view.replaceSource(id, input);
    this.syncLayers();
  }

  /** Stop drawing a source, and the layers reading it. */
  async removeSource(id: string) {
    this.clearErrors();
    await this.view.removeSource(id);
    this.syncLayers();
  }

  get sourceIds(): string[] {
    return this.view.sourceIds;
  }

  /**
   * Ask the view again with nothing changed, which retries failed reads, as
   * a host's refresh may want after its data has been made available again.
   */
  async retry() {
    if (!this.view.sourceIds.length) return;
    await this.guard(() => this.view.setOptions({}));
  }

  get settingsObject(): ViewSettings | undefined {
    return this.view.settingsObject;
  }

  async applySettings(settings: ViewSettings) {
    await this.view.applySettings(settings);
    this.syncLayers();
  }

  /**
   * A section of the host's own, such as its data picker, above the panel's.
   *
   * Remembered open or closed like the panel's own, under the same key.
   */
  addSection(
    id: string,
    title: string,
    content: HTMLElement,
    options: { open?: boolean } = {},
  ): HTMLDetailsElement {
    const section = this.section(id, title, options.open ?? true);
    section.body.append(content);
    const firstOwn = this.sections.get(SECTIONS[0][0])!.element;
    this.bars.insertBefore(section.element, firstOwn);
    return section.element;
  }

  /**
   * Put a host's controls in one of the panel's own sections, after the
   * panel's, such as a button that opens the view in a second window.
   */
  appendTo(id: string, content: HTMLElement) {
    const section = this.sections.get(id);
    if (!section) throw new Error(`no section ${id}`);
    section.body.append(content);
  }

  /** Show an error over the echogram, newest first, and tell the host. */
  showError(error: unknown) {
    // A tile the view stopped wanting is cancelled on purpose, not a failure.
    if (error instanceof Error && error.name === 'AbortError') return;
    this.shown = [describeError(error), ...this.shown].slice(0, SHOWN_ERRORS);
    this.errorBox.style.display = 'block';
    this.errorBox.textContent = this.shown.join('\n\n');
    this.onError?.(error);
  }

  clearErrors() {
    this.shown = [];
    this.errorBox.style.display = 'none';
    this.errorBox.textContent = '';
  }

  destroy() {
    this.view.destroy();
    this.element.remove();
  }

  private section(id: string, title: string, fallback = false): Section {
    const section = createSection(id, title, this.state[id] ?? fallback, (key, open) => {
      this.state[key] = open;
      if (this.storageKey) writeSections(storage(), this.storageKey, this.state);
    });
    this.sections.set(id, section);
    this.bars.append(section.element);
    return section;
  }

  /** Run something that talks to the view, showing anything it throws. */
  private async guard(run: () => Promise<void>) {
    this.clearErrors();
    try {
      await run();
      this.describe();
    } catch (error) {
      this.showError(error);
    }
  }

  /**
   * Push every control at the view.
   *
   * One path rather than one per control, so a change never carries a stale
   * value from a box it did not read.
   */
  private async apply(hold?: 'x' | 'y', extra: { fit?: boolean } = {}) {
    if (!this.view.info) return;
    const { xUnit, yUnit } = this.axes.read();
    await this.guard(() =>
      this.view.setOptions({
        level: this.level.value === 'auto' ? 'auto' : Number(this.level.value),
        pixelsPerPing: Number(this.density.value),
        colormap: this.colormap.value,
        filter: this.filter.value as GPUFilterMode,
        nodataColor: this.nodata.value,
        layers: this.layers.read(),
        xUnit,
        yUnit,
        aspect: { ...this.aspect.read(), hold },
        window: this.bounds.take(),
        ...extra,
      }),
    );
  }

  /** Set the layer rows from the stack the view settled on. */
  private syncLayers() {
    this.layers.set(this.view.info?.layers.map((layer) => ({ ...layer })) ?? []);
    this.describe();
  }

  /** Fill the pickers from what the view reports. */
  private describe() {
    const info = this.view.info;
    if (!info) {
      this.showReadout(undefined);
      return;
    }
    fillLevels(this.level, info);
    this.density.value = String(info.pixelsPerPing);
    this.nodata.value = info.nodataColor;
    // A store with one level has nothing for either of these to choose between,
    // and a control that answers and does nothing is worse than one that says
    // it cannot.
    const single = info.levels <= 1;
    for (const control of [this.level, this.density]) {
      control.disabled = single;
      control.title = single
        ? 'this store has one level, so there is nothing to choose between'
        : '';
    }
    const sources: SourceOption[] = info.sources.map((source) => ({
      id: source.id,
      label: source.id,
      channels: channelOptions(source),
    }));
    this.layers.update(sources);
    this.axes.update(info);
    this.aspect.update(info);
    this.bounds.update(info);
    if (!this.readoutHeld) this.showReadout(undefined);
  }

  /** Whether the readout is showing a probe, which notes must not replace. */
  private readoutHeld = false;

  /**
   * The corner box: what is under the pointer, or, with nothing under it,
   * anything the view wants said, such as files left unloaded or a layer it
   * cannot draw.
   */
  private showReadout(probe: Probe | undefined) {
    this.readoutHeld = Boolean(probe);
    const box = this.readout;
    box.replaceChildren();
    if (probe) {
      const found = formatProbe(probe);
      for (const line of [...found.position, ...found.values]) box.append(line, '\n');
      if (found.cell) box.append(text(found.cell, 'egl-dim'));
      return;
    }
    const info = this.view?.info;
    const warnings = [
      ...(info?.notes ?? []),
      ...(info?.problems ?? []).map((problem) => `${problem.layer}: ${problem.message}`),
    ];
    for (const warning of warnings) {
      const line = node('div', 'egl-warn');
      line.textContent = warning;
      box.append(line);
    }
  }
}

/**
 * What a reduction measured.
 *
 * The level is named because the numbers describe its cells: at a coarse level
 * each one is already a linear mean of the pings it merged.
 */
function describeStatistics(found: ViewStatistics): string {
  const mean = found.meanSv === undefined ? 'no data' : `${found.meanSv.toFixed(2)} dB`;
  const nasc = found.nasc === undefined ? '' : `, NASC ${found.nasc.toFixed(1)}`;
  return (
    `level ${found.level} channel ${found.channel}: ` +
    `${found.count.toLocaleString()} cells over ${found.pings.toLocaleString()} ` +
    `source pings, mean linear Sv ${mean}${nasc}`
  );
}

/** Levels, with auto first, since choosing one overrides the default. */
function fillLevels(select: HTMLSelectElement, info: ViewInfo) {
  if (select.options.length !== info.levels + 1) {
    select.replaceChildren(new Option('auto', 'auto'));
    for (let i = 0; i < info.levels; i += 1) {
      select.append(new Option(String(i), String(i)));
    }
  }
  select.value = String(info.levelChoice);
}

/** Name, message, stack and every cause, since the box stands in for devtools. */
function describeError(error: unknown): string {
  const lines = [new Date().toLocaleTimeString()];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    const prefix = depth === 0 ? '' : 'caused by ';
    if (current instanceof Error) {
      lines.push(`${prefix}${current.name}: ${current.message}`);
      const frames = current.stack?.split('\n').filter((line) => /^\s+at |@/.test(line));
      if (frames?.length) lines.push(...frames.map((line) => `    ${line.trim()}`));
      current = current.cause;
    } else {
      lines.push(`${prefix}${String(current)}`);
      current = undefined;
    }
  }
  return lines.join('\n');
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function node(tag: string, className?: string): HTMLElement {
  const element = window.document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function text(content: string, className?: string): HTMLElement {
  const element = node('span', className);
  element.textContent = content;
  return element;
}

function button(label: string): HTMLButtonElement {
  const element = node('button') as HTMLButtonElement;
  element.type = 'button';
  element.textContent = label;
  return element;
}

function labelled(caption: string, control: HTMLElement): HTMLLabelElement {
  const label = node('label') as HTMLLabelElement;
  label.append(caption, control);
  return label;
}

function options_(values: string[]): HTMLSelectElement {
  const select = node('select') as HTMLSelectElement;
  for (const value of values) select.append(new Option(value, value));
  return select;
}

function row(...children: HTMLElement[]): HTMLElement {
  const element = node('div', 'layer');
  element.append(...children);
  return element;
}
