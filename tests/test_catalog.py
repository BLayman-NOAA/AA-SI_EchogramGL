"""Finding a step's output in a recipe cache, and describing it."""

import base64
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

import numpy as np
import pytest
from catalog_fixtures import NEW, key, write_entry, write_zarr
from recipe_ops import FILES, PINGS, file_mvbs

from aa_si_echogram_gl import catalog, describe, fixtures, serve

pytestmark = pytest.mark.usefixtures("index_dir")

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

    def index(url, options, var=None):
        opened.append(url)
        return original(url, options, var)

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


def test_a_record_from_another_version_is_not_used(monkeypatch):
    current = catalog.CACHE_VERSION
    monkeypatch.setattr(catalog, "CACHE_VERSION", current - 1)
    assert catalog.cached("variables", "store", lambda: {"n": "old"}) == {"n": "old"}
    monkeypatch.setattr(catalog, "CACHE_VERSION", current)
    assert catalog.cached("variables", "store", lambda: {"n": "new"}) == {"n": "new"}
    assert len(list(catalog.cache_dir().glob("variables-*.json"))) == 2


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


def test_an_unknown_mount_is_gone_on_describe_too(served):
    """After a restart: the client resolves again on 410, not on 404."""
    base, _ = served
    status, body = fetch(f"{base}/api/describe/0123456789abcdef")
    assert status == 410
    assert json.loads(body)["error"] == serve.GONE


def test_zarr_metadata_is_served_as_json(served):
    base, cache = served
    query = urlencode({"cache": str(cache), "step": "file_mvbs"})
    mount = json.loads(fetch(f"{base}/api/resolve?{query}")[1])["instances"][0]["mount"]
    with urllib.request.urlopen(f"{base}/mount/{mount}/Sv/.zarray") as response:
        assert response.headers["Content-Type"] == "application/json; charset=utf-8"
    with urllib.request.urlopen(f"{base}/mount/{mount}/Sv/1.0.0") as response:
        assert response.headers["Content-Type"] == "application/octet-stream"


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


def labelled(url):
    """MVBS with a cluster label grid beside it, as embed_results writes it."""
    ds = file_mvbs(url)
    grid = np.full((PINGS, ds.sizes["range_sample"]), np.nan)
    grid[:, :8] = -1
    grid[:, 8:12] = 0
    grid[:, 12:16] = 3
    ds["ml_dataset_hdbscan_results_grid"] = (("ping_time", "range_sample"), grid)
    ds["ml_dataset_hdbscan_results_grid"].attrs["source_variable"] = "ml_dataset_r"
    return ds


@pytest.fixture
def embedded(cache):
    """An embed_results entry beside the template cache's steps."""
    url = FILES[0]
    path = write_entry(cache, "embed_results", key("e"), "ds_normalized", "zarr",
                       NEW, "2026-02-01T00:00:00")
    write_zarr(labelled(url), path, mode="w", consolidated=True)
    return cache, path


GRID = "ml_dataset_hdbscan_results_grid"


def test_a_dataset_output_lists_what_it_can_draw(embedded):
    cache, _ = embedded
    found = catalog.resolve_cache([str(cache)], "embed_results")
    [output] = found["outputs"]
    kinds = {item["name"]: item["kind"] for item in output["variables"]}
    assert kinds == {"Sv": "mvbs", GRID: "labels"}
    assert output["default"] == "Sv"
    assert found["var"] == "Sv"
    assert found["instances"][0]["channels"] == 2


def test_a_variable_is_chosen_by_name(embedded):
    cache, _ = embedded
    found = catalog.resolve_cache([str(cache)], "embed_results", var=GRID)
    assert found["var"] == GRID
    [instance] = found["instances"]
    assert instance["var"] == GRID
    assert instance["channels"] == 1
    assert instance["dims"] == ["ping_time", "range_sample"]


def test_a_variable_the_output_lacks_is_refused(embedded):
    cache, _ = embedded
    with pytest.raises(catalog.CatalogError, match="no variable"):
        catalog.resolve_cache([str(cache)], "embed_results", var="nothing")


def test_a_path_opens_any_of_its_variables(embedded):
    _, path = embedded
    found = catalog.open_path(str(path), var=GRID)
    assert found["var"] == GRID
    assert {v["name"] for v in found["outputs"][0]["variables"]} == {"Sv", GRID}


def test_each_variable_is_its_own_mount(served, embedded):
    base, cache = served
    query = {"cache": str(cache), "step": "embed_results"}
    sv = json.loads(fetch(f"{base}/api/resolve?{urlencode(query)}")[1])
    labels = json.loads(
        fetch(f"{base}/api/resolve?{urlencode({**query, 'var': GRID})}")[1]
    )
    sv_mount = sv["instances"][0]["mount"]
    label_mount = labels["instances"][0]["mount"]
    assert sv_mount != label_mount
    meta = json.loads(fetch(f"{base}/mount/{label_mount}/{GRID}/.zarray")[1])
    assert meta["shape"] == [PINGS, 20]
    header = json.loads(fetch(f"{base}/api/describe/{label_mount}")[1])
    assert header["kind"] == "labels"
    assert header["order"]["channel"] is None
    assert header["dataType"] == "Cluster-MVBS"
    # The two describe the same pings, so they draw over each other.
    sv_header = json.loads(fetch(f"{base}/api/describe/{sv_mount}")[1])
    assert header["sidecars"]["ping_time"] == sv_header["sidecars"]["ping_time"]


def test_an_unknown_variable_is_a_bad_request(served, embedded):
    base, cache = served
    query = urlencode({"cache": str(cache), "step": "embed_results", "var": "nope"})
    assert fetch(f"{base}/api/resolve?{query}")[0] == 400


def records_of(cache, step, tier="root0", payload=NEW):
    """Artifact records for one computation, as a host would report them."""
    entries = catalog.read_entries(catalog.Tier(tier, str(cache)), step)
    found = []
    for entry in entries:
        if entry.meta.get("fingerprint_payload") != payload:
            continue
        discriminator = entry.meta.get("instance_discriminator") or {}
        for output, held in entry.meta["outputs"].items():
            found.append({
                "output": output,
                "url": entry.artifact(output),
                "format": held["format"],
                "tier": entry.tier,
                "step_hash": entry.meta["step_hash"],
                "instance_index": entry.meta.get("instance_index"),
                "item": discriminator.get("item"),
                "created_at": entry.meta.get("created_at"),
                "run_id": entry.meta.get("run_id"),
            })
    return found


def test_records_of_one_hash_are_one_entry():
    record = {
        "output": "ds_Sv", "url": "C:/cache/sv/abc/run1/zarr/ds_Sv.zarr",
        "format": "zarr", "tier": "user", "step_hash": "abc",
        "instance_index": None, "item": None, "created_at": "2026-10-01",
        "run_id": "run1",
    }
    other = {**record, "output": "fit", "url": "C:/cache/sv/abc/fit.pkl",
             "format": "pickle"}
    [entry] = catalog.entries_from_artifacts([record, other])
    assert set(entry.meta["outputs"]) == {"ds_Sv", "fit"}
    assert entry.artifact("ds_Sv") == record["url"]
    assert entry.meta["instance_discriminator"] is None
    assert catalog.stamp_of(entry) == "run1@2026-10-01"


def test_a_posix_path_is_used_as_it_is():
    record = {"output": "o", "url": "/home/me/cache/o.zarr", "format": "zarr",
              "step_hash": "h"}
    [entry] = catalog.entries_from_artifacts([record])
    assert entry.artifact("o") == "/home/me/cache/o.zarr"


def test_artifacts_resolve_as_the_cache_does(cache):
    records = records_of(cache, "file_mvbs")
    found = catalog.resolve_artifacts(
        list(reversed(records)), True, step="file_mvbs", step_hash="s1"
    )
    assert (found["mode"], found["status"], found["kind"]) == (
        "artifacts", "found", "dataset"
    )
    assert found["fannedOut"]
    assert (found["step"], found["stepHash"]) == ("file_mvbs", "s1")
    assert [i["index"] for i in found["instances"]] == [0, 1, 2]
    assert [i["item"] for i in found["instances"]] == FILES
    assert found["instances"][0]["start"] == ns("2016-07-25T20:58:00")
    expected = catalog.resolve_cache([str(cache)], "file_mvbs")
    assert found["instances"] == expected["instances"]
    assert found["entries"] == 3


def test_a_pyramid_artifact_is_one_store(cache):
    found = catalog.resolve_artifacts(records_of(cache, "store"), False, step="store")
    assert found["kind"] == "pyramid"
    assert found["store"].endswith("pyramid.zarr")


def test_no_artifacts_is_not_run():
    found = catalog.resolve_artifacts([], True, step="sv")
    assert found == {"mode": "artifacts", "step": "sv", "fannedOut": True,
                     "status": "not_run"}


def test_artifacts_choose_a_variable(embedded):
    cache, _ = embedded
    records = records_of(cache, "embed_results")
    found = catalog.resolve_artifacts(records, False, var=GRID)
    assert found["var"] == GRID
    assert found["instances"][0]["channels"] == 1
    with pytest.raises(catalog.CatalogError, match="no variable"):
        catalog.resolve_artifacts(records, False, var="nothing")


def test_a_pickled_artifact_says_why(cache):
    found = catalog.resolve_artifacts(records_of(cache, "model"), False)
    assert found["kind"] is None
    assert "pickled" in found["outputs"][0]["reason"]


def test_mount_resolution_mounts_artifacts(cache):
    mounts = serve.Mounts([])
    found = catalog.resolve_artifacts(records_of(cache, "file_mvbs"), True)
    serve.mount_resolution(found, mounts)
    assert all(mounts.known(i["mount"]) for i in found["instances"])


def test_a_host_allows_roots_as_it_goes(cache):
    mounts = serve.Mounts([])
    with pytest.raises(PermissionError):
        mounts.check([str(cache)])
    mounts.allow([str(cache)])
    mounts.allow([str(cache)])
    mounts.check([str(cache / "file_mvbs")])
    assert len(mounts.roots) == 1
    anything = serve.Mounts()
    anything.allow([str(cache)])
    assert anything.roots is None


def test_a_window_parses_or_is_absent():
    assert serve.parse_window(None, "") is None
    assert serve.parse_window("2016-07-25T20:58", None) == (
        ns("2016-07-25T20:58"), 2**62
    )
    with pytest.raises(catalog.CatalogError):
        serve.parse_window("soon", None)


def test_an_empty_instance_is_skipped_and_counted(cache, tmp_path):
    """A mapped step saves a file with no pings in its window as JSON null."""
    empty = tmp_path / "dive_sv" / "861fad08" / "run" / "json" / "ds_MVBS.json"
    empty.parent.mkdir(parents=True)
    empty.write_text("null", encoding="utf-8")
    value = tmp_path / "value.json"
    value.write_text("[1, 2]", encoding="utf-8")
    records = records_of(cache, "file_mvbs")
    first = {**records[0], "format": "json", "step_hash": "e" * 64,
             "instance_index": -1, "url": str(empty).replace("/", "\\")}
    other = {**first, "step_hash": "f" * 64, "instance_index": 9,
             "url": str(value)}
    found = catalog.resolve_artifacts([first, *records, other], True)
    assert found["kind"] == "dataset"
    assert len(found["instances"]) == 3
    assert [s["error"] for s in found["skipped"]] == [
        "empty instance (no data in this file)",
        "not a zarr dataset (json)",
    ]
    assert found["empty"] == 1


def test_an_instance_without_the_output_is_skipped(cache):
    records = records_of(cache, "file_mvbs")
    other = {**records[0], "output": "ds_other", "step_hash": "g" * 64,
             "instance_index": 7}
    found = catalog.resolve_artifacts([*records, other], True)
    assert len(found["instances"]) == 3
    [skipped] = found["skipped"]
    assert skipped["error"] == "this instance has no output 'ds_MVBS'"
    assert skipped["store"] == ""


def test_a_link_inside_a_root_cannot_reach_outside(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    link = root / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("this machine does not allow symbolic links")
    mounts = serve.Mounts([str(root)])
    mounts.check([str(root / "real")])
    with pytest.raises(PermissionError):
        mounts.check([str(link / "anything")])


def test_the_vertical_coordinate_is_not_a_choice():
    ds = fixtures.synthetic(n_pings=6, n_samples=10, gps=False)
    assert "depth" in ds.data_vars
    assert [v["name"] for v in describe.drawable_variables(ds)] == ["Sv"]
    alone = ds[["depth"]]
    assert [v["name"] for v in describe.drawable_variables(alone)] == ["depth"]
