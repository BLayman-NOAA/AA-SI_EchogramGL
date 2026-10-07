"""Finding a step's output in a recipe cache, and describing it."""

import base64
import json
import shutil
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

import numpy as np
import pytest
import zarr
from recipe_ops import FILES, PINGS, file_mvbs

from aa_si_echogram_gl import catalog, describe, fixtures, ops, serve

OLD = {"fingerprint": {"params": {"bin_s": 20}}, "parents": [], "epoch": None}
NEW = {"fingerprint": {"params": {"bin_s": 10}}, "parents": [], "epoch": None}


@pytest.fixture(autouse=True)
def index_dir(tmp_path, monkeypatch):
    """Keep indexes and headers out of the user's cache."""
    monkeypatch.setenv("AA_ECHOGRAM_CACHE", str(tmp_path / "index"))


def write_entry(root, step, key, output, form, payload, created,
                instance=None, item=None):
    """Write a cache entry's sidecar and return its run directory."""
    directory = root / step / key[: catalog.HASH_PREFIX]
    directory.mkdir(parents=True)
    meta = {
        "step_id": step,
        "step_hash": key,
        "run_id": "run1",
        "created_at": created,
        "outputs": {output: {"path": f"run1/zarr/{output}.zarr", "format": form}},
        "fingerprint_payload": payload,
        "instance_index": instance,
        "instance_discriminator": {"item": item} if item else None,
    }
    (directory / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return directory / "run1" / "zarr" / f"{output}.zarr"


def key(text):
    return f"{text:0<64}"


def write_zarr(value, path, attempts=5, **options):
    """Write a store, retrying the rename Windows sometimes refuses.

    zarr writes metadata to a temporary file and renames it into place, and on
    Windows a scanner holding the new file makes the rename fail with access
    denied. The recipe manager's own writer retries for the same reason.
    """
    for attempt in range(attempts):
        try:
            return value.to_zarr(path, zarr_format=2, **options)
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.2 * (attempt + 1))


@pytest.fixture(scope="module")
def template(tmp_path_factory):
    """A cache holding two computations of a mapped step, a pyramid and a pickle.

    Written once for the module and copied for each test, since writing zarr
    is the slow part and the part that can be refused.
    """
    root = tmp_path_factory.mktemp("template") / "cache"
    for index, url in enumerate(FILES[:2]):
        path = write_entry(root, "file_mvbs", key(f"a{index}"), "ds_MVBS", "zarr",
                           OLD, "2026-01-01T00:00:00", index, url)
        ds = file_mvbs(url, bin_s=20)
        write_zarr(ds, path, mode="w", consolidated=True)
    for index, url in enumerate(FILES):
        path = write_entry(root, "file_mvbs", key(f"b{index}"), "ds_MVBS", "zarr",
                           NEW, f"2026-02-0{index + 1}T00:00:00", index, url)
        ds = file_mvbs(url)
        write_zarr(ds, path, mode="w", consolidated=True)

    tree = ops.build_echogram_pyramid(
        fixtures.synthetic(n_pings=32, n_samples=12, gridded=True, gps=False),
        levels=2,
        range_var="depth",
    )
    path = write_entry(root, "store", key("c"), "pyramid", "zarr_tree",
                       NEW, "2026-02-01T00:00:00")
    # Consolidated once at the end, as the checkpoint writer does. Consolidating
    # per node renames the same file once per level.
    write_zarr(tree, path, mode="w", consolidated=False)
    zarr.consolidate_metadata(str(path), zarr_format=2)

    write_entry(root, "model", key("d"), "fit", "pickle", NEW, "2026-02-01T00:00:00")
    return root


@pytest.fixture
def cache(template, tmp_path):
    """A copy of the template cache that a test may add to."""
    root = tmp_path / "cache"
    shutil.copytree(template, root)
    return root


def ns(text):
    return int(np.datetime64(text, "ns").astype("int64"))


def test_cache_mode_takes_the_newest_computation(cache):
    found = catalog.resolve_cache([str(cache)], "file_mvbs")
    assert found["status"] == "found"
    assert found["fannedOut"]
    assert found["kind"] == "dataset"
    assert [i["id"] for i in found["instances"]] == [key(f"b{i}") for i in range(3)]


def test_instances_are_placed_in_time(cache):
    found = catalog.resolve_cache([str(cache)], "file_mvbs")
    first = found["instances"][0]
    assert first["start"] == ns("2016-07-25T20:58:00")
    assert first["end"] == ns("2016-07-25T20:58:00") + (PINGS - 1) * 10 * 10**9
    assert first["pings"] == PINGS
    assert (first["channels"], first["samples"]) == (2, 20)
    assert first["var"] == "Sv"
    assert first["item"] == FILES[0]
    assert first["bytes"] > 0


def test_a_window_keeps_the_instances_it_reaches(cache):
    window = (ns("2016-07-25T21:09:00"), ns("2016-07-25T21:10:00"))
    found = catalog.resolve_cache([str(cache)], "file_mvbs", window=window)
    assert [i["item"] for i in found["instances"]] == [FILES[1]]


def counting(monkeypatch):
    """Record every dataset the index opens."""
    opened = []
    original = catalog._index

    def index(url, options):
        opened.append(url)
        return original(url, options)

    monkeypatch.setattr(catalog, "_index", index)
    return opened


def test_file_names_narrow_what_is_indexed(cache, monkeypatch):
    opened = counting(monkeypatch)
    window = (ns("2016-07-25T21:20:00"), ns("2016-07-25T21:30:00"))
    catalog.resolve_cache([str(cache)], "file_mvbs", window=window)
    assert len(opened) == 1


def test_an_index_is_read_once(cache, monkeypatch):
    opened = counting(monkeypatch)
    catalog.resolve_cache([str(cache)], "file_mvbs")
    catalog.resolve_cache([str(cache)], "file_mvbs")
    assert len(opened) == 3


def test_a_pyramid_is_one_store(cache):
    found = catalog.resolve_cache([str(cache)], "store")
    assert found["kind"] == "pyramid"
    assert found["store"].endswith("pyramid.zarr")
    assert "instances" not in found


def test_a_pickle_says_why_it_cannot_be_drawn(cache):
    found = catalog.resolve_cache([str(cache)], "model")
    assert found["kind"] is None
    assert "pickled" in found["outputs"][0]["reason"]


def test_a_step_with_no_entries_was_never_run(cache):
    assert catalog.resolve_cache([str(cache)], "nothing")["status"] == "never_run"


def test_the_user_tier_is_read_first(cache, tmp_path):
    survey = tmp_path / "survey"
    url = FILES[0]
    path = write_entry(survey, "file_mvbs", key("b0"), "ds_MVBS", "zarr",
                       NEW, "2026-03-01T00:00:00", 0, url)
    ds = file_mvbs(url)
    write_zarr(ds, path, mode="w", consolidated=True)
    found = catalog.resolve_cache([str(cache), str(survey)], "file_mvbs")
    first = next(i for i in found["instances"] if i["id"] == key("b0"))
    assert first["tier"] == "root0"
    assert len(found["instances"]) == 3


def decode(sidecar):
    raw = base64.b64decode(sidecar["data"])
    return np.frombuffer(raw, dtype="<f8").reshape(sidecar["shape"])


def test_describe_a_gridded_dataset(cache):
    found = catalog.resolve_cache([str(cache)], "file_mvbs")
    header = describe.describe(found["instances"][0]["store"])
    assert header["kind"] == "mvbs"
    assert header["gridded"]
    assert header["order"] == {"channel": 0, "ping": 1, "sample": 2}
    assert header["channels"] == 2
    assert header["pings"] == PINGS
    ping_time = decode(header["sidecars"]["ping_time"])
    assert ping_time[0] == ns("2016-07-25T20:58:00")
    expected = file_mvbs(FILES[0])["depth"].values
    start = decode(header["sidecars"]["range_start"])
    step = decode(header["sidecars"]["range_step"])
    assert start.shape == (2, PINGS)
    assert np.allclose(start, expected[0])
    assert np.allclose(step, expected[1] - expected[0])


def test_describe_reads_only_the_start_of_a_per_ping_vertical(tmp_path):
    ds = fixtures.synthetic(n_pings=6, n_samples=400, gps=False, nodata=False)
    path = tmp_path / "sv.zarr"
    write_zarr(ds, path, consolidated=True)
    header = describe.describe(str(path))
    assert header["kind"] == "sv"
    assert header["samples"] == 400
    start = decode(header["sidecars"]["range_start"])
    step = decode(header["sidecars"]["range_step"])
    assert np.allclose(start, ds["depth"].values[:, :, 0])
    spacing = ds["depth"].values[:, :, 1] - ds["depth"].values[:, :, 0]
    assert np.allclose(step, spacing)


def test_describe_finds_gridded_cluster_labels(tmp_path):
    """As embed_clustering_results grids one result: float64, NaN where
    nothing was clustered, marked by the variable it was gridded from."""
    ds = fixtures.synthetic(n_pings=6, n_samples=10, gridded=True, gps=False)
    labels = ds["Sv"].isel(channel=0, drop=True) * 0 + 3.0
    labels[:, -2:] = np.nan
    labels.attrs["source_variable"] = "hdbscan_pass1_ml_data_clean"
    path = tmp_path / "gridded.zarr"
    write_zarr(labels.to_dataset(name="_da"), path, consolidated=True)
    header = describe.describe(str(path))
    assert header["kind"] == "labels"
    assert header["dataType"] == "Cluster-MVBS"


def test_describe_finds_labels_and_a_checkpointed_dataarray(tmp_path):
    ds = fixtures.synthetic(n_pings=6, n_samples=10, gridded=True, gps=False)
    labels = ds["Sv"].isel(channel=0, drop=True).fillna(0).astype("int16")
    path = tmp_path / "labels.zarr"
    named = labels.to_dataset(name="_da")
    write_zarr(named, path, consolidated=True)
    header = describe.describe(str(path))
    assert header["var"] == "_da"
    assert header["kind"] == "labels"
    assert header["order"]["channel"] is None
    assert header["channels"] == 1


@pytest.fixture
def served(cache):
    """The development server with catalog routes, limited to the cache."""
    mounts = serve.Mounts([str(cache)])
    server = ThreadingHTTPServer(("127.0.0.1", 0), serve.make_handler(mounts=mounts))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", cache
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def fetch(url):
    try:
        with urllib.request.urlopen(url) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def test_resolve_mounts_each_instance(served):
    base, cache = served
    query = urlencode({"cache": str(cache), "step": "file_mvbs"})
    status, body = fetch(f"{base}/api/resolve?{query}")
    assert status == 200
    found = json.loads(body)
    mount = found["instances"][0]["mount"]
    status, body = fetch(f"{base}/mount/{mount}/Sv/.zarray")
    assert status == 200
    assert json.loads(body)["chunks"] == [1, PINGS, 20]
    assert fetch(f"{base}/mount/{mount}/Sv/1.0.0")[0] == 200
    status, body = fetch(f"{base}/api/describe/{mount}")
    assert status == 200
    header = json.loads(body)
    assert header["kind"] == "mvbs"
    assert header["chunks"] == [1, PINGS, 20]


def test_a_mount_is_stable_across_resolves(served):
    base, cache = served
    query = urlencode({"cache": str(cache), "step": "file_mvbs"})
    first = json.loads(fetch(f"{base}/api/resolve?{query}")[1])
    second = json.loads(fetch(f"{base}/api/resolve?{query}")[1])
    assert first["instances"][0]["mount"] == second["instances"][0]["mount"]


def test_unknown_mounts_and_escapes_are_refused(served):
    base, cache = served
    # Gone rather than missing: the client reads a missing chunk as fill.
    assert fetch(f"{base}/mount/0123456789abcdef/Sv/.zarray")[0] == 410
    query = urlencode({"cache": str(cache), "step": "file_mvbs"})
    mount = json.loads(fetch(f"{base}/api/resolve?{query}")[1])["instances"][0]["mount"]
    assert fetch(f"{base}/mount/{mount}/..%2F..%2Fmeta.json")[0] == 404


def test_a_root_outside_the_allowed_ones_is_forbidden(served, tmp_path):
    base, _ = served
    query = urlencode({"cache": str(tmp_path / "elsewhere"), "step": "file_mvbs"})
    status, body = fetch(f"{base}/api/resolve?{query}")
    assert status == 403
    assert "--cache-root" in json.loads(body)["error"]


def test_a_request_with_no_step_is_a_bad_request(served):
    base, cache = served
    status, body = fetch(f"{base}/api/resolve?{urlencode({'cache': str(cache)})}")
    assert status == 400
    assert json.loads(body)["error"]


RECIPE = """
recipe:
  name: catalog_test
  version: "1.0"
  schema_version: "1"
inputs:
  bin_s:
    type: int
    default: {bin_s}
steps:
  - id: query
    op: custom
    custom_spec:
      description: list the files
      callable_path: recipe_ops.file_list
      outputs:
        raw_urls: {{type: list}}
      output_map:
        raw_urls: __return__
      dependency: {{name: pytest, version: ">=7.0", source: pypi}}
  - id: file_mvbs
    op: custom
    map_over: ${{query.raw_urls}}
    checkpoint: always
    inputs:
      url: ${{_item}}
    params:
      bin_s: ${{inputs.bin_s}}
    custom_spec:
      description: MVBS for one file
      callable_path: recipe_ops.file_mvbs
      inputs:
        url: {{type: str}}
      params:
        bin_s: {{type: int}}
      outputs:
        ds_MVBS: {{type: Dataset}}
      output_map:
        ds_MVBS: __return__
      dependency: {{name: pytest, version: ">=7.0", source: pypi}}
"""


@pytest.fixture
def recipe(tmp_path):
    """A recipe run once, with its cache beside it through a run config."""
    pytest.importorskip("aa_recipe_manager")
    from aa_recipe_manager.executor import SequentialExecutor
    from aa_recipe_manager.parser.dag_builder import build_dag
    from aa_recipe_manager.parser.yaml_reader import load_recipe
    from aa_recipe_manager.registry.registry import Registry

    folder = tmp_path / "recipes"
    folder.mkdir()
    (folder / "aa-recipe.config.yaml").write_text(
        "user_cache_dir: ./cache\n", encoding="utf-8"
    )
    path = folder / "survey.yaml"
    path.write_text(RECIPE.format(bin_s=10), encoding="utf-8")
    dag = build_dag(load_recipe(path), Registry(), check_versions=False)
    SequentialExecutor().execute(
        dag, user_cache_dir=folder / "cache", checkpoint_mode="eager"
    )
    return path


def test_recipe_mode_finds_the_run(recipe):
    found = catalog.resolve_recipe(recipe, "file_mvbs")
    assert found["status"] == "found"
    assert found["fannedOut"]
    assert [i["item"] for i in found["instances"]] == FILES
    assert found["instances"][0]["start"] == ns("2016-07-25T20:58:00")


def test_recipe_mode_reports_parameters_never_run(recipe):
    recipe.write_text(RECIPE.format(bin_s=30), encoding="utf-8")
    found = catalog.resolve_recipe(recipe, "file_mvbs")
    assert found["status"] == "not_run"
    paths = [d["path"] for d in found["differences"]]
    assert any(path.endswith("bin_s") for path in paths)


def test_recipe_mode_hashes_inputs_as_a_run_does(recipe):
    """An input given is part of the fingerprint, as `aa-recipe run --input`
    makes it, even where it equals the default. Given as text, as the CLI and
    the server both pass it."""
    from aa_recipe_manager.executor import SequentialExecutor
    from aa_recipe_manager.parser.dag_builder import build_dag
    from aa_recipe_manager.parser.yaml_reader import load_recipe
    from aa_recipe_manager.registry.registry import Registry

    inputs = {"bin_s": "30"}
    assert catalog.resolve_recipe(recipe, "file_mvbs", inputs)["status"] == "not_run"
    dag = build_dag(
        load_recipe(recipe), Registry(), input_values=inputs, check_versions=False
    )
    SequentialExecutor().execute(
        dag,
        inputs=inputs,
        user_cache_dir=recipe.parent / "cache",
        checkpoint_mode="eager",
    )
    found = catalog.resolve_recipe(recipe, "file_mvbs", inputs)
    assert found["status"] == "found"
    assert found["instances"][1]["end"] - found["instances"][1]["start"] == (
        (PINGS - 1) * 30 * 10**9
    )


def test_recipe_mode_names_a_missing_step(recipe):
    with pytest.raises(catalog.CatalogError, match="no step"):
        catalog.resolve_recipe(recipe, "nothing")


def test_an_instance_that_cannot_be_indexed_is_skipped(cache):
    """An empty file among the rest is reported, not fatal to the step."""
    url = "gs://bucket/raw/D20160725-T215800.raw"
    path = write_entry(cache, "file_mvbs", key("b9"), "ds_MVBS", "zarr",
                       NEW, "2026-02-09T00:00:00", 9, url)
    empty = file_mvbs(url).isel(ping_time=slice(0, 0))
    write_zarr(empty, path, mode="w", consolidated=True)
    found = catalog.resolve_cache([str(cache)], "file_mvbs")
    assert found["status"] == "found"
    assert len(found["instances"]) == 3
    assert [s["item"] for s in found["skipped"]] == [url]
    assert "no pings" in found["skipped"][0]["error"]


def test_a_record_is_computed_again_for_a_new_writing(tmp_path):
    computed = []

    def compute():
        computed.append(1)
        return {"n": len(computed)}

    assert catalog.cached("index", "store", compute, "run1") == {"n": 1}
    assert catalog.cached("index", "store", compute, "run1") == {"n": 1}
    assert catalog.cached("index", "store", compute, "run2") == {"n": 2}


def test_a_damaged_record_is_computed_again(tmp_path):
    catalog.cached("index", "store", lambda: {"n": 1})
    [path] = list(catalog.cache_dir().glob("index-*.json"))
    path.write_text('{"n": ', encoding="utf-8")
    assert catalog.cached("index", "store", lambda: {"n": 2}) == {"n": 2}
    assert not list(catalog.cache_dir().glob("*.partial"))


def test_a_failure_is_not_recorded(tmp_path):
    def broken():
        raise ValueError("unreadable")

    with pytest.raises(ValueError):
        catalog.cached("index", "store", broken)
    assert catalog.cached("index", "store", lambda: {"n": 1}) == {"n": 1}


def test_a_store_written_again_is_reopened(cache):
    mounts = serve.Mounts()
    url = str(cache / "anything")
    mount = mounts.add(url, tiled=False, stamp="run1")
    first = mounts.source(mount)
    assert mounts.add(url, tiled=False, stamp="run1") == mount
    assert mounts.source(mount) is first
    mounts.add(url, tiled=False, stamp="run2")
    assert mounts.source(mount) is not first


def test_a_pyramid_opens_by_its_path(cache):
    [store] = list((cache / "store").glob("*/run1/zarr/pyramid.zarr"))
    found = catalog.open_path(str(store))
    assert found["kind"] == "pyramid"
    assert found["store"] == str(store)


def test_a_dataset_opens_by_its_path_as_one_piece(cache):
    [store] = list((cache / "file_mvbs").glob("b0*/run1/zarr/ds_MVBS.zarr"))
    found = catalog.open_path(str(store))
    assert found["kind"] == "dataset"
    [instance] = found["instances"]
    assert instance["pings"] == PINGS
    assert instance["start"] == ns("2016-07-25T20:58:00")
    assert instance["stamp"]


def test_open_answers_over_http(served):
    base, cache = served
    [store] = list((cache / "file_mvbs").glob("b0*/run1/zarr/ds_MVBS.zarr"))
    status, body = fetch(f"{base}/api/open?{urlencode({'path': str(store)})}")
    assert status == 200
    mount = json.loads(body)["instances"][0]["mount"]
    assert fetch(f"{base}/mount/{mount}/Sv/.zarray")[0] == 200


def test_open_refuses_what_is_not_there_or_not_allowed(served, tmp_path):
    base, cache = served
    missing = urlencode({"path": str(cache / "nothing")})
    assert fetch(f"{base}/api/open?{missing}")[0] == 404
    outside = urlencode({"path": str(tmp_path / "elsewhere")})
    assert fetch(f"{base}/api/open?{outside}")[0] == 403
    assert fetch(f"{base}/api/open")[0] == 400
