/**
 * Opening at a window.
 *
 * A host passing timestamps and a user typing ping indices are both asking for
 * a window, and both need to be told what they actually got. The request and
 * the attained extent are returned separately, because a window clamped to the
 * survey or snapped to whole pings is no longer what was asked for, and
 * silently returning the difference is how a caller comes to believe it is
 * looking at a range it is not.
 */

import { type XAxisValues, pingsInRange } from './coords';

export type Range = [number, number];

/** A bound carries its unit, so a timestamp and a ping index cannot be confused. */
export interface WindowRequest {
  x?: { min: number | string; max: number | string };
  y?: { min: number; max: number };
}

export interface WindowContext {
  axis: XAxisValues;
  /** Nanoseconds since the unix epoch of the first ping. */
  epochNs: number;
  /** Shallowest and deepest the data reaches. */
  vertical: Range;
}

export interface ResolvedWindow {
  requested: { x?: Range; y?: Range };
  attained: { x: Range; y: Range };
  /** First and last ping covered, absent when the window is empty. */
  pings?: [number, number];
  /** The request reached outside the survey and was pulled back. */
  clamped: boolean;
  /** The request landed between pings, in a gap, and covers no data. */
  empty: boolean;
}

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowError';
  }
}

export function resolveWindow(
  request: WindowRequest,
  context: WindowContext,
): ResolvedWindow {
  const { axis } = context;
  const full: Range = axis.centre.length
    ? [axis.left[0], axis.right[axis.right.length - 1]]
    : [0, 0];

  const requestedX = request.x
    ? order([
        toAxis(request.x.min, context),
        toAxis(request.x.max, context),
      ])
    : undefined;
  const requestedY = request.y ? order([request.y.min, request.y.max]) : undefined;

  const clampedX = clamp(requestedX ?? full, full);
  const clampedY = clamp(requestedY ?? context.vertical, context.vertical);
  const clamped =
    moved(requestedX, clampedX) || moved(requestedY, clampedY);

  const pings = pingsInRange(axis, clampedX[0], clampedX[1]);
  if (!pings) {
    return {
      requested: { x: requestedX, y: requestedY },
      attained: { x: clampedX, y: clampedY },
      clamped,
      empty: true,
    };
  }

  // Snap to whole cells: what is drawn is whole pings, so that is what was
  // attained, whatever fraction of a cell the request cut through.
  const attainedX: Range = [axis.left[pings[0]], axis.right[pings[1]]];
  return {
    requested: { x: requestedX, y: requestedY },
    attained: { x: attainedX, y: clampedY },
    pings,
    clamped,
    empty: false,
  };
}

/**
 * Convert one bound onto the axis.
 *
 * A string is read as a UTC timestamp, which only means anything on a time
 * axis; a number is already in axis units.
 */
function toAxis(value: number | string, context: WindowContext): number {
  if (typeof value === 'number') return value;
  const unit = context.axis.unit;
  if (unit !== 'datetime' && unit !== 'seconds') {
    throw new WindowError(`a timestamp bound needs a time axis, not '${unit}'`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new WindowError(`could not read '${value}' as a UTC timestamp`);
  }
  return (ms * 1e6 - context.epochNs) / 1e9;
}

function order(range: Range): Range {
  return range[0] <= range[1] ? range : [range[1], range[0]];
}

function clamp(range: Range, bounds: Range): Range {
  return [
    Math.min(Math.max(range[0], bounds[0]), bounds[1]),
    Math.max(Math.min(range[1], bounds[1]), bounds[0]),
  ];
}

function moved(requested: Range | undefined, result: Range): boolean {
  if (!requested) return false;
  return requested[0] !== result[0] || requested[1] !== result[1];
}
