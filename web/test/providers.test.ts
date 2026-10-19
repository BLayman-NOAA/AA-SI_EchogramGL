import { describe, expect, it } from 'vitest';

import { isPieceSet } from '../src/data/pieces';
import {
  type Resolution,
  choices,
  draws,
  preferred,
  sameCheckpoint,
  sourceName,
  toSpec,
} from '../src/shell/providers/catalog';
import { browserReadable, nameOf, openUrl } from '../src/shell/providers/paths';
import { freeId } from '../src/shell/providers/provider';
import { type StepQuery, describeMiss, resolveUrl } from '../src/shell/providers/recipe';

const query: StepQuery = {
  recipe: 'C:/recipes/survey.yaml',
  step: 'viewer_file_mvbs',
  inputs: ['bin_s=10', 'grid_max_depth=3010m'],
  caches: ['gs://bucket/user_cache'],
  start: '2016-07-25T20:58',
  end: '',
};

describe('asking the server', () => {
  it('names a recipe, its inputs and a window', () => {
    const url = new URL(resolveUrl('http://127.0.0.1:5173/', query));
    expect(url.pathname).toBe('/api/resolve');
    expect(url.searchParams.get('recipe')).toBe(query.recipe);
    expect(url.searchParams.getAll('input')).toEqual(query.inputs);
    expect(url.searchParams.get('start')).toBe(query.start);
    expect(url.searchParams.has('end')).toBe(false);
    // A recipe names its own caches.
    expect(url.searchParams.has('cache')).toBe(false);
  });

  it('names an output and a variable once one is chosen', () => {
    const plain = new URL(resolveUrl('http://127.0.0.1:5173/', query));
    expect(plain.searchParams.has('output')).toBe(false);
    expect(plain.searchParams.has('var')).toBe(false);
    const chosen = new URL(
      resolveUrl('http://127.0.0.1:5173/', { ...query, output: 'ds_normalized', var: 'grid' }),
    );
    expect(chosen.searchParams.get('output')).toBe('ds_normalized');
    expect(chosen.searchParams.get('var')).toBe('grid');
  });

  it('names cache roots when there is no recipe', () => {
    const url = new URL(resolveUrl('http://127.0.0.1:5173/', { ...query, recipe: '' }));
    expect(url.searchParams.getAll('cache')).toEqual(query.caches);
    expect(url.searchParams.has('input')).toBe(false);
  });
});

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
});

describe('the paths picker', () => {
  it('lets the browser read URLs and leaves paths to the server', () => {
    expect(browserReadable('/store/')).toBe(true);
    expect(browserReadable('https://example.org/view.zarr/')).toBe(true);
    expect(browserReadable('gs://bucket/pyramid.zarr')).toBe(false);
    expect(browserReadable('C:/data/sv.zarr')).toBe(false);
  });

  it('asks the server about a path', () => {
    const url = new URL(openUrl('http://127.0.0.1:8000/', 'gs://bucket/a b.zarr'));
    expect(url.pathname).toBe('/api/open');
    expect(url.searchParams.get('path')).toBe('gs://bucket/a b.zarr');
    expect(url.searchParams.has('var')).toBe(false);
    const chosen = new URL(openUrl('http://127.0.0.1:8000/', 'C:/d.zarr', 'grid'));
    expect(chosen.searchParams.get('var')).toBe('grid');
  });

  it('names a source after the last part of its location', () => {
    expect(nameOf('gs://bucket/run/pyramid.zarr/')).toBe('pyramid.zarr');
    expect(nameOf('C:\\data\\sv.zarr')).toBe('sv.zarr');
    expect(nameOf('/store/')).toBe('store');
  });

  it('picks an id not yet taken', () => {
    expect(freeId(['store'], 'store')).toBe('store-2');
    expect(freeId(['store', 'store-2'], 'store')).toBe('store-3');
    expect(freeId([], 'store')).toBe('store');
  });
});
