/**
 * Layer stack controls.
 *
 * One row per layer: visibility, channel, an optional second channel to
 * difference against, color mode, blend, opacity, and the buttons that move it
 * in the stack. Row order is draw order, so what the list looks like is what
 * the picture is made of.
 *
 * Two kinds of change, and only one of them redraws. Editing a value tells the
 * view and leaves the rows alone; adding, removing or moving a layer rebuilds
 * them. Redrawing on a value change replaces the element being dragged, which
 * ends the drag: the slider is destroyed under the pointer and the next
 * pointermove has nothing to move.
 *
 * The stack is held here rather than read back from the view on every change,
 * for the same reason the exaggeration slider reports whether it was touched: a
 * control that is also a readout will otherwise push its last displayed value
 * back at the view on a change that was about something else.
 */

import type { ChannelOption } from '../../app/channels';
import { type LayerSpec, defaultClim } from '../../app/layers';
import { colormapNames } from '../../render/colormaps';
import { perFrame } from './schedule';

/** Tints for a new layer, in the order the tricolor echogram wants them. */
export const TINTS: { name: string; rgb: [number, number, number] }[] = [
  { name: 'red', rgb: [1, 0, 0] },
  { name: 'green', rgb: [0, 1, 0] },
  { name: 'blue', rgb: [0, 0, 1] },
  { name: 'cyan', rgb: [0, 1, 1] },
  { name: 'magenta', rgb: [1, 0, 1] },
  { name: 'yellow', rgb: [1, 1, 0] },
];

/** Minus sign, the real one rather than a hyphen. */
const MINUS = '−';

export interface LayerControls {
  /** Replace the stack, as when a store opens with different channels. */
  set(layers: LayerSpec[]): void;
  /** The stack as edited, ready for setOptions. */
  read(): LayerSpec[];
  /** Offer these channels. Redraws only when the set of them changed. */
  update(channels: ChannelOption[]): void;
}

export function createLayerControls(
  list: HTMLElement,
  add: HTMLButtonElement,
  onChange: () => void,
): LayerControls {
  let layers: LayerSpec[] = [];
  let channels: ChannelOption[] = [{ index: 0, label: 'channel 0' }];
  const smooth = perFrame(onChange);

  /** A value changed. The rows already show it, so only the view needs telling. */
  const edited = () => smooth();

  /** The stack itself changed, so the rows no longer describe it. */
  const restructured = () => {
    render();
    onChange();
  };

  add.addEventListener('click', () => {
    // A second layer is a second frequency more often than a second view of the
    // same one, so it opens on the first channel the stack does not use.
    const used = new Set(layers.map((layer) => layer.channel));
    const free = channels.find((channel) => !used.has(channel.index));
    layers = [
      ...layers,
      {
        id: nextId(layers),
        channel: free?.index ?? channels[0].index,
        color: { colormap: 'viridis' },
      },
    ];
    restructured();
  });

  function render() {
    list.replaceChildren(
      ...layers.map((layer, index) =>
        row(layer, channels, edited, restructured, {
          remove: () => {
            layers = layers.filter((_, i) => i !== index);
            restructured();
          },
          move: (by: number) => {
            const to = index + by;
            if (to < 0 || to >= layers.length) return;
            const next = [...layers];
            const [moved] = next.splice(index, 1);
            next.splice(to, 0, moved);
            layers = next;
            restructured();
          },
        }),
      ),
    );
  }

  return {
    set(next: LayerSpec[]) {
      layers = next.map((layer) => ({ ...layer }));
      render();
    },
    read() {
      return layers.map((layer) => ({ ...layer }));
    },
    update(next: ChannelOption[]) {
      if (!next.length || signature(next) === signature(channels)) return;
      channels = next;
      render();
    },
  };
}

interface RowActions {
  remove(): void;
  move(by: number): void;
}

function signature(channels: ChannelOption[]): string {
  return channels.map((channel) => `${channel.index}:${channel.label}`).join(',');
}

function row(
  layer: LayerSpec,
  channels: ChannelOption[],
  edited: () => void,
  restructured: () => void,
  actions: RowActions,
): HTMLElement {
  const line = window.document.createElement('div');
  line.className = 'layer';

  const visible = checkbox(layer.visible ?? true, (on) => {
    layer.visible = on;
    edited();
  });
  visible.title = 'draw this layer';

  const channel = select(
    channels.map((option) => [option.label, String(option.index)] as [string, string]),
    String(layer.channel),
    (value) => {
      layer.channel = Number(value);
      edited();
    },
  );
  channel.title = 'channel, by frequency where the store names one';

  // One picker rather than a second channel and a transform beside it. The two
  // are never useful apart: a transform naming no second channel is a value
  // layer, and a second channel with no transform is nothing at all.
  const against = select(
    [
      ['—', 'none'],
      ...channels.map(
        (option) =>
          [`${MINUS} ${option.label}`, String(option.index)] as [string, string],
      ),
    ],
    layer.against === undefined ? 'none' : String(layer.against),
    (value) => {
      layer.against = value === 'none' ? undefined : Number(value);
      // A difference is signed and lives near zero, so limits that suit Sv suit
      // it very badly. Reset to whichever default the layer now wants, rather
      // than carried across, and the boxes below redraw showing them.
      layer.clim = defaultClim(layer.against);
      restructured();
    },
  );
  against.title = 'subtract a second channel, in decibels';

  const color = select(
    [
      ...colormapNames().map(
        (name) => [`cmap ${name}`, `colormap:${name}`] as [string, string],
      ),
      ...TINTS.map((tint) => [`tint ${tint.name}`, `tint:${tint.name}`] as [string, string]),
      ['palette cluster', 'palette:cluster'],
    ],
    colorValue(layer),
    (value) => {
      layer.color = parseColor(value);
      edited();
    },
  );
  color.title = 'color mode';

  const blend = select(
    [
      ['over', 'over'],
      ['add', 'add'],
    ],
    layer.blend ?? 'over',
    (value) => {
      layer.blend = value as 'over' | 'add';
      edited();
    },
  );
  blend.title = 'how it combines with what is under it';

  // Per layer, because FR-9 gives each its own and because a difference wants
  // limits an Sv layer never would: signed, symmetric, and a tenth the width.
  const clim = layer.clim ?? defaultClim(layer.against);
  const low = number(clim[0], (value) => {
    layer.clim = [value, (layer.clim ?? clim)[1]];
    edited();
  });
  low.title = 'lowest value the colormap covers';
  const high = number(clim[1], (value) => {
    layer.clim = [(layer.clim ?? clim)[0], value];
    edited();
  });
  high.title = 'highest value the colormap covers';

  const readout = window.document.createElement('span');
  readout.className = 'opacityValue';

  const opacity = window.document.createElement('input');
  opacity.type = 'range';
  opacity.min = '0';
  opacity.max = '100';
  opacity.value = String(Math.round((layer.opacity ?? 1) * 100));
  opacity.title = 'opacity';
  readout.textContent = `${opacity.value}%`;
  opacity.addEventListener('input', () => {
    layer.opacity = Number(opacity.value) / 100;
    readout.textContent = `${opacity.value}%`;
    edited();
  });

  line.append(
    visible,
    channel,
    against,
    color,
    low,
    high,
    blend,
    opacity,
    readout,
    button('up', () => actions.move(-1)),
    button('down', () => actions.move(1)),
    button('remove', actions.remove),
  );
  return line;
}

function colorValue(layer: LayerSpec): string {
  const color = layer.color;
  if (!color) return 'colormap:viridis';
  if ('tint' in color) {
    const match = TINTS.find((tint) => tint.rgb.join() === color.tint.join());
    return `tint:${match?.name ?? 'red'}`;
  }
  if ('palette' in color) return `palette:${color.palette}`;
  return `colormap:${color.colormap}`;
}

function parseColor(value: string): LayerSpec['color'] {
  const [kind, name] = value.split(':');
  if (kind === 'tint') {
    const tint = TINTS.find((entry) => entry.name === name) ?? TINTS[0];
    return { tint: tint.rgb };
  }
  if (kind === 'palette') return { palette: name };
  return { colormap: name };
}

function nextId(layers: LayerSpec[]): string {
  const used = new Set(layers.map((layer) => layer.id));
  for (let i = 0; ; i += 1) {
    const id = `layer-${i}`;
    if (!used.has(id)) return id;
  }
}

/**
 * A number box that follows a held spinner arrow.
 *
 * `input` rather than `change`: a held arrow repeats input and fires change
 * only when focus leaves, so the limits would jump once at the end instead of
 * stepping. An empty or half typed box is ignored rather than read as zero.
 */
function number(value: number, onChange: (value: number) => void): HTMLInputElement {
  const input = window.document.createElement('input');
  input.type = 'number';
  input.step = '1';
  input.value = String(value);
  input.className = 'clim';
  input.addEventListener('input', () => {
    const next = Number(input.value);
    if (input.value.trim() && Number.isFinite(next)) onChange(next);
  });
  return input;
}

function checkbox(on: boolean, onChange: (on: boolean) => void): HTMLInputElement {
  const input = window.document.createElement('input');
  input.type = 'checkbox';
  input.checked = on;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function select(
  options: [string, string][],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const element = window.document.createElement('select');
  for (const [label, key] of options) element.append(new Option(label, key));
  element.value = value;
  element.addEventListener('change', () => onChange(element.value));
  return element;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = window.document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}
