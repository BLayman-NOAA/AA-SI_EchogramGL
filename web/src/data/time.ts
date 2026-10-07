/**
 * Ping times as written, read as nanoseconds since 1970.
 *
 * The builder writes `ping_time` as int64 nanoseconds with no units. A store
 * xarray wrote carries CF units instead, and the recipe caches hold several:
 * `nanoseconds since 1970-01-01T00:00:00+00:00` for Sv, and for MVBS
 * `seconds since 2016-07-25 20:35:20` or `seconds since 2016-07-25T20:35:20`,
 * a count from the first ping. Read as nanoseconds since 1970, the last of
 * those puts a survey in the first minutes of 1970.
 */

const NANOSECONDS: Record<string, number> = {
  nanoseconds: 1,
  nanosecond: 1,
  ns: 1,
  microseconds: 1e3,
  microsecond: 1e3,
  us: 1e3,
  milliseconds: 1e6,
  millisecond: 1e6,
  ms: 1e6,
  seconds: 1e9,
  second: 1e9,
  s: 1e9,
  minutes: 60e9,
  minute: 60e9,
  hours: 3600e9,
  hour: 3600e9,
  days: 86400e9,
  day: 86400e9,
};

/** A CF time unit as a scale and an origin, both in nanoseconds. */
export interface TimeUnits {
  scale: number;
  epoch: number;
}

/**
 * Read a CF units string, or undefined when it is not one.
 *
 * The origin is taken as UTC whether or not it says so, which is what xarray
 * writes and what every survey here records.
 */
export function parseTimeUnits(units: unknown): TimeUnits | undefined {
  if (typeof units !== 'string') return undefined;
  const found = /^\s*(\w+)\s+since\s+(.+?)\s*$/i.exec(units);
  if (!found) return undefined;
  const scale = NANOSECONDS[found[1].toLowerCase()];
  if (!scale) return undefined;
  const origin = found[2]
    .replace(' ', 'T')
    .replace(/(Z|[+-]00:?00)$/i, '')
    .trim();
  const milliseconds = Date.parse(/T/.test(origin) ? `${origin}Z` : `${origin}T00:00:00Z`);
  if (!Number.isFinite(milliseconds)) return undefined;
  return { scale, epoch: milliseconds * 1e6 };
}

/**
 * Times in nanoseconds since 1970, from values in the units given.
 *
 * Values with no units, or units that do not parse, are taken to be
 * nanoseconds already, which is what the builder writes.
 */
export function toNanoseconds(values: Float64Array, units: unknown): Float64Array {
  const parsed = parseTimeUnits(units);
  if (!parsed) return values;
  if (parsed.scale === 1 && parsed.epoch === 0) return values;
  return Float64Array.from(values, (value) => parsed.epoch + value * parsed.scale);
}
