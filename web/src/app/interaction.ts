/**
 * Pointer pan and wheel zoom.
 *
 * A gesture moves the viewport and nothing else. It knows nothing about tiles,
 * levels or textures, because what is drawn follows from where the view is, so
 * everything downstream can react to one change rather than to a gesture.
 *
 * The aspect policy is a property of the viewport, so a drag under a lock moves
 * both axes without this having to remember that it should.
 */

import type { Viewport } from './viewport';

export interface InteractionOptions {
  element: HTMLElement;
  /** Undefined until a store is open, so a gesture before then does nothing. */
  viewport: () => Viewport | undefined;
  /** Called after every change, with the gesture still in progress. */
  onChange: () => void;
  /** Data units per pixel of pointer travel. One is the natural rate. */
  panRate?: number;
}

/** Zoom per pixel of wheel travel. A notch is about 100, so about 16 percent. */
const WHEEL_RATE = 0.0015;

/** A line and a page of wheel travel in pixels, for the non pixel delta modes. */
const LINE = 16;
const PAGE = 400;

export function attachInteraction(options: InteractionOptions): () => void {
  const { element } = options;
  let dragging: number | undefined;
  let last = { x: 0, y: 0 };

  const ratio = () => globalThis.devicePixelRatio || 1;

  const down = (event: PointerEvent) => {
    if (event.button !== 0 || !options.viewport()) return;
    dragging = event.pointerId;
    last = { x: event.clientX, y: event.clientY };
    element.setPointerCapture(event.pointerId);
    element.style.cursor = 'grabbing';
  };

  const move = (event: PointerEvent) => {
    if (dragging !== event.pointerId) return;
    const view = options.viewport();
    if (!view) return;
    // The viewport measures in device pixels, which is what the canvas is
    // sized in, and a pointer reports CSS pixels.
    const scale = ratio() * (options.panRate ?? 1);
    const dx = (event.clientX - last.x) * scale;
    const dy = (event.clientY - last.y) * scale;
    last = { x: event.clientX, y: event.clientY };
    // Dragging right pulls the data right, so the range moves left.
    view.panBy(-dx, -dy);
    options.onChange();
  };

  const up = (event: PointerEvent) => {
    if (dragging !== event.pointerId) return;
    dragging = undefined;
    element.releasePointerCapture(event.pointerId);
    element.style.cursor = 'grab';
  };

  const wheel = (event: WheelEvent) => {
    const view = options.viewport();
    if (!view) return;
    // The page would scroll instead, and a viewer that scrolls away under the
    // pointer is worse than one that does not zoom.
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    view.zoomAt(
      Math.exp(travel(event) * WHEEL_RATE),
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height,
    );
    options.onChange();
  };

  element.style.cursor = 'grab';
  element.style.touchAction = 'none';
  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', up);
  element.addEventListener('wheel', wheel, { passive: false });

  return () => {
    // Detaching mid drag is what a destroy during a gesture looks like, and a
    // capture left behind outlives the listeners that would have released it.
    if (dragging !== undefined) element.releasePointerCapture(dragging);
    dragging = undefined;
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', up);
    element.removeEventListener('pointercancel', up);
    element.removeEventListener('wheel', wheel);
    element.style.cursor = '';
    element.style.touchAction = '';
  };
}

/** Wheel travel in pixels, whatever unit the browser reported it in. */
export function travel(event: { deltaY: number; deltaMode: number }): number {
  if (event.deltaMode === 1) return event.deltaY * LINE;
  if (event.deltaMode === 2) return event.deltaY * PAGE;
  return event.deltaY;
}
