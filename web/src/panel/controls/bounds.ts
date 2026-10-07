/**
 * Bounds entry and readout.
 *
 * The same four boxes take a window and display the attained one, so a user who
 * types a range that was clamped or that fell in a survey gap can see what they
 * actually got rather than inferring it from the picture.
 */

import type { ViewInfo } from '../../app/EchogramView';
import type { WindowRequest } from '../../geometry/window';

export interface BoundsControls {
  /** Show the attained window, and say so when it is not what was asked. */
  update(info: ViewInfo): void;
  /**
   * Take the window the user typed, once.
   *
   * The boxes are also a readout, so returning them on every call would pin the
   * view to whatever was last displayed and override anything else trying to
   * move it, such as the exaggeration control.
   */
  take(): WindowRequest | undefined;
}

export interface BoundsElements {
  xMin: HTMLInputElement;
  xMax: HTMLInputElement;
  yMin: HTMLInputElement;
  yMax: HTMLInputElement;
  note: HTMLElement;
}

export function createBoundsControls(
  elements: BoundsElements,
  onSubmit: () => void,
): BoundsControls {
  // Which pair was edited, not just whether something was. Sending an axis the
  // user did not touch would move it, and under a lock moving one moves both.
  let editedX = false;
  let editedY = false;
  const watch = (boxes: HTMLInputElement[], mark: () => void) => {
    for (const box of boxes) {
      box.addEventListener('change', () => {
        mark();
        onSubmit();
      });
    }
  };
  watch([elements.xMin, elements.xMax], () => {
    editedX = true;
  });
  watch([elements.yMin, elements.yMax], () => {
    editedY = true;
  });

  return {
    update(info: ViewInfo) {
      // While the user is mid edit, overwriting the box they are typing in
      // would be worse than leaving it stale.
      const active = window.document.activeElement;
      const boxes: [HTMLInputElement, number][] = [
        [elements.xMin, info.x[0]],
        [elements.xMax, info.x[1]],
        [elements.yMin, info.y[0]],
        [elements.yMax, info.y[1]],
      ];
      for (const [box, value] of boxes) {
        if (box !== active) box.value = round(value);
      }
      elements.note.textContent = describe(info);
    },
    take() {
      const x = editedX ? pair(elements.xMin, elements.xMax) : undefined;
      const y = editedY ? pair(elements.yMin, elements.yMax) : undefined;
      editedX = false;
      editedY = false;
      if (!x && !y) return undefined;
      return { x, y };
    },
  };
}

function pair(
  min: HTMLInputElement,
  max: HTMLInputElement,
): { min: number; max: number } | undefined {
  if (!min.value.trim() || !max.value.trim()) return undefined;
  const low = Number(min.value);
  const high = Number(max.value);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return undefined;
  return { min: low, max: high };
}

function describe(info: ViewInfo): string {
  const resolved = info.window;
  if (!resolved) return '';
  if (resolved.empty) return 'no pings in that window: it falls in a gap';
  if (resolved.clamped) return 'clamped to the survey';
  return '';
}

function round(value: number): string {
  return Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(2);
}
