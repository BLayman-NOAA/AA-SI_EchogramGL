"""Colormap export tests.

The web build imports what this module writes, so the thing worth testing is
that a value lands on the same byte matplotlib puts it on.
"""

import json

import numpy as np
import pytest

from aa_si_echogram_gl import colormaps

pytest.importorskip("matplotlib")


def test_quantization_matches_matplotlib():
    """matplotlib truncates rather than rounds, and the web build copies it."""
    from matplotlib import colormaps as mpl

    values = np.linspace(0.0, 1.0, colormaps.LUT_SIZE)
    expected = mpl["viridis"](values, bytes=True)[:, :3]
    actual = [
        [colormaps.to_byte(c) for c in row]
        for row in mpl["viridis"](values)[:, :3]
    ]
    np.testing.assert_array_equal(np.array(actual, dtype="uint8"), expected)


def test_truncation_differs_from_rounding_somewhere():
    """A test that passes under either rule is not testing the rule."""
    stops = colormaps.definition("viridis")
    truncated = [colormaps.to_byte(c) for row in stops for c in row]
    rounded = [min(round(c * 255), 255) for row in stops for c in row]
    assert truncated != rounded


def test_definition_round_trips_through_json_exactly():
    """The web build multiplies a stop by 255 and truncates, so a stop that
    lost precision on the way out could land on a different byte."""
    from matplotlib import colormaps as mpl

    values = np.linspace(0.0, 1.0, colormaps.LUT_SIZE)
    expected = mpl["jet"](values)[:, :3]
    stops = json.loads(json.dumps(colormaps.definition("jet")))
    np.testing.assert_array_equal(np.array(stops), expected)


def test_export_covers_the_default_names():
    document = colormaps.export()
    assert set(document["continuous"]) == set(colormaps.DEFAULT_NAMES)
    assert document["size"] == colormaps.LUT_SIZE
    assert document["nodataColor"] == "#2E2E2E"
    assert document["noiseColor"] == "#000000"


def test_reference_is_flat_rgba():
    document = colormaps.export_reference(["viridis"])
    values = document["continuous"]["viridis"]
    assert len(values) == colormaps.LUT_SIZE * 4
    assert values[3::4] == [255] * colormaps.LUT_SIZE


def test_cluster_palette_matches_the_figures():
    """Cluster colors come from _create_cluster_colormap, in its order."""
    document = colormaps.export(["viridis"])
    assert document["clusterPalette"][0] == "#00F3FC"
    assert len(document["clusterPalette"]) == 11


def test_write_round_trips(tmp_path):
    path = tmp_path / "colormaps.json"
    colormaps.write(path, colormaps.export(["viridis", "jet"]))
    with open(path, encoding="utf-8") as handle:
        loaded = json.load(handle)
    assert set(loaded["continuous"]) == {"viridis", "jet"}
