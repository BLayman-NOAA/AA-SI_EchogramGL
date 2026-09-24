"""Contract validation tests.

`validate_store` is the executable form of the contract, so these check that it
actually catches the violations later milestones will rely on it catching.
"""

import numpy as np
import zarr

from aa_si_echogram_gl import contract, fixtures, pyramid


def _minimal_store(path, axes=None, factors=None, n_channels=2, n_pings=8,
                   n_samples=4, dtype="float16", value_shape=None):
    """Hand write a store so violations can be constructed deliberately."""
    root = zarr.open_group(str(path), mode="w")
    group = root.create_group("0")

    shape = value_shape or (n_channels, n_pings, n_samples)
    array = group.create_array(name="Sv", shape=shape, dtype=dtype, chunks=shape)
    array[:] = np.zeros(shape, dtype=dtype)

    for name in ("range_start", "range_step"):
        sidecar = group.create_array(
            name=name, shape=(n_channels, n_pings), dtype="float32",
            chunks=(n_channels, n_pings),
        )
        sidecar[:] = np.ones((n_channels, n_pings), dtype="float32")

    times = group.create_array(
        name="ping_time", shape=(n_pings,), dtype="int64", chunks=(n_pings,)
    )
    times[:] = np.arange(n_pings, dtype="int64")

    root.attrs["multiscales"] = [{
        "name": "Sv",
        "axes": axes or [
            {"name": "channel", "type": "channel", "indexable": True},
            {"name": "ping", "type": "time"},
            {"name": "sample", "type": "space", "unit": "meter"},
        ],
        "datasets": [{"path": "0", "factors": factors or {"ping": 1, "sample": 1}}],
        "aggregation": "linear_mean",
        "nodata": contract.NODATA,
        "dataType": "Sv",
        "channelDim": "channel",
        "verticalRef": "range",
    }]
    return path


def test_clean_store_has_no_problems(tmp_path):
    _minimal_store(tmp_path / "store.zarr")
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_missing_multiscales_detected(tmp_path):
    zarr.open_group(str(tmp_path / "store.zarr"), mode="w")
    problems = contract.validate_store(tmp_path / "store.zarr")
    assert [p.code for p in problems] == ["no_multiscales"]


def test_unreadable_store_detected(tmp_path):
    problems = contract.validate_store(tmp_path / "absent.zarr")
    assert problems[0].code == "unreadable"


def test_wrong_dtype_detected(tmp_path):
    _minimal_store(tmp_path / "store.zarr", dtype="float32")
    problems = contract.validate_store(tmp_path / "store.zarr")
    assert any(p.code == "bad_dtype" for p in problems)


def test_missing_sidecar_detected(tmp_path):
    _minimal_store(tmp_path / "store.zarr")
    group = zarr.open_group(str(tmp_path / "store.zarr"), mode="a")["0"]
    del group["range_step"]

    problems = contract.validate_store(tmp_path / "store.zarr")
    assert any(p.code == "missing_sidecar" for p in problems)


def test_sidecar_shape_checked(tmp_path):
    """range_start is per channel and ping, because transducers can record at
    different sample intervals and sit at different depths."""
    path = tmp_path / "store.zarr"
    _minimal_store(path)
    group = zarr.open_group(str(path), mode="a")["0"]
    del group["range_start"]
    wrong = group.create_array(
        name="range_start", shape=(8,), dtype="float32", chunks=(8,)
    )
    wrong[:] = np.ones(8, dtype="float32")

    problems = contract.validate_store(path)
    assert any(p.code == "bad_sidecar_shape" for p in problems)


def test_missing_factor_detected(tmp_path):
    _minimal_store(tmp_path / "store.zarr", factors={"ping": 1})
    problems = contract.validate_store(tmp_path / "store.zarr")
    assert any(p.code == "missing_factor" for p in problems)


def test_bad_vertical_ref_detected(tmp_path):
    path = _minimal_store(tmp_path / "store.zarr")
    root = zarr.open_group(str(path), mode="a")
    spec = root.attrs["multiscales"]
    spec[0]["verticalRef"] = "sideways"
    root.attrs["multiscales"] = spec

    problems = contract.validate_store(path)
    assert any(p.code == "bad_vertical_ref" for p in problems)


def test_contract_accepts_a_frequency_axis(tmp_path):
    """A contract that has never seen a third axis is not actually open. This
    validates a store with a frequency axis even though nothing renders one."""
    axes = [
        {"name": "channel", "type": "channel", "indexable": True},
        {"name": "ping", "type": "time"},
        {"name": "sample", "type": "space", "unit": "meter"},
        {"name": "frequency", "type": "frequency", "indexable": True,
         "unit": "Hz"},
    ]
    factors = {"ping": 1, "sample": 1, "frequency": 1}
    _minimal_store(
        tmp_path / "store.zarr",
        axes=axes,
        factors=factors,
        value_shape=(2, 8, 4, 3),
    )

    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_frequency_axis_missing_factor_detected(tmp_path):
    axes = [
        {"name": "ping", "type": "time"},
        {"name": "sample", "type": "space", "unit": "meter"},
        {"name": "frequency", "type": "frequency", "indexable": True},
    ]
    _minimal_store(
        tmp_path / "store.zarr",
        axes=axes,
        factors={"ping": 1, "sample": 1},
        value_shape=(2, 8, 4, 3),
    )

    problems = contract.validate_store(tmp_path / "store.zarr")
    assert any(p.code == "missing_factor" for p in problems)


def test_built_store_passes_every_check(tmp_path):
    pyramid.build_pyramid(fixtures.synthetic(), tmp_path / "store.zarr")
    assert contract.validate_store(tmp_path / "store.zarr") == []
