/**
 * What the development server's catalog answers, and how to draw it.
 *
 * `aa-echogram serve` finds data for the providers: `/api/resolve` names a
 * recipe step's checkpoint, `/api/open` a store or dataset at a path. Both
 * answer with a `Resolution`, which `toSpec` turns into something the viewer
 * opens. The viewer itself knows none of this.
 */

import type { SourceInput } from '../../app/EchogramView';
import type { PieceSetSpec } from '../../data/pieces';

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

/** What `/api/resolve` and `/api/open` answer. */
export interface Resolution {
  mode: 'recipe' | 'cache' | 'path';
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
  /** Entries that could not be read, such as an empty file, and why. */
  skipped?: { item?: string | null; store: string; error: string }[];
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
 */
export function toSpec(server: string, resolution: Resolution): SourceInput {
  if (resolution.status !== 'found' || !resolution.kind) {
    throw new Error(`${resolution.step} has nothing to draw (${resolution.status})`);
  }
  if (resolution.kind === 'pyramid') {
    return new URL(`mount/${resolution.mount}/`, server).href;
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
      header: new URL(`api/describe/${instance.mount}`, server).href,
      store: new URL(`mount/${instance.mount}/`, server).href,
    })),
  };
  return spec;
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

const KINDS: Record<string, string> = { sv: 'Sv', mvbs: 'MVBS', labels: 'labels' };

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
  const files = count === undefined ? 'a pyramid' : `${count} dataset(s)`;
  const size = resolution.bytes ? `, ${(resolution.bytes / 2 ** 20).toFixed(0)} MB` : '';
  const written = resolution.createdAt ? `, written ${resolution.createdAt}` : '';
  const skipped = resolution.skipped?.length
    ? `; ${resolution.skipped.length} skipped, first: ${resolution.skipped[0].error}`
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
