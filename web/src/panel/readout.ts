/**
 * Words for what is under the pointer.
 *
 * Pure, so the wording is tested without a canvas. The panel draws these
 * lines in a box in the corner of the echogram.
 */

import type { Probe, ProbeLayer } from '../app/EchogramView';

export interface Readout {
  /** Where the pointer is: time or ping, then depth or range. */
  position: string[];
  /** One line per visible layer, top of the stack first. */
  values: string[];
  /** The size of the cell under the pointer, and the level it is drawn from. */
  cell?: string;
}

export function formatProbe(probe: Probe): Readout {
  const position = [horizontal(probe), vertical(probe)];
  const values = probe.layers.map((layer) => `${layer.label}  ${valueText(layer)}`);
  const drawn = probe.layers.find((layer) => layer.cell);
  return { position, values, cell: drawn?.cell ? cellText(drawn, probe) : undefined };
}

function horizontal(probe: Probe): string {
  switch (probe.xUnit) {
    case 'datetime':
      return probe.timeNs === undefined ? `${probe.x.toFixed(1)} s` : utc(probe.timeNs);
    case 'seconds':
      return `${probe.x.toFixed(1)} s`;
    case 'pings':
      return `ping ${Math.round(probe.x)}`;
    case 'bins':
      return `bin ${Math.round(probe.x)}`;
    case 'meters':
      return `${probe.x.toFixed(0)} m along track`;
  }
}

function vertical(probe: Probe): string {
  switch (probe.yUnit) {
    case 'meters':
      return `${probe.verticalRef === 'range' ? 'range' : 'depth'} ${probe.y.toFixed(1)} m`;
    case 'range_sample':
      return `sample ${Math.round(probe.y)}`;
    case 'bins':
      return `bin ${Math.round(probe.y)}`;
  }
}

/** Nanoseconds since 1970 as a UTC time to the second. */
export function utc(nanoseconds: number): string {
  const iso = new Date(nanoseconds / 1e6).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function valueText(layer: ProbeLayer): string {
  const { value } = layer;
  if (value === null) return 'no data';
  if (value === undefined) return layer.cell ? 'loading' : 'nothing drawn';
  if (layer.categorical) {
    const label = Math.round(value);
    return label < 0 ? 'noise' : `cluster ${label}`;
  }
  const sign = layer.difference && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)} dB`;
}

function cellText(layer: ProbeLayer, probe: Probe): string {
  const cell = layer.cell!;
  const width = cell.x[1] - cell.x[0];
  const height = cell.y[1] - cell.y[0];
  const across =
    probe.xUnit === 'datetime' || probe.xUnit === 'seconds'
      ? duration(width)
      : probe.xUnit === 'meters'
        ? `${width.toFixed(1)} m`
        : `${Math.round(width)} ${probe.xUnit === 'bins' ? 'bin' : 'ping'}`;
  const down = probe.yUnit === 'meters' ? `${height.toFixed(2)} m` : '1 sample';
  const pings = cell.factor === 1 ? '1 ping' : `${cell.factor} pings`;
  return `cell ${across} x ${down}  (level ${cell.level}, ${pings})`;
}

/**
 * Seconds as the unit that reads best: seconds up to ten minutes, since a
 * cell of 80 s says more than one of 1.3 min, then minutes, then hours.
 */
export function duration(seconds: number): string {
  if (seconds < 600) return `${Number(seconds.toPrecision(3))} s`;
  if (seconds < 3 * 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
