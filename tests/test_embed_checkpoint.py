"""Cluster labels over the MVBS they came from, on a real embedding checkpoint.

Reads the HB1603 example's local embed_results checkpoint, and is skipped
where that checkpoint is absent. Asserts what the browser is given when the
checkpoint's Sv and its label grid are added as two sources.
"""

import base64
import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

import numcodecs
import numpy as np
import pytest

from aa_si_echogram_gl import catalog, describe, serve, tiles

ROOT = (Path(__file__).resolve().parents[2] / "AA-SI_Full_Pipeline_Example"
        / "example_recipes" / "HB1603" / "user_cache" / "embed_results")
STORE = ROOT / "de1e1f9c" / "162621-6eee3e" / "zarr" / "ds_normalized.zarr"
GRID = "ml_dataset_hdbscan_results_grid"

pytestmark = pytest.mark.skipif(not STORE.exists(), reason="no local embed checkpoint")


def sidecar(header, name):
    item = header["sidecars"][name]
    values = np.frombuffer(base64.b64decode(item["data"]), "<f8")
    return values.reshape(item["shape"])


def tile(source, var, key):
    raw = numcodecs.Zstd().decode(source.read(f"{var}/{key}"))
    return np.frombuffer(raw, "<f4")


def test_the_labels_are_offered_beside_the_mvbs():
    found = catalog.open_path(str(STORE))
    kinds = {v["name"]: v["kind"] for v in found["outputs"][0]["variables"]}
    assert kinds["Sv"] == "mvbs"
    assert kinds[GRID] == "labels"
    assert found["var"] == "Sv"


def test_the_labels_sit_on_the_mvbs_grid():
    sv = describe.describe(str(STORE), None, "Sv")
    labels = describe.describe(str(STORE), None, GRID)
    assert labels["kind"] == "labels"
    assert labels["dataType"] == "Cluster-MVBS"
    assert labels["order"]["channel"] is None
    assert labels["channels"] == 1
    assert (labels["pings"], labels["samples"]) == (sv["pings"], sv["samples"])
    assert labels["sidecars"]["ping_time"] == sv["sidecars"]["ping_time"]
    # Sv has a geometry row per channel, the labels one; it is the same row.
    for name in ("range_start", "range_step"):
        np.testing.assert_array_equal(sidecar(labels, name)[0], sidecar(sv, name)[0])


def test_a_label_tile_holds_noise_gaps_and_clusters():
    source = tiles.TileSource(str(STORE), None, GRID)
    meta = json.loads(source.read(f"{GRID}/.zarray"))
    assert meta["shape"] == [276, 149]
    values = tile(source, GRID, "0.0")
    gaps = np.isnan(values)
    labels = values[~gaps]
    assert gaps.any()
    assert -1 in labels
    assert (labels >= -1).all()
    assert (labels == np.round(labels)).all()
    assert labels.max() > 0


def test_both_variables_are_served_as_separate_mounts():
    mounts = serve.Mounts([str(ROOT)])
    server = ThreadingHTTPServer(("127.0.0.1", 0), serve.make_handler(mounts=mounts))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        def open_var(var=None):
            query = {"path": str(STORE), **({"var": var} if var else {})}
            with urlopen(f"{base}/api/open?{urlencode(query)}") as response:
                return json.loads(response.read())

        sv = open_var()
        labels = open_var(GRID)
        assert labels["var"] == GRID
        mount = labels["instances"][0]["mount"]
        assert mount != sv["instances"][0]["mount"]
        with urlopen(f"{base}/api/describe/{mount}") as response:
            assert json.loads(response.read())["kind"] == "labels"
        with urlopen(f"{base}/mount/{mount}/{GRID}/0.0") as response:
            assert response.status == 200
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
