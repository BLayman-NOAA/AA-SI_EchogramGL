/**
 * Aspect policy control.
 *
 * The exaggeration slider is logarithmic. A useful setting runs from squashing
 * a long transit into the panel to stretching a thin layer open, and a linear
 * slider would spend nearly all its travel above ten.
 */

import type { ViewInfo } from '../../app/EchogramView';
import type { AspectMode } from '../../app/viewport';

/**
 * The ends of the travel. Roughly symmetric about one, so true scale sits near
 * the middle rather than off to one side, and deliberately narrower than the
 * range the viewport will accept: the slider is for finding a shape by eye, and
 * decades nobody uses only cost precision in the ones they do. A factor outside
 * this still displays, clamped to the nearest end.
 */
export const MIN_EXAGGERATION = 0.01;
export const MAX_EXAGGERATION = 250;

/** Slider positions, fine enough that a drag reads as continuous. */
const STEPS = 1000;

export interface AspectSelection {
  mode: AspectMode;
  /**
   * Present only when the slider was moved or a preset set it.
   *
   * Absent under a free policy, where there is no factor to hold, and absent on
   * a change that was not about the aspect at all. The slider is a readout as
   * well as an entry, and returning its position every time would push a value
   * rounded to the nearest step back at the view, reshaping the picture on a
   * colormap change and undoing a fit that had just been made.
   */
  exaggeration?: number;
}

export interface AspectControls {
  update(info: ViewInfo): void;
  /** Take the selection, and the factor only if the user changed it. */
  read(): AspectSelection;
  /** Set the slider from a value, for the true scale and fit buttons. */
  set(mode: AspectMode, exaggeration: number): void;
}

export interface AspectElements {
  mode: HTMLSelectElement;
  slider: HTMLInputElement;
  readout: HTMLElement;
  trueScale: HTMLButtonElement;
}

export function createAspectControls(
  elements: AspectElements,
  onChange: () => void,
): AspectControls {
  elements.slider.min = '0';
  elements.slider.max = String(STEPS);
  elements.slider.step = '1';

  // Whether the factor on the slider is the user's, or just the shape the view
  // reported back the last time it was asked.
  let touched = false;

  elements.mode.addEventListener('change', onChange);
  elements.slider.addEventListener('input', () => {
    touched = true;
    elements.readout.textContent = format(toExaggeration(elements.slider));
    // A drag fires input far faster than a frame. Redrawing per event would
    // queue work the next event has already made stale.
    perFrame(onChange);
  });

  return {
    update(info: ViewInfo) {
      elements.mode.value = info.aspect;
      if (window.document.activeElement !== elements.slider) {
        elements.slider.value = String(toPosition(info.exaggeration));
      }
      elements.readout.textContent = format(info.exaggeration);
      // Free means the two axes move independently, so there is no factor to
      // hold. The slider still reports the shape the view happens to have,
      // which is what a lock would start from.
      const locked = info.aspect === 'locked';
      elements.slider.disabled = !locked;
      elements.slider.title = locked
        ? 'how many times larger a depth unit draws than a horizontal one'
        : 'the shape this view happens to have; lock the aspect to set it';
      // FR-72: no physical ratio between the axes exists on a time or ping
      // axis, so true scale is not offered there.
      elements.trueScale.disabled = !info.trueScaleAvailable;
      elements.trueScale.title = info.trueScaleAvailable
        ? 'a metre of depth drawn like a metre of track'
        : 'true scale needs a distance axis';
    },
    read() {
      const mode = elements.mode.value as AspectMode;
      const chosen = touched && mode === 'locked';
      touched = false;
      return {
        mode,
        exaggeration: chosen ? toExaggeration(elements.slider) : undefined,
      };
    },
    set(mode: AspectMode, exaggeration: number) {
      elements.mode.value = mode;
      elements.slider.value = String(toPosition(exaggeration));
      elements.readout.textContent = format(exaggeration);
      touched = true;
    },
  };
}

export function toExaggeration(slider: HTMLInputElement): number {
  return exaggerationAt(Number(slider.value) / STEPS);
}

/** Position 0 to 1 along the slider to a factor. */
export function exaggerationAt(fraction: number): number {
  const low = Math.log10(MIN_EXAGGERATION);
  const high = Math.log10(MAX_EXAGGERATION);
  return 10 ** (low + fraction * (high - low));
}

/** A factor back to a slider position, clamped to the ends. */
export function toPosition(exaggeration: number): number {
  const low = Math.log10(MIN_EXAGGERATION);
  const high = Math.log10(MAX_EXAGGERATION);
  const fraction = (Math.log10(exaggeration) - low) / (high - low);
  return Math.round(Math.min(Math.max(fraction, 0), 1) * STEPS);
}

/** Run at most once per frame, dropping anything raised in between. */
function perFrame(run: () => void) {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    run();
  });
}

let pending = 0;

function format(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(2);
}
