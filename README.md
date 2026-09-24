# AA-SI_EchogramGL

GPU echogram viewer for AA-SI. A WebGPU rendering component with a Python store
builder and control plane.

Design documents live in
`Workflow_Recipe_Software_Documentation/WebGL_Visualization/`.

## Status

Milestone 2 of 14. The store contract and the pyramid builder are done, and one
level of one channel renders through a value pass with a matplotlib colormap.
There is no panning, no tiling and no per ping geometry yet.

## Layout

```
src/aa_si_echogram_gl/
  contract.py    the published store contract and its validator
  geometry.py    per ping geometry sidecar derivation
  summaries.py   per chunk nodata flags, ranges and histograms
  pyramid.py     build_pyramid(), the plain function over a Dataset
  colormaps.py   matplotlib colormap export for the web build
  serve.py       development server for a store and the built app
  fixtures.py    synthetic datasets with known geometry
  cli.py         aa-echogram build / validate / serve / colormaps
  static/        the built web bundle, written by the vite build

web/
  src/device/    GPU context, pipeline cache, value textures
  src/data/      store implementations and zarr access
  src/render/    colormaps, WGSL passes, layer draw
  src/app/       EchogramView
  src/shell/     development page
  test/          vitest
```

The builder is a plain function over an `xarray.Dataset`, not a recipe op. The
recipe op is a thin wrapper around it, so any dataset from any source can be
made viewable without the recipe system being involved.

## Development

```
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"
.venv/Scripts/python -m pytest
```

```
cd web
npm install
npm test
npm run typecheck
npm run layers
```

`npm run layers` enforces the import rule from Software_Architecture.md section
2: nothing below the shell may import the shell. It is what keeps the view
embeddable in a host application that brings its own chrome.

## Building a store

```
aa-echogram build --input survey_mvbs.zarr --out ./scratch/view.zarr
aa-echogram validate ./scratch/view.zarr
```

## Viewing one

```
aa-echogram serve --store ./scratch/view.zarr --port 8000
cd web && npm run dev
```

Open the address vite prints. The dev server proxies `/store` to
`aa-echogram serve`, so the browser sees one origin and stays in a secure
context, which is what WebGPU requires. Set `ECHOGRAM_STORE_ORIGIN` if the
store is served somewhere other than `http://127.0.0.1:8000`.

`npm run build` writes the bundle into `src/aa_si_echogram_gl/static/`, which
`aa-echogram serve --app` can then host alongside the store from one port.

## Colormaps

Colormap definitions come from matplotlib rather than being written a second
time in TypeScript, so a value maps to the same color the existing
`AA-SI_Visualization` figures use.

```
aa-echogram colormaps
```

writes `web/src/render/colormaps.json`, which the web build imports, and
`web/test/colormaps.reference.json`, which the web test asserts against.
