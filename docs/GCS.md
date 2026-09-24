# Testing against Google Cloud Storage

From a survey in the bucket to a viewer drawing it. Verified against
`gs://ggn-nmfs-aa-dev-1-data` on 2026-09-05, except where it says otherwise.

The viewer itself never learns about GCS. The server reads the bucket and the
browser reads the server, which is why none of this needs the bucket made
public or CORS configured on it.

## Once

```bash
pip install -e ".[gcs]"          # in the AA-SI_EchogramGL venv: fsspec + gcsfs
gcloud auth application-default login
```

Application default credentials are what `gcsfs` reads, and they are separate
from the `gcloud` CLI token: the CLI can be asking you to re-login while ADC
still works, and the reverse. If a read fails with a permission error, do both.

## 1. Build the pyramid

The build reads any dataset xarray can open and writes a store. The input can
be local or a `gs://` URL.

```bash
aa-echogram build \
  --input  gs://ggn-nmfs-aa-dev-1-data/Jech_Test/HB2407/recipe_1/user_cache/.../ds_Sv.zarr \
  --out    ./hb2407_pyramid \
  --levels 8
```

For anything with masking or a seabed line in it, run the recipe first and
build from the checkpoint. `scripts/build_viewer_store.py` does that: it finds
the checkpoint for a step, reads the positions alongside it, and writes the
store. It needs the recipe_manager venv, because it imports echopype.

```bash
../AA-SI_recipe_manager/.venv/Scripts/python scripts/build_viewer_store.py \
  --recipe ../AA-SI_recipe_manager/example_recipes/HB2407/echogram_masked.yaml \
  --step   apply_mask \
  --out    ./hb2407_pyramid
```

Check it before publishing anything:

```bash
aa-echogram validate ./hb2407_pyramid
```

**Build locally, then upload.** Writing straight to `gs://` works, but a build
is thousands of small writes and each one is a request; a local build followed
by one parallel copy is faster and easier to retry.

**Do not use a `file://` URL for `--out`.** zarr resolves it to a local store
over a mangled relative path rather than through fsspec, so the levels land in
a directory named `file:` under wherever you ran the command while the
summaries sidecar goes where you asked. Plain paths and `gs://` are both fine;
it is only `file://` that is treated this way.

## 2. Publish it

```bash
gcloud storage cp -r ./hb2407_pyramid \
  gs://ggn-nmfs-aa-dev-1-data/Test_Layman/echogram_stores/hb2407_masked
```

The HB2407 masked pyramid is 17 MB over eight levels, so this is quick. Then
confirm the store reads back from where it now lives:

```bash
aa-echogram validate gs://ggn-nmfs-aa-dev-1-data/Test_Layman/echogram_stores/hb2407_masked
```

## 3. Serve it

```bash
aa-echogram serve \
  --store gs://ggn-nmfs-aa-dev-1-data/Test_Layman/echogram_stores/hb2407_masked \
  --app   src/aa_si_echogram_gl/static \
  --port  8129
```

Open `http://127.0.0.1:8129/`. The app and the store come from one origin, so
the browser stays in a secure context and never talks to Google directly.

Every chunk is a round trip from the server to the bucket and another to the
browser, so expect it to feel slower than a local store, and slower again from
outside the region. That is the honest shape of it and not something the
viewer can fix: the pyramid is what keeps the number of those round trips
small.

If the app is not built yet:

```bash
cd web && npm run build
```

## What was verified, and what was not

Verified against the live bucket: reading a real object through
`serve --store gs://...` end to end over HTTP, byte count matching what GCS
reports, and a missing key answering 404. `gs://` resolves to an fsspec store
for both reading and writing.

Not verified end to end: the upload in step 2 and a browser drawing from a
published store, because that means writing to shared infrastructure and is
yours to run.

## Why it is built this way

`serve` reads the store through fsspec and hands bytes to the browser, so the
credentials stay on your machine and the bucket needs no change. Reading a
bucket straight from the page would need CORS configured on it and either
public objects or a token in the page, which is milestone 14 and a different
set of decisions.

Nothing in `web/src/data/` knows any of this. It asks a `ChunkStore` for a key
and gets bytes, which is the same interface whether they came from disk, from
this server, or from a bucket. That separation is enforced by the layer rule.
