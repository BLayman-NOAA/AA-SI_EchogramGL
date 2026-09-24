/**
 * Development page.
 *
 * A store picker, the knobs the view exposes, and an overlay that shows WGSL
 * diagnostics rather than leaving a blank canvas. Everything here is shell: no
 * other layer imports it.
 */

import {
  EchogramView,
  type ViewInfo,
  type ViewStatistics,
} from '../app/EchogramView';
import { channelOptions } from '../app/channels';
import { FetchStore } from '../data/FetchStore';
import { createGpuContext, describeContext } from '../device/context';
import { PIXELS_PER_PING } from '../geometry/levels';
import { colormapNames } from '../render/colormaps';
import { createAspectControls } from './controls/aspect';
import { createAxisControls } from './controls/axes';
import { createBoundsControls } from './controls/bounds';
import { createLayerControls } from './controls/layers';
import { Link, newViewId } from './channel';
import { popOut, serveHandoff } from './popout';
import { spawnDecodeWorker } from './worker';

const controls = element<HTMLFormElement>('controls');
const plot = element<HTMLDivElement>('plot');
const status = element<HTMLDivElement>('status');
const errorBox = element<HTMLPreElement>('error');
const url = element<HTMLInputElement>('url');
const levelSelect = element<HTMLSelectElement>('level');
const colormapSelect = element<HTMLSelectElement>('colormap');
const filterSelect = element<HTMLSelectElement>('filter');
const densitySelect = element<HTMLSelectElement>('density');
const statsBox = element<HTMLDivElement>('stats');

// One is a ping to a pixel, which is what the pyramid is built to serve. The
// wider settings coarsen sooner, which is also how a short survey is made to
// reach the levels a long one would reach on its own. Nothing below one: a
// drawn ping narrower than a pixel is detail the screen cannot show.
for (const value of ['1', '2', '4', '8']) {
  densitySelect.append(new Option(value, value));
}
densitySelect.value = String(PIXELS_PER_PING);

for (const name of colormapNames()) {
  colormapSelect.append(new Option(name, name));
}

const axisControls = createAxisControls(
  element<HTMLSelectElement>('xUnit'),
  element<HTMLSelectElement>('yUnit'),
  () => void apply(),
);
const aspectControls = createAspectControls(
  {
    mode: element<HTMLSelectElement>('aspectMode'),
    slider: element<HTMLInputElement>('exaggeration'),
    readout: element<HTMLSpanElement>('exaggerationValue'),
    trueScale: element<HTMLButtonElement>('trueScale'),
  },
  () => void apply(),
);
const layerControls = createLayerControls(
  element<HTMLDivElement>('layerList'),
  element<HTMLButtonElement>('addLayer'),
  () => void apply(),
);
const boundsControls = createBoundsControls(
  {
    xMin: element<HTMLInputElement>('xMin'),
    xMax: element<HTMLInputElement>('xMax'),
    yMin: element<HTMLInputElement>('yMin'),
    yMax: element<HTMLInputElement>('yMax'),
    note: element<HTMLSpanElement>('boundsNote'),
  },
  () => void apply(),
);

const context = await createGpuContext().catch((error) => {
  show(error);
  return undefined;
});

let view: EchogramView | undefined;

/** One group per page load, so two tabs do not link to each other by accident. */
const group = newViewId();
let link: Link | undefined;

if (context) {
  // A gesture moves the view without going through apply, so the readouts
  // follow the picture rather than only the controls.
  view = new EchogramView({
    container: plot,
    context,
    onError: show,
    spawnWorker: spawnDecodeWorker,
    onViewChange: () => {
      describe();
      const info = view?.info;
      if (info) link?.send({ kind: 'viewport', x: info.x, y: info.y });
    },
  });
  link = new Link({
    id: newViewId(),
    group,
    onMessage: (message) => {
      // A split window asking for the configuration, and a viewport it moved.
      // Nothing else is accepted here: this window owns the controls.
      serveHandoff(link!, () => view?.settingsObject)(message);
      if (message.kind === 'viewport') {
        view?.setViewport(message.x, message.y);
        describe();
      }
    },
  });
  globalThis.addEventListener('pagehide', () => link?.close());
  restore();
  controls.addEventListener('submit', (event) => {
    event.preventDefault();
    void load();
  });
  // Only the store url reopens anything. Everything else is a setting on the
  // store already open, and reopening would refetch and throw away the view.
  // Limits live on the layer rows, since FR-9 gives each layer its own and a
  // difference wants limits an Sv layer never would.
  const settings = [levelSelect, colormapSelect, filterSelect, densitySelect];
  for (const input of settings) input.addEventListener('change', () => void apply());
  element<HTMLButtonElement>('trueScale').addEventListener('click', () => {
    aspectControls.set('locked', 1);
    // A preset is closer to a policy change than to a drag, so it holds the
    // horizontal whether or not the policy was already locked.
    void apply('x');
  });
  element<HTMLButtonElement>('fitAll').addEventListener('click', () => {
    // Both extents cannot fit at an arbitrary factor, and the factor is the
    // thing on screen the user can see and change, so it is what gives.
    void apply(undefined, { fit: true });
  });
  element<HTMLButtonElement>('autoContrast').addEventListener('click', () => {
    void withErrors(async () => {
      // The limits come back through info, so the boxes follow the picture
      // rather than the picture following boxes nobody edited.
      await view?.autoContrast();
      // The limits it chose are on the layers now, so the rows are refreshed
      // from what the view settled on rather than left showing the old ones.
      if (view?.info) layerControls.set(view.info.layers);
      describe();
    });
  });
  element<HTMLButtonElement>('measure').addEventListener('click', () => {
    void withErrors(async () => {
      const found = await view?.statistics();
      statsBox.textContent = found ? describeStatistics(found) : 'nothing resident';
    });
  });
  element<HTMLButtonElement>('adapter').addEventListener('click', () => {
    show(new Error(JSON.stringify(describeContext(context), null, 2)));
  });
  // Straight from the click, with nothing awaited in front of it. A window
  // opened from a promise continuation is blocked, and blocked silently.
  element<HTMLButtonElement>('split').addEventListener('click', () => {
    if (!popOut({ group, settings: () => view?.settingsObject })) {
      show(new Error('the browser refused a second window. Allow popups for this page.'));
    }
  });
  void load();
}

/** Open the store named in the box, from scratch. */
async function load() {
  if (!view) return;
  clear();
  const href = url.value.trim();
  try {
    // No level, channel or unit: a new store starts at its own beginning, and
    // the view reports back what it settled on.
    await view.setStore(new FetchStore(href), {
      colormap: colormapSelect.value,
      filter: filterSelect.value as GPUFilterMode,
    });
    // A new store starts as one layer on its first channel, whatever the last
    // one was built from.
    layerControls.set(view.info?.layers.map((layer) => ({ ...layer })) ?? []);
    describe();
    remember(href);
  } catch (error) {
    show(error);
  }
}

/**
 * Push every control at the open store.
 *
 * One path rather than one per control, so a change never carries a stale value
 * from a box it did not read.
 */
async function apply(hold?: 'x' | 'y', extra: { fit?: boolean } = {}) {
  if (!view?.info) return;
  clear();
  try {
    const { xUnit, yUnit } = axisControls.read();
    await view.setOptions({
      level: levelSelect.value === 'auto' ? 'auto' : Number(levelSelect.value),
      pixelsPerPing: Number(densitySelect.value),
      colormap: colormapSelect.value,
      filter: filterSelect.value as GPUFilterMode,
      layers: layerControls.read(),
      xUnit,
      yUnit,
      aspect: { ...aspectControls.read(), hold },
      window: boundsControls.take(),
      ...extra,
    });
    describe();
  } catch (error) {
    show(error);
  }
}

/** Fill the pickers and the readout from what the view reports. */
function describe() {
  const info = view?.info;
  if (!info) return;
  fillLevels(info);
  densitySelect.value = String(info.pixelsPerPing);
  // A store with one level has nothing for either of these to choose between.
  // Both still change the number they hold, so leaving them live makes a
  // control that answers and does nothing, which is worse than one that says
  // it cannot: an Sv dataset drawn straight is exactly that case.
  const single = info.levels <= 1;
  const why = single
    ? 'this store has one level, so there is nothing to choose between'
    : '';
  for (const control of [levelSelect, densitySelect]) {
    control.disabled = single;
    control.title = why;
  }
  // Channels are chosen per layer, so the stack rows are the only place they
  // appear. A second picker beside them would have to mean the bottom layer,
  // which is a control whose effect depends on where you are looking.
  layerControls.update(channelOptions(info));
  axisControls.update(info);
  aspectControls.update(info);
  boundsControls.update(info);
  const { tiles } = info;
  const pending =
    (tiles.loading ? `, ${tiles.loading} loading` : '') +
    (tiles.uploading ? `, ${tiles.uploading} to upload` : '') +
    (tiles.standingIn ? `, ${tiles.standingIn} coarser` : '') +
    (tiles.blank ? `, ${tiles.blank} blank` : '') +
    (tiles.skipped ? `, ${tiles.skipped} empty` : '') +
    (tiles.failed ? `, ${tiles.failed} failed` : '');
  // A layer left out because its channels cannot be differenced says why,
  // rather than drawing nothing and leaving the reason on the floor.
  if (info.problems.length) {
    const detail = info.problems.map((p) => `${p.layer}: ${p.message}`);
    show(new Error(detail.join('; ')));
  }
  const chosen = info.levelChoice === 'auto' ? ' (auto)' : '';
  status.textContent =
    `${info.valueName} level ${info.level}${chosen} x${info.factor} ` +
    `${info.layers.length} layer(s), ` +
    `${info.pings} pings by ${info.samples} samples  |  ` +
    `${tiles.slots} slots${pending}, ${tiles.resident} resident, ` +
    `${(tiles.cachedBytes / (1024 * 1024)).toFixed(0)} MB cached, ` +
    `${tiles.redrawMs.toFixed(2)} ms to encode  |  ` +
    `${info.xLabel}  |  ${info.yLabel}`;
}

/** Run something that talks to the view, showing anything it throws. */
async function withErrors(run: () => Promise<void>) {
  clear();
  try {
    await run();
  } catch (error) {
    show(error);
  }
}

/**
 * What a reduction measured.
 *
 * The level is named because the numbers describe its cells: at a coarse level
 * each one is already a linear mean of the pings it merged, so the same
 * rectangle measured at two levels gives two different counts and much the
 * same mean.
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

/** Levels, with auto first, since choosing one is an override of the default. */
function fillLevels(info: ViewInfo) {
  if (levelSelect.options.length !== info.levels + 1) {
    levelSelect.replaceChildren();
    levelSelect.append(new Option('auto', 'auto'));
    for (let i = 0; i < info.levels; i += 1) {
      levelSelect.append(new Option(String(i), String(i)));
    }
  }
  levelSelect.value = String(info.levelChoice);
}

function show(error: unknown) {
  errorBox.style.display = 'block';
  errorBox.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}

function clear() {
  errorBox.style.display = 'none';
  errorBox.textContent = '';
}

function remember(href: string) {
  globalThis.localStorage?.setItem('echogram.store', href);
}

function restore() {
  const saved = globalThis.localStorage?.getItem('echogram.store');
  if (saved) url.value = saved;
}

function element<T extends HTMLElement>(id: string): T {
  const found = window.document.getElementById(id);
  if (!found) throw new Error(`no element with id ${id}`);
  return found as T;
}
