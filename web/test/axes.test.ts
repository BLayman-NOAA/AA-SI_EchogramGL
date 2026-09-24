import { describe, expect, it } from 'vitest';

import {
  type AxisContext,
  assertXUnit,
  assertYUnit,
  isMvbs,
  validXUnits,
  validYUnits,
  xAxisLabel,
  yAxisLabel,
} from '../src/geometry/axes';

const mvbs: AxisContext = {
  dataType: 'MVBS',
  verticalRef: 'depth',
  hasGps: true,
  pingSpan: [0, 1208],
};

const raw: AxisContext = { dataType: 'Sv', verticalRef: 'range', hasGps: false };

describe('validity', () => {
  it('offers bins only for MVBS', () => {
    expect(validXUnits(mvbs)).toContain('bins');
    expect(validXUnits(raw)).not.toContain('bins');
    expect(validYUnits(mvbs)).toContain('bins');
    expect(validYUnits(raw)).not.toContain('bins');
  });

  it('offers a distance axis only where there are positions', () => {
    expect(validXUnits(mvbs)).toContain('meters');
    expect(validXUnits(raw)).not.toContain('meters');
  });

  it('treats the ML and cluster variants as MVBS', () => {
    expect(isMvbs('ML-MVBS')).toBe(true);
    expect(isMvbs('Cluster-MVBS')).toBe(true);
    expect(isMvbs('Sv')).toBe(false);
  });

  it('refuses bins on non MVBS data the way the figures do', () => {
    expect(() => assertXUnit('bins', raw)).toThrow(
      "x_axis_units='bins' is only valid for MVBS data",
    );
    expect(() => assertYUnit('bins', raw)).toThrow(
      "y_axis_units='bins' is only valid for MVBS data",
    );
  });

  it('names the valid options when the unit is not one of them', () => {
    expect(() => assertXUnit('furlongs', raw)).toThrow(
      /Invalid x_axis_units 'furlongs'\. Valid options: \['datetime', 'seconds', 'pings'\]/,
    );
    expect(() => assertYUnit('fathoms', raw)).toThrow(
      /Invalid y_axis_units 'fathoms'\. Use \['meters', 'range_sample'\]/,
    );
  });

  it('accepts every unit it says is valid', () => {
    for (const unit of validXUnits(mvbs)) assertXUnit(unit, mvbs);
    for (const unit of validYUnits(mvbs)) assertYUnit(unit, mvbs);
  });
});

describe('labels', () => {
  it('matches the strings the figures use', () => {
    expect(xAxisLabel('datetime', mvbs)).toBe('Time (UTC)');
    expect(xAxisLabel('seconds', mvbs)).toBe('Time (seconds from start)');
    expect(xAxisLabel('bins', mvbs)).toBe('MVBS Time Bins');
    expect(xAxisLabel('meters', mvbs)).toBe('Distance (meters)');
    expect(yAxisLabel('range_sample', mvbs)).toBe('Range Sample Index');
    expect(yAxisLabel('bins', mvbs)).toBe('MVBS Depth Bins');
  });

  it('names the original ping span on an MVBS ping axis', () => {
    expect(xAxisLabel('pings', mvbs)).toBe('MVBS Bin (pings 0 to 1208)');
    expect(xAxisLabel('pings', raw)).toBe('Ping Number');
  });

  it('follows the resolved range variable on the vertical', () => {
    // The figures always say depth because they are only made from depth
    // gridded data. Saying depth over a range axis would be wrong.
    expect(yAxisLabel('meters', mvbs)).toBe('Depth (m)');
    expect(yAxisLabel('meters', raw)).toBe('Range (m)');
  });
});
