import { describe, expect, it } from 'vitest';

import {
  type Resolution,
  choices,
  describeFound,
  describeMiss,
  draws,
  preferred,
  sameCheckpoint,
  sourceName,
  toSpec,
} from '../src/catalog/resolution';
import { isPieceSet } from '../src/data/pieces';

describe('saying why nothing was found', () => {
  const base = { mode: 'recipe', step: 'viewer_file_mvbs' } as const;

  it('names the fields a newer run differs in', () => {
    const text = describeMiss({
      ...base,
      status: 'not_run',
      nearest: { tier: 'user', createdAt: '2026-09-24T10:00:00' },
      differences: [
        { path: 'fingerprint.params.bin_s', stored: 10, current: 20 },
      ],
    });
    expect(text).toContain('not been run with these parameters');
    expect(text).toContain('fingerprint.params.bin_s');
    expect(text).toContain('2026-09-24T10:00:00');
  });

  it('says an upstream change rather than naming a parent hash', () => {
    const text = describeMiss({
      ...base,
      status: 'not_run',
      differences: [
        { path: 'parents[0]', stored: 'fd33', current: '51ec' },
        { path: 'parents[1]', stored: 'aa', current: 'bb' },
      ],
    });
    expect(text).toContain('an upstream step');
    expect(text).not.toContain('parents[0]');
  });

  it('says a step was never run', () => {
    expect(describeMiss({ ...base, status: 'never_run' })).toContain('never been run');
  });

  it('gives the reason an output cannot be drawn', () => {
    const text = describeMiss({
      ...base,
      status: 'found',
      kind: null,
      outputs: [{ name: 'fit', format: 'pickle', kind: null, reason: 'a pickled output' }],
    });
    expect(text).toContain('fit: a pickled output');
  });
});

describe('telling a new run from the same one', () => {
  const instance = (id: string) => ({
    id,
    store: '',
    mount: id,
    var: 'Sv',
    dims: [],
    shape: [],
    start: 0,
    end: 1,
    pings: 1,
    channels: 1,
    samples: 1,
  });
  const resolution: Resolution = {
    mode: 'recipe',
    step: 's',
    status: 'found',
    stepHash: 'abc',
    createdAt: '2026-01-01',
    instances: [instance('a'), instance('b')],
  };

  it('treats the same entries as the same checkpoint', () => {
    expect(sameCheckpoint(resolution, { ...resolution })).toBe(true);
  });

  it('sees a rerun instance, or a new hash, as a change', () => {
    const rerun = { ...resolution, instances: [instance('a'), instance('c')] };
    expect(sameCheckpoint(resolution, rerun)).toBe(false);
    expect(sameCheckpoint(resolution, { ...resolution, stepHash: 'def' })).toBe(false);
  });

  it('sees another variable of the same run as other data', () => {
    expect(sameCheckpoint({ ...resolution, var: 'Sv' }, { ...resolution, var: 'grid' })).toBe(
      false,
    );
  });
});

describe('choosing what of a step to draw', () => {
  const GRID = 'ml_dataset_hdbscan_results_grid';
  const variable = (name: string, kind: 'sv' | 'mvbs' | 'labels', channels: number | null) => ({
    name,
    kind,
    dims: channels === null ? ['ping_time', 'echo_range'] : ['channel', 'ping_time', 'echo_range'],
    channels,
    samples: 149,
  });
  // What the embedding step of the HB1603 example answers.
  const embed: Resolution = {
    mode: 'recipe',
    step: 'embed_results',
    status: 'found',
    kind: 'dataset',
    output: 'ds_normalized',
    var: 'Sv',
    outputs: [
      {
        name: 'ds_normalized',
        format: 'zarr',
        kind: 'dataset',
        variables: [variable('Sv', 'mvbs', 2), variable(GRID, 'labels', null)],
        default: 'Sv',
      },
      {
        name: 'gridded_results',
        format: 'zarr_da',
        kind: 'dataset',
        variables: [variable('_da', 'labels', null)],
        default: '_da',
      },
      { name: 'fit', format: 'pickle', kind: null, reason: 'a pickled output' },
    ],
  };

  it('offers every drawable variable of every output, and nothing undrawable', () => {
    expect(choices(embed)).toEqual([
      { output: 'ds_normalized', var: 'Sv', label: 'ds_normalized: Sv (MVBS)' },
      { output: 'ds_normalized', var: GRID, label: `ds_normalized: ${GRID} (labels)` },
      { output: 'gridded_results', var: '_da', label: 'gridded_results: _da (labels)' },
    ]);
  });

  it('offers a pyramid as one choice, with or without outputs listed', () => {
    const listed: Resolution = {
      mode: 'recipe',
      step: 'survey_echogram_store',
      status: 'found',
      kind: 'pyramid',
      output: 'pyramid',
      outputs: [{ name: 'pyramid', format: 'zarr', kind: 'pyramid' }],
    };
    expect(choices(listed)).toEqual([{ output: 'pyramid', label: 'pyramid (pyramid)' }]);
    const byPath: Resolution = { mode: 'path', step: 'p.zarr', status: 'found', kind: 'pyramid' };
    expect(choices(byPath)).toEqual([{ output: '', label: 'p.zarr (pyramid)' }]);
    expect(draws(byPath, choices(byPath)[0])).toBe(true);
  });

  it('selects the remembered choice when it is offered, else what was drawn', () => {
    const offered = choices(embed);
    expect(preferred(offered, embed)).toBe(0);
    expect(preferred(offered, embed, { output: 'ds_normalized', var: GRID })).toBe(1);
    expect(preferred(offered, embed, { output: 'elsewhere', var: 'x' })).toBe(0);
  });

  it('knows when the first answer already draws the choice', () => {
    const [sv, grid] = choices(embed);
    expect(draws(embed, sv)).toBe(true);
    expect(draws(embed, grid)).toBe(false);
  });

  it('names a source by its step, and by its variable when not the default', () => {
    expect(sourceName(embed)).toBe('embed_results');
    const labels = { ...embed, var: GRID, instances: [] };
    expect(sourceName(labels)).toBe(`embed_results:${GRID}`);
    const spec = toSpec('http://127.0.0.1:8000/', labels);
    expect(isPieceSet(spec) && spec.name).toBe(`embed_results:${GRID}`);
  });
});

describe('what the viewer opens for a resolution', () => {
  const server = 'http://127.0.0.1:8000/';
  const instance = {
    id: 'abc123',
    item: 'gs://bucket/D20160725-T205800.raw',
    store: 'gs://cache/file_mvbs/abc/run/zarr/ds_MVBS.zarr',
    mount: 'm1',
    var: 'Sv',
    dims: ['channel', 'ping_time', 'depth'],
    shape: [2, 12, 20],
    start: 1,
    end: 2,
    pings: 12,
    channels: 2,
    samples: 20,
    bytes: 100,
  };

  it('opens a pyramid at its mount', () => {
    const spec = toSpec(server, {
      mode: 'cache',
      step: 'survey_echogram_store',
      status: 'found',
      kind: 'pyramid',
      mount: 'p1',
    });
    expect(spec).toBe('http://127.0.0.1:8000/mount/p1/');
  });

  it('opens a dataset output as pieces, each at its header and mount', () => {
    const spec = toSpec(server, {
      mode: 'recipe',
      step: 'file_mvbs',
      status: 'found',
      kind: 'dataset',
      instances: [instance],
    });
    expect(isPieceSet(spec)).toBe(true);
    if (!isPieceSet(spec)) return;
    expect(spec.name).toBe('file_mvbs');
    expect(spec.pieces[0]).toMatchObject({
      id: 'abc123',
      label: instance.item,
      header: 'http://127.0.0.1:8000/api/describe/m1',
      store: 'http://127.0.0.1:8000/mount/m1/',
      pings: 12,
    });
  });

  it('refuses a step with nothing to draw', () => {
    expect(() =>
      toSpec(server, { mode: 'recipe', step: 's', status: 'not_run' }),
    ).toThrow(/nothing to draw/);
  });

  it('keeps URLs on the page origin when the server is a path', () => {
    const resolution: Resolution = {
      mode: 'artifacts',
      step: 'dive_sv',
      status: 'found',
      kind: 'dataset',
      fannedOut: true,
      instances: [instance, { ...instance, id: 'def456', mount: 'm2' }],
    };
    const spec = toSpec('/echogram/', resolution);
    if (!isPieceSet(spec)) throw new Error('expected pieces');
    expect(spec.pieces.map((piece) => [piece.header, piece.store])).toEqual([
      ['/echogram/api/describe/m1', '/echogram/mount/m1/'],
      ['/echogram/api/describe/m2', '/echogram/mount/m2/'],
    ]);
    const pyramid = { ...resolution, kind: 'pyramid' as const, mount: 'p1' };
    expect(toSpec('/echogram', pyramid)).toBe('/echogram/mount/p1/');
  });
});

describe('a host resolving its own artifacts', () => {
  it('counts empty instances apart from ones that failed', () => {
    const skipped = (error: string, empty?: boolean) => ({ store: 's', error, empty });
    const text = describeFound({
      mode: 'artifacts',
      step: 'dive_sv',
      status: 'found',
      kind: 'dataset',
      instances: [],
      skipped: [
        skipped('empty instance (no data in this file)', true),
        skipped('not a zarr dataset (json)'),
      ],
      empty: 1,
    });
    expect(text).toBe(
      'dive_sv: 0 dataset(s), 1 empty; 1 skipped, first: not a zarr dataset (json)',
    );
  });

  it('says a step with nothing saved has nothing to draw', () => {
    const text = describeMiss({ mode: 'artifacts', step: 'dive_sv', status: 'not_run' });
    expect(text).toBe('dive_sv has no saved output to draw.');
  });

  it('gives the reason a saved output cannot be drawn', () => {
    const text = describeMiss({
      mode: 'artifacts',
      step: 'model',
      status: 'found',
      kind: null,
      outputs: [{ name: 'fit', format: 'pickle', kind: null, reason: 'a pickled output' }],
    });
    expect(text).toContain('fit: a pickled output');
  });
});
