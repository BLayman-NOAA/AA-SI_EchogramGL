/**
 * What the catalog server answers, and how to draw it.
 *
 * `aa-echogram serve`, and any host that mounts EchogramGL's router, finds
 * data: `/api/resolve` names a recipe step's checkpoint, `/api/open` a store
 * or dataset at a path, and a host such as the recipe manager's client
 * resolves the artifacts it already found. Each answers with a `Resolution`,
 * which `toSpec` turns into something the viewer opens.
 *
 * Published so a host draws a resolution the way the development page does.
 * The view itself knows none of this: nothing below this module imports it.
 */

import type { SourceInput } from '../app/EchogramView';
import type { PieceSetSpec } from '../data/pieces';

/** How an output can be drawn. */
export type OutputKind = 'pyramid' | 'dataset';

/** A variable of a dataset output the viewer can draw. */
export interface OutputVariable {
  name: string;
  /** What its values are, which decides how a new layer colors it. */
  kind: 'sv' | 'mvbs' | 'labels';
  dims: string[];
  /** Null for a variable with no channel axis, such as cluster labels. */
  channels: number | null;
  samples: number;
}

/** One output of a step, and whether and how it can be drawn. */
export interface Output {
  name: string;
  format: string;
  kind: OutputKind | null;
  reason?: string;
  /** For a dataset, what it holds that can be drawn. */
  variables?: OutputVariable[];
  /** The variable drawn when none is named. */
  default?: string | null;
}

/** One thing a resolution offers to draw: an output, and for a dataset a variable. */
export interface Choice {
  output: string;
  var?: string;
  label: string;
}

/** One dataset the server found, placed in time and mounted. */
export interface Instance {
  /** The instance's hash, unique within a step. */
  id: string;
  /** What the step was mapped over for this instance, such as a raw file. */
  item?: string | null;
  index?: number | null;
  /** Where the server reads it, for display. */
  store: string;
  /** The id it is served under, at `/mount/<mount>/`. */
  mount: string;
  tier?: string;
  var: string;
  dims: string[];
  shape: number[];
  /** First and last ping, nanoseconds since 1970. */
  start: number;
  end: number;
  pings: number;
  channels: number;
  samples: number;
  /** Stored bytes of the value array, compressed, every channel. */
  bytes?: number | null;
}

/**
 * What `/api/resolve` and `/api/open` answer, and what a host resolving its
 * own artifacts answers, in mode `artifacts`.
 */
export interface Resolution {
  mode: 'recipe' | 'cache' | 'path' | 'artifacts';
  /** The step, or for a path, what the path is called. */
  step: string;
  status: 'found' | 'not_run' | 'never_run';
  stepHash?: string;
  fannedOut?: boolean;
  outputs?: Output[];
  output?: string | null;
  kind?: OutputKind | null;
  /** The variable drawn, for a dataset output. */
  var?: string | null;
  createdAt?: string | null;
  /** A pyramid's location and mount. */
  store?: string;
  mount?: string;
  /** A dataset output, one per entry, in order. */
  instances?: Instance[];
  /** Checkpoint entries found: one, or one per instance of a fanned out step. */
  entries?: number;
  /** Entries that could not be read, such as an empty file, and why. */
  skipped?: { item?: string | null; store: string; error: string; empty?: boolean }[];
  /**
   * How many of the skipped were empty: an instance whose file had no data,
   * saved as JSON null in place of its dataset.
   */
  empty?: number;
  bytes?: number;
  /** When the step has not been run with these parameters. */
  nearest?: { tier: string; createdAt?: string; runId?: string; stepHash?: string };
  differences?: { path: string; stored: unknown; current: unknown }[];
}

/**
 * What the viewer opens for a resolution.
 *
 * A pyramid is the URL it is mounted at. A dataset output is a piece set,
 * each piece's header and values at the server's mount for it.
 *
 * `server` is where the catalog routes are: an absolute URL, or a path on the
 * page's own origin such as `/echogram/`, which the URLs then stay relative to.
 */
export function toSpec(server: string, resolution: Resolution): SourceInput {
  if (resolution.status !== 'found' || !resolution.kind) {
    throw new Error(`${resolution.step} has nothing to draw (${resolution.status})`);
  }
  if (resolution.kind === 'pyramid') {
    return under(server, `mount/${resolution.mount}/`);
  }
  const spec: PieceSetSpec = {
    name: sourceName(resolution),
    pieces: (resolution.instances ?? []).map((instance) => ({
      id: instance.id,
      label: instance.item ?? undefined,
      start: instance.start,
      end: instance.end,
      pings: instance.pings,
      channels: instance.channels,
      samples: instance.samples,
      bytes: instance.bytes,
      header: under(server, `api/describe/${instance.mount}`),
      store: under(server, `mount/${instance.mount}/`),
    })),
  };
  return spec;
}

/** A route under the catalog server, absolute only when the server is. */
function under(server: string, path: string): string {
  if (URL.canParse(server)) return new URL(path, server).href;
  return `${server.endsWith('/') ? server : `${server}/`}${path}`;
}

/**
 * What a resolution is called as a source.
 *
 * The step, and the variable after it when it is not the one drawn by
 * default, so cluster labels added beside the MVBS of the same step read as
 * `embed_results:ml_dataset_hdbscan_results_grid`.
 */
export function sourceName(resolution: Resolution): string {
  const output = resolution.outputs?.find((item) => item.name === resolution.output);
  const named = resolution.var && resolution.var !== output?.default;
  return named ? `${resolution.step}:${resolution.var}` : resolution.step;
}

/**
 * Everything a resolution offers to draw, in the server's order.
 *
 * A pyramid is one choice. A dataset is one choice per drawable variable.
 * Outputs the viewer cannot draw are left out; `describeMiss` says why.
 */
export function choices(resolution: Resolution): Choice[] {
  const found: Choice[] = [];
  for (const output of resolution.outputs ?? []) {
    if (output.kind === 'pyramid') {
      found.push({ output: output.name, label: `${output.name} (pyramid)` });
    } else if (output.kind === 'dataset') {
      for (const variable of output.variables ?? []) {
        found.push({
          output: output.name,
          var: variable.name,
          label: `${output.name}: ${variable.name} (${KINDS[variable.kind] ?? variable.kind})`,
        });
      }
    }
  }
  // A pyramid opened by path is drawable but lists no outputs.
  if (!found.length && resolution.kind === 'pyramid') {
    found.push({ output: resolution.output ?? '', label: `${resolution.step} (pyramid)` });
  }
  return found;
}

/** What each kind of variable is called in a choice's label. */
export const KINDS: Record<string, string> = { sv: 'Sv', mvbs: 'MVBS', labels: 'labels' };

/**
 * Which choice to select first: the one remembered if it is on offer, else
 * the one the server drew.
 */
export function preferred(
  offered: Choice[],
  resolution: Resolution,
  remembered?: { output?: string; var?: string },
): number {
  const at = (output?: string | null, variable?: string | null) =>
    offered.findIndex(
      (choice) => choice.output === (output ?? '') && (choice.var ?? null) === (variable ?? null),
    );
  // Remembered fields are strings, so no variable is stored as empty.
  const kept = remembered?.output ? at(remembered.output, remembered.var || null) : -1;
  if (kept >= 0) return kept;
  const drawn = at(resolution.output, resolution.var);
  return Math.max(drawn, 0);
}

/** One line saying what was found. */
export function describeFound(resolution: Resolution): string {
  const count = resolution.instances?.length;
  const empty = resolution.empty ? `, ${resolution.empty} empty` : '';
  const files = count === undefined ? 'a pyramid' : `${count} dataset(s)${empty}`;
  const size = resolution.bytes ? `, ${(resolution.bytes / 2 ** 20).toFixed(0)} MB` : '';
  const written = resolution.createdAt ? `, written ${resolution.createdAt}` : '';
  const failed = (resolution.skipped ?? []).filter((record) => !record.empty);
  const skipped = failed.length
    ? `; ${failed.length} skipped, first: ${failed[0].error}`
    : '';
  return `${sourceName(resolution)}: ${files}${size}${written}${skipped}`;
}

/** Whether a resolution already draws a choice, so asking again is not needed. */
export function draws(resolution: Resolution, choice: Choice): boolean {
  return (
    (resolution.output ?? '') === choice.output &&
    (resolution.var ?? undefined) === choice.var
  );
}

/** Whether two resolutions name the same data. */
export function sameCheckpoint(a: Resolution, b: Resolution): boolean {
  const key = (r: Resolution) =>
    [r.stepHash, r.createdAt, r.mount, r.var, ...(r.instances ?? []).map((i) => i.id)].join(
      '|',
    );
  return key(a) === key(b);
}

/** Say why a resolved step has nothing to draw. */
export function describeMiss(resolution: Resolution): string {
  const step = resolution.step;
  // A host's artifacts are found or not; there is no older run to compare.
  if (resolution.mode === 'artifacts' && resolution.status !== 'found') {
    return `${step} has no saved output to draw.`;
  }
  if (resolution.status === 'never_run') return `${step} has never been run into this cache.`;
  if (resolution.status === 'not_run') {
    const nearest = resolution.nearest?.createdAt
      ? ` The newest run, ${resolution.nearest.createdAt}, differs in `
      : ' The newest run differs in ';
    // A parent's hash says only that something upstream changed, not what.
    const fields = [
      ...new Set(
        (resolution.differences ?? []).map((d) =>
          d.path.startsWith('parents') ? 'an upstream step' : d.path,
        ),
      ),
    ];
    const named = fields.length ? fields.slice(0, 4).join(', ') : 'nothing it recorded';
    return `${step} has not been run with these parameters.${nearest}${named}.`;
  }
  const reasons = (resolution.outputs ?? [])
    .filter((output) => !output.kind)
    .map((output) => `${output.name}: ${output.reason}`);
  return `${step} wrote nothing the viewer can draw. ${reasons.join('; ')}`;
}
