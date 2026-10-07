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
  outputs?: { name: string; format: string; kind: OutputKind | null; reason?: string }[];
  output?: string | null;
  kind?: OutputKind | null;
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
    name: resolution.step,
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

/** One line saying what was found. */
export function describeFound(resolution: Resolution): string {
  const count = resolution.instances?.length;
  const files = count === undefined ? 'a pyramid' : `${count} dataset(s)`;
  const size = resolution.bytes ? `, ${(resolution.bytes / 2 ** 20).toFixed(0)} MB` : '';
  const written = resolution.createdAt ? `, written ${resolution.createdAt}` : '';
  const skipped = resolution.skipped?.length
    ? `; ${resolution.skipped.length} skipped, first: ${resolution.skipped[0].error}`
    : '';
  return `${resolution.step}: ${files}${size}${written}${skipped}`;
}

/** Whether two resolutions name the same data. */
export function sameCheckpoint(a: Resolution, b: Resolution): boolean {
  const key = (r: Resolution) =>
    [r.stepHash, r.createdAt, r.mount, ...(r.instances ?? []).map((i) => i.id)].join('|');
  return key(a) === key(b);
}
