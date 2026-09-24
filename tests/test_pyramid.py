"""Builder tests: round trip, aggregation space, nodata, and alignment."""

import json

import numpy as np
import pytest
import zarr

from aa_si_echogram_gl import contract, fixtures, pyramid


def test_round_trip_validates(tmp_path):
    ds = fixtures.synthetic()
    pyramid.build_pyramid(ds, tmp_path / "store.zarr")
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_round_trip_gridded_validates(tmp_path):
    ds = fixtures.synthetic(gridded=True)
    pyramid.build_pyramid(ds, tmp_path / "store.zarr")
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_round_trip_feature_dimension_validates(tmp_path):
    ds = fixtures.feature_dataset()
    spec = pyramid.build_pyramid(ds, tmp_path / "store.zarr")

    assert spec["channelDim"] == "feature"
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_value_stored_as_float16_unsharded(tmp_path):
    ds = fixtures.synthetic()
    pyramid.build_pyramid(ds, tmp_path / "store.zarr")

    array = zarr.open_group(str(tmp_path / "store.zarr"), mode="r")["0"]["Sv"]
    assert array.dtype.name == "float16"
    assert getattr(array, "shards", None) is None


def test_aggregation_is_linear_not_db():
    """Averaging in dB is not the average of the backscatter. This fixture is
    built so the two answers differ substantially; a test that passes under both
    is not testing anything."""
    values = np.array([[[-80.0], [-60.0]]], dtype="float32")

    reduced = pyramid._reduce_pings(values, 2, "linear_mean")

    linear_expected = 10 * np.log10((10 ** -8.0 + 10 ** -6.0) / 2)
    db_mean = -70.0
    assert reduced[0, 0, 0] == pytest.approx(linear_expected, abs=1e-4)
    assert abs(reduced[0, 0, 0] - db_mean) > 5.0


def test_aggregation_excludes_nodata():
    """A partly masked cell averages only the valid contributors."""
    values = np.array([[[-80.0], [contract.NODATA]]], dtype="float32")
    reduced = pyramid._reduce_pings(values, 2, "linear_mean")
    assert reduced[0, 0, 0] == pytest.approx(-80.0, abs=1e-3)


def test_fully_masked_cell_stays_nodata():
    values = np.full((1, 2, 1), contract.NODATA, dtype="float32")
    reduced = pyramid._reduce_pings(values, 2, "linear_mean")
    assert reduced[0, 0, 0] <= contract.NODATA_THRESHOLD


def test_max_aggregation():
    values = np.array([[[-80.0], [-60.0]]], dtype="float32")
    reduced = pyramid._reduce_pings(values, 2, "max")
    assert reduced[0, 0, 0] == pytest.approx(-60.0, abs=1e-3)


def test_heave_refuses_reduction(tmp_path):
    """Reduction averages sample index i across pings. When range_start varies,
    that averages different depths. At Sv resolution a metre of heave is tens of
    samples, so this must be refused rather than smeared."""
    ds = fixtures.synthetic(heave_amplitude=1.0, base_interval=6.4e-5)

    with pytest.raises(pyramid.AlignmentError, match="different depths"):
        pyramid.build_pyramid(ds, tmp_path / "store.zarr", levels=3)


def test_heave_message_suggests_binning_by_depth(tmp_path):
    ds = fixtures.synthetic(heave_amplitude=1.0)
    with pytest.raises(pyramid.AlignmentError, match="compute_mvbs"):
        pyramid.build_pyramid(ds, tmp_path / "store.zarr", levels=2)


def test_regularized_input_reduces_cleanly(tmp_path):
    """`compute_mvbs` assigns samples to bins by value rather than by sample
    index, so data binned by depth arrives already regular and passes."""
    ds = fixtures.synthetic(gridded=True, heave_amplitude=1.0)
    spec = pyramid.build_pyramid(ds, tmp_path / "store.zarr", levels=3)

    assert [entry["factors"]["ping"] for entry in spec["datasets"]] == [1, 2, 4]
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_heave_level_zero_is_unaffected(tmp_path):
    """Level zero performs no reduction, so a wobbling grid is fine there."""
    ds = fixtures.synthetic(heave_amplitude=1.0)
    pyramid.build_pyramid(ds, tmp_path / "store.zarr", levels=1)
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_vertical_reference_recorded(tmp_path):
    ds = fixtures.synthetic()
    spec = pyramid.build_pyramid(ds, tmp_path / "store.zarr")
    assert spec["verticalRef"] == "depth"
    assert spec["rangeVar"] == "depth"

    ds_range = ds.drop_vars("depth")
    spec_range = pyramid.build_pyramid(ds_range, tmp_path / "range.zarr")
    assert spec_range["verticalRef"] == "range"


def test_bins_axis_only_offered_for_gridded(tmp_path):
    gridded = pyramid.build_pyramid(
        fixtures.synthetic(gridded=True), tmp_path / "a.zarr"
    )
    raw = pyramid.build_pyramid(fixtures.synthetic(), tmp_path / "b.zarr")

    assert "bins" in gridded["validXAxes"]
    assert "bins" not in raw["validXAxes"]


def test_meters_axis_requires_gps(tmp_path):
    with_gps = pyramid.build_pyramid(
        fixtures.synthetic(gps=True), tmp_path / "a.zarr"
    )
    without = pyramid.build_pyramid(
        fixtures.synthetic(gps=False), tmp_path / "b.zarr"
    )

    assert "meters" in with_gps["validXAxes"]
    assert "meters" not in without["validXAxes"]


def test_bin_mapping_written_when_original_supplied(tmp_path):
    """Bins must actually span the original pings, or this asserts clamping
    rather than mapping."""
    original_times = fixtures.synthetic(n_pings=64)["ping_time"].values
    binned = fixtures.synthetic(gridded=True, n_pings=16).assign_coords(
        ping_time=original_times[::4]
    )

    pyramid.build_pyramid(
        binned, tmp_path / "store.zarr", original_ping_times=original_times
    )

    group = zarr.open_group(str(tmp_path / "store.zarr"), mode="r")["0"]
    start = group["bin_ping_start"][:]
    end = group["bin_ping_end"][:]

    assert start[0] == 0
    assert end[-1] == 63
    np.testing.assert_array_equal(start[1:], end[:-1] + 1)
    assert int((end - start + 1).sum()) == 64


def test_extra_dimension_refused_clearly(tmp_path):
    """The contract permits a frequency axis; the builder does not write one
    yet, and should say so rather than fail cryptically."""
    ds = fixtures.synthetic(n_channels=2, n_pings=8, n_samples=6)
    ds = ds.expand_dims({"frequency": 3})

    with pytest.raises(Exception, match="does not write them yet"):
        pyramid.build_pyramid(ds, tmp_path / "store.zarr")


def test_auxiliary_arrays_round_trip(tmp_path):
    """The slot exists for a decomposition basis, whose axes are component and
    frequency rather than ping and sample. Exercised before anything needs it."""
    basis = np.arange(12, dtype="float32").reshape(3, 4)
    spec = pyramid.build_pyramid(
        fixtures.synthetic(),
        tmp_path / "store.zarr",
        auxiliary={"fpca_basis": (("component", "frequency"), basis)},
    )

    assert spec["auxiliary"]["fpca_basis"]["dims"] == ["component", "frequency"]
    root = zarr.open_group(str(tmp_path / "store.zarr"), mode="r")
    np.testing.assert_array_equal(root["aux"]["fpca_basis"][:], basis)
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_summaries_written(tmp_path):
    ds = fixtures.synthetic()
    pyramid.build_pyramid(ds, tmp_path / "store.zarr")

    with open(tmp_path / "store.zarr" / "summaries.json", encoding="utf-8") as fh:
        data = json.load(fh)

    assert "0" in data
    assert data["0"]


def test_nodata_sentinel_survives_float16(tmp_path):
    """The sentinel is not exactly representable in float16, which is why
    comparisons use a threshold rather than equality."""
    ds = fixtures.synthetic()
    pyramid.build_pyramid(ds, tmp_path / "store.zarr")

    values = zarr.open_group(str(tmp_path / "store.zarr"), mode="r")["0"]["Sv"][:]
    masked = values[:, :, -1]
    assert (masked <= contract.NODATA_THRESHOLD).all()


def test_consolidated_metadata_written(tmp_path):
    """A client otherwise reads one metadata document per array. Consolidation
    is additive, so a reader ignoring it still opens the store."""
    pyramid.build_pyramid(fixtures.synthetic(), tmp_path / "store.zarr", levels=1)

    root = zarr.open_group(str(tmp_path / "store.zarr"), mode="r")
    assert root.metadata.consolidated_metadata is not None
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_unconsolidated_store_still_valid(tmp_path):
    pyramid.build_pyramid(
        fixtures.synthetic(), tmp_path / "store.zarr", consolidate=False
    )
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_odd_ping_count_is_padded_not_trimmed(tmp_path):
    """Trimming would leave coarse levels covering less than level zero, which
    shows at overview zoom as missing data at the right hand edge."""
    ds = fixtures.synthetic(gridded=True, n_pings=81)
    spec = pyramid.build_pyramid(ds, tmp_path / "store.zarr", levels=4)

    root = zarr.open_group(str(tmp_path / "store.zarr"), mode="r")
    counts = [root[entry["path"]]["Sv"].shape[1] for entry in spec["datasets"]]

    assert counts == [81, 41, 21, 11]
    for count, entry in zip(counts, spec["datasets"], strict=True):
        assert count * entry["factors"]["ping"] >= 81
    assert contract.validate_store(tmp_path / "store.zarr") == []


def test_coarse_levels_span_the_same_time_extent(tmp_path):
    ds = fixtures.synthetic(gridded=True, n_pings=81)
    spec = pyramid.build_pyramid(ds, tmp_path / "store.zarr", levels=4)

    root = zarr.open_group(str(tmp_path / "store.zarr"), mode="r")
    finest = root["0"]["ping_time"][:]
    for entry in spec["datasets"][1:]:
        coarse = root[entry["path"]]["ping_time"][:]
        assert coarse[-1] >= finest[-1] - (finest[-1] - finest[0]) / len(finest)


def test_padded_cell_averages_only_real_contributors():
    """A partial coarse cell has fewer contributors, not padded ones pulling it
    toward the sentinel."""
    values = np.array([[[-80.0], [-80.0], [-60.0]]], dtype="float32")
    reduced = pyramid._reduce_pings(values, 2, "linear_mean")

    assert reduced.shape[1] == 2
    assert reduced[0, 1, 0] == pytest.approx(-60.0, abs=1e-3)


def test_level_factors_record_the_ping_axis_only(tmp_path):
    """The client computes chunk keys and slot alignment from these, so they are
    a contract rather than a note."""
    ds = fixtures.synthetic(gridded=True, n_pings=64)
    spec = pyramid.build_pyramid(ds, tmp_path / "store.zarr", levels=4)

    assert [e["path"] for e in spec["datasets"]] == ["0", "1", "2", "3"]
    assert [e["factors"]["ping"] for e in spec["datasets"]] == [1, 2, 4, 8]
    assert {e["factors"]["sample"] for e in spec["datasets"]} == {1}


def test_each_level_carries_its_own_aggregated_geometry(tmp_path):
    """A coarse level positions its own pings, so its sidecar has to describe
    the merged cell rather than repeat the first ping of it."""
    # The sample interval changes along the ping axis, which is the only case
    # where a copied step and an aggregated one are different numbers. The
    # transducer stays put, so ping axis reduction is still permitted.
    ds = fixtures.synthetic(n_pings=64, interval_varies_by_ping=True)
    spec = pyramid.build_pyramid(ds, tmp_path / "store.zarr", levels=3)

    root = zarr.open_group(str(tmp_path / "store.zarr"), mode="r")
    fine = root["0"]["range_step"][:]
    assert fine[0].std() > 0, "the fixture has to vary for this to test anything"

    for entry in spec["datasets"][1:]:
        factor = entry["factors"]["ping"]
        coarse = root[entry["path"]]["range_step"][:]
        assert coarse.shape[1] == root[entry["path"]]["Sv"].shape[1]

        merged = fine[:, :factor].mean(axis=1)
        assert coarse[:, 0] == pytest.approx(merged, rel=1e-6)
        assert coarse[:, 0] != pytest.approx(fine[:, 0], rel=1e-9)


def test_channel_names_are_carried_when_the_dataset_has_them(tmp_path):
    """A tinted stack is chosen between by frequency, so the store has to say
    which channel is which. Names alone is what a plain Sv dataset offers."""
    ds = fixtures.synthetic(n_channels=3)
    spec = pyramid.build_pyramid(ds, tmp_path / "store", levels=1)

    assert spec["channelNames"] == ["chan0", "chan1", "chan2"]
    assert "channelFrequencies" not in spec


def test_channel_frequencies_are_carried_when_the_dataset_has_them(tmp_path):
    ds = fixtures.synthetic(n_channels=3)
    ds = ds.assign(frequency_nominal=("channel", [18000.0, 38000.0, 120000.0]))
    spec = pyramid.build_pyramid(ds, tmp_path / "store", levels=1)

    assert spec["channelFrequencies"] == [18000.0, 38000.0, 120000.0]


def test_a_store_without_channel_names_omits_the_field(tmp_path):
    """Optional, and absent rather than empty: a viewer that finds neither
    falls back to the channel index, and older stores stay valid."""
    ds = fixtures.synthetic(n_channels=2)
    ds = ds.assign_coords(channel=[0, 1])
    spec = pyramid.build_pyramid(ds, tmp_path / "store", levels=1)

    assert "channelNames" not in spec
    assert not contract.validate_store(tmp_path / "store")


def test_summaries_follow_the_store_to_a_url():
    """A store written through fsspec keeps its sidecar beside it.

    memory:// rather than gs://, because it is the same FsspecStore path and it
    needs no credentials. The failure this guards against is quiet: a local
    open() on a URL writes a directory named after the bucket into the working
    directory, and the published store has no summaries.

    Not file://. zarr resolves that one to a LocalStore over a mangled relative
    path rather than through fsspec, so the levels and the sidecar would land in
    different places and the test would be about that instead.
    """
    import fsspec

    ds = fixtures.synthetic(n_channels=1, n_pings=8, n_samples=8)
    url = "memory://summary-store"
    pyramid.build_pyramid(ds, url, levels=1)

    fs, root = fsspec.core.url_to_fs(url)
    beside = f"{root.rstrip('/')}/summaries.json"
    assert fs.exists(beside)
    assert "0" in json.loads(fs.cat_file(beside).decode("utf-8"))
    # And the levels went to the same place, which is the point of the sidecar
    # being written the same way.
    assert not contract.validate_store(url)
