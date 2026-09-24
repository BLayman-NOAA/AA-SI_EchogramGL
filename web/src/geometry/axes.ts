/**
 * Axis units, labels and validity.
 *
 * Label strings come from `calculate_x_axis_extent` and
 * `calculate_y_axis_extent` in AA-SI_Visualization, so a viewer axis and a
 * report figure axis read identically. Validity rules and refusal messages
 * follow them too, since a user who has seen one error should recognise the
 * other.
 */

export type XUnit = 'datetime' | 'seconds' | 'pings' | 'bins' | 'meters';
export type YUnit = 'meters' | 'range_sample' | 'bins';

export const X_UNITS: XUnit[] = ['datetime', 'seconds', 'pings', 'bins', 'meters'];
export const Y_UNITS: YUnit[] = ['meters', 'range_sample', 'bins'];

const MVBS_TYPES = new Set(['MVBS', 'ML-MVBS', 'Cluster-MVBS']);

/** What the store says about itself, enough to decide unit validity. */
export interface AxisContext {
  dataType: string;
  /** 'range' or 'depth', from the resolved range variable. */
  verticalRef: string;
  hasGps: boolean;
  /** Original ping indices the first and last bin cover, for the MVBS label. */
  pingSpan?: [number, number];
}

export class AxisUnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AxisUnitError';
  }
}

export function isMvbs(dataType: string): boolean {
  return MVBS_TYPES.has(dataType);
}

export function validXUnits(context: AxisContext): XUnit[] {
  return X_UNITS.filter((unit) => {
    if (unit === 'bins') return isMvbs(context.dataType);
    if (unit === 'meters') return context.hasGps;
    return true;
  });
}

export function validYUnits(context: AxisContext): YUnit[] {
  return Y_UNITS.filter((unit) => unit !== 'bins' || isMvbs(context.dataType));
}

/** Throw if the unit is not usable for this store, naming what is. */
export function assertXUnit(unit: string, context: AxisContext) {
  if (unit === 'bins' && !isMvbs(context.dataType)) {
    throw new AxisUnitError("x_axis_units='bins' is only valid for MVBS data");
  }
  const valid = validXUnits(context);
  if (!valid.includes(unit as XUnit)) {
    throw new AxisUnitError(
      `Invalid x_axis_units '${unit}'. Valid options: ${format(valid)}`,
    );
  }
}

export function assertYUnit(unit: string, context: AxisContext) {
  if (unit === 'bins' && !isMvbs(context.dataType)) {
    throw new AxisUnitError("y_axis_units='bins' is only valid for MVBS data");
  }
  const valid = validYUnits(context);
  if (!valid.includes(unit as YUnit)) {
    throw new AxisUnitError(`Invalid y_axis_units '${unit}'. Use ${format(valid)}`);
  }
}

export function xAxisLabel(unit: XUnit, context: AxisContext): string {
  switch (unit) {
    case 'datetime':
      return 'Time (UTC)';
    case 'seconds':
      return 'Time (seconds from start)';
    case 'pings':
      if (isMvbs(context.dataType) && context.pingSpan) {
        const [first, last] = context.pingSpan;
        return `MVBS Bin (pings ${first} to ${last})`;
      }
      return 'Ping Number';
    case 'bins':
      return 'MVBS Time Bins';
    case 'meters':
      return 'Distance (meters)';
  }
}

/**
 * Label the vertical axis.
 *
 * The figures always say `Depth (m)` because they are only ever produced from
 * depth gridded data. A store records which reference it resolved, and saying
 * depth over a range axis would be wrong, so that one case diverges.
 */
export function yAxisLabel(unit: YUnit, context: AxisContext): string {
  switch (unit) {
    case 'meters':
      return context.verticalRef === 'range' ? 'Range (m)' : 'Depth (m)';
    case 'range_sample':
      return 'Range Sample Index';
    case 'bins':
      return 'MVBS Depth Bins';
  }
}

/** Render a list the way a Python list repr does, so the messages match. */
function format(units: string[]): string {
  return `[${units.map((u) => `'${u}'`).join(', ')}]`;
}
