import { describe, expect, it } from 'vitest';

import { browserReadable, nameOf, openUrl } from '../src/shell/providers/paths';
import { freeId } from '../src/shell/providers/provider';
import { type StepQuery, resolveUrl } from '../src/shell/providers/recipe';

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
