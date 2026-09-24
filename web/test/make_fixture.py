"""Regenerate the stores and the reference the web tests read.

Two stores. `fixture-store.zarr` is a plain two level MVBS style store for the
store and level tests. `geometry-store.zarr` carries heave and a per ping sample
interval, the two variations milestone 3 exists to render, alongside a JSON of
depths taken from the dataset itself so the TypeScript side can be checked
against the Python side rather than against its own arithmetic.

Run from the repository root:

    python web/test/make_fixture.py
"""

import json
import pathlib
import shutil

import numpy as np
import zarr

from aa_si_echogram_gl import fixtures, geometry, pyramid

HERE = pathlib.Path(__file__).parent
PLAIN = HERE / "fixture-store.zarr"
SV_DATASET = HERE / "sv-dataset.zarr"
GEOMETRY = HERE / "geometry-store.zarr"
REFERENCE = HERE / "geometry.reference.json"


def write_plain():
    """A small two level store for the store and level tests."""
    replace(PLAIN)
    ds = fixtures.synthetic(
        n_channels=2, n_pings=32, n_samples=24, gridded=True, gps=True
    )
    spec = pyramid.build_pyramid(ds, PLAIN, levels=2)
    print(f"wrote {PLAIN} with {len(spec['datasets'])} levels")


def write_geometry():
    """A store whose vertical geometry varies along both axes, plus a reference.

    Heave moves `range_start` ping to ping and the interval varies too, so a
    reader that treats either as constant produces visibly wrong depths. One
    level only, since reduction across a wobbling grid is refused by design.
    """
    replace(GEOMETRY)
    ds = fixtures.synthetic(
        n_channels=3,
        n_pings=40,
        n_samples=32,
        heave_amplitude=1.5,
        interval_varies_by_ping=True,
        gps=True,
    )
    spec = pyramid.build_pyramid(ds, GEOMETRY, levels=1)
    print(f"wrote {GEOMETRY}, vertical reference {spec['verticalRef']}")

    derived = geometry.derive(ds, "Sv")
    truth = np.asarray(ds[spec["rangeVar"]].values, dtype="float64")
    document = {
        "rangeVar": spec["rangeVar"],
        "verticalRef": spec["verticalRef"],
        "shape": list(truth.shape),
        "affineDeviation": derived["meta"]["affine_deviation"],
        "depths": sample_depths(truth),
    }
    with open(REFERENCE, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=1)
        handle.write("\n")
    print(f"wrote {REFERENCE} with {len(document['depths'])} sampled depths")


def sample_depths(truth):
    """Take depths from the dataset itself, spread across all three axes.

    These come from the vertical coordinate rather than from `range_start` and
    `range_step`, so agreeing with them is a check of the affine model and not
    of one formula against itself.
    """
    n_channels, n_pings, n_samples = truth.shape
    points = []
    for channel in range(n_channels):
        for ping in range(0, n_pings, 7):
            for sample in (0, 1, n_samples // 2, n_samples - 1):
                points.append(
                    {
                        "channel": channel,
                        "ping": ping,
                        "sample": sample,
                        "depth": float(truth[channel, ping, sample]),
                    }
                )
    return points


def replace(path):
    """Remove a store so it is rewritten rather than merged into."""
    if path.exists():
        shutil.rmtree(path)


def write_sv_dataset():
    """An Sv dataset with no pyramid, as a processing pipeline leaves one.

    Deliberately awkward in the two ways the real ones are. It is zarr v2, so
    the dimension names are in `_ARRAY_DIMENSIONS` rather than in the array
    metadata. And `depth` is dimensioned (ping_time, channel, range_sample)
    while `Sv` is (channel, ping_time, range_sample), which is what an HB2407
    checkpoint actually holds: reading either by position rather than by name
    gives the vertical of the wrong ping for every sample drawn.
    """
    replace(SV_DATASET)
    n_channels, n_pings, n_samples = 3, 40, 16
    root = zarr.open_group(str(SV_DATASET), mode="w", zarr_format=2)

    # A ramp per channel, so the derived step differs between them the way a
    # real transducer set does.
    steps = np.array([0.188037, 0.179083, 0.191022])[:, None, None]
    start = 6.42
    depth = start + steps * np.arange(n_samples)[None, None, :]
    depth = np.broadcast_to(depth, (n_channels, n_pings, n_samples)).copy()

    rng = np.random.default_rng(11)
    sv = rng.uniform(-90.0, -40.0, size=(n_channels, n_pings, n_samples))
    # A masked wedge, so the NaN to sentinel conversion has something to do.
    sv[:, :, -3:] = np.nan
    sv[0, :5, :] = np.nan

    _write(root, "Sv", sv, ["channel", "ping_time", "range_sample"])
    # Transposed on purpose. See the docstring.
    _write(root, "depth", depth.transpose(1, 0, 2),
           ["ping_time", "channel", "range_sample"])
    _write(root, "echo_range", depth, ["channel", "ping_time", "range_sample"])
    _write(root, "ping_time",
           np.arange(n_pings, dtype="int64") * 1_000_000_000 + 1_727_206_854_000_000_000,
           ["ping_time"])
    _write(root, "frequency_nominal",
           np.array([18000.0, 70000.0, 200000.0]), ["channel"])
    _write(root, "range_sample", np.arange(n_samples, dtype="int64"), ["range_sample"])
    zarr.consolidate_metadata(root.store)


def _write(root, name, values, dimensions):
    """Write one array with the dimension names xarray records in zarr v2."""
    array = root.create_array(
        name=name, shape=values.shape, dtype=values.dtype, chunks=values.shape
    )
    array[...] = values
    array.attrs["_ARRAY_DIMENSIONS"] = dimensions


def main():
    write_plain()
    write_geometry()
    write_sv_dataset()


if __name__ == "__main__":
    main()
