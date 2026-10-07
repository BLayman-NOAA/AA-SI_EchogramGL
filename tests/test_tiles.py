"""Serving a checkpointed dataset under the viewer's chunking."""

import json

import numcodecs
import numpy as np
import pytest
from test_catalog import write_zarr

from aa_si_echogram_gl import fixtures, tiles


@pytest.fixture
def stored(tmp_path):
    """Sv as compute_sv checkpoints it: every channel, ping and sample in one chunk."""
    ds = fixtures.synthetic(n_channels=3, n_pings=2500, n_samples=1300, gps=False)
    ds["Sv"].encoding = {"chunks": ds["Sv"].shape}
    path = tmp_path / "sv.zarr"
    write_zarr(ds, path, consolidated=True)
    return ds, str(path)


def chunk(source, key):
    meta = json.loads(source.read("Sv/.zarray"))
    raw = numcodecs.Zstd().decode(source.read(key))
    return np.frombuffer(raw, dtype="<f4").reshape(meta["chunks"])


def test_the_variable_is_served_one_channel_a_tile(stored):
    _, path = stored
    source = tiles.TileSource(path)
    meta = json.loads(source.read("Sv/.zarray"))
    assert meta["chunks"] == [1, 2048, 1024]
    assert meta["shape"] == [3, 2500, 1300]
    assert meta["compressor"]["id"] == "zstd"
    assert json.loads(source.read("Sv/.zattrs"))["_ARRAY_DIMENSIONS"] == [
        "channel",
        "ping_time",
        "range_sample",
    ]


@pytest.mark.parametrize("whole", [False, True])
def test_a_chunk_holds_the_values_it_names(stored, monkeypatch, whole):
    ds, path = stored
    monkeypatch.setattr(tiles, "LOAD_THRESHOLD", 0 if whole else 2**40)
    monkeypatch.setattr(tiles, "LOADED", tiles.Loaded())
    source = tiles.TileSource(path)
    assert source.whole == whole
    found = chunk(source, "Sv/2.1.1")
    expected = ds["Sv"].values[2, 2048:2500, 1024:1300].astype("<f4")
    assert np.array_equal(found[0, :452, :276], expected, equal_nan=True)
    # The edge is padded to the full chunk, as zarr v2 stores it.
    assert np.isnan(found[0, 452:, :]).all()
    assert np.isnan(found[0, :, 276:]).all()


def test_keys_outside_the_variable_are_absent(stored):
    _, path = stored
    source = tiles.TileSource(path)
    assert source.read("depth/.zarray") is None
    assert source.read("Sv/9.0.0") is None
    assert source.read("Sv/not.a.chunk") is None
    assert json.loads(source.read(".zgroup")) == {"zarr_format": 2}


def test_a_loaded_variable_is_held_once_within_the_budget():
    held = tiles.Loaded(budget=100)
    loads = []

    def load(n):
        def run():
            loads.append(n)
            return np.zeros(n, dtype="u1")
        return run

    held.get("a", load(60))
    held.get("a", load(60))
    held.get("b", load(60))
    assert loads == [60, 60]
    assert list(held.held) == ["b"]
