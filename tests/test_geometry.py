"""Geometry derivation tests.

Every behavior checked here is one `AA-SI_Visualization` already handles and one
that real data breaks if missed.
"""

import numpy as np
import pytest
import xarray as xr

from aa_si_echogram_gl import fixtures, geometry

SOUND_SPEED = 1500.0


def test_resolve_range_var_prefers_depth():
    ds = fixtures.synthetic()
    assert geometry.resolve_range_var(ds) == "depth"


def test_resolve_range_var_falls_back_to_echo_range():
    ds = fixtures.synthetic().drop_vars("depth")
    assert geometry.resolve_range_var(ds) == "echo_range"


def test_resolve_range_var_raises_when_absent():
    ds = fixtures.synthetic().drop_vars("depth").drop_vars("echo_range")
    with pytest.raises(geometry.GeometryError, match="neither"):
        geometry.resolve_range_var(ds)


def test_channel_dim_discovered_not_assumed():
    ds = fixtures.feature_dataset()
    dim = geometry.find_channel_dim(ds, "Sv", "depth", "ping_time")
    assert dim == "feature"


def test_range_step_is_per_channel():
    """HB2407 records different sample intervals per transducer, so vertical
    geometry cannot be one array shared across channels."""
    ds = fixtures.synthetic(n_channels=3, base_interval=6.4e-5)
    _, step, deviation = geometry.vertical_geometry(
        ds, "echo_range", "channel", "ping_time"
    )

    assert step.shape == (3, ds.sizes["ping_time"])
    expected = np.array([6.4e-5 * (2 ** c) * SOUND_SPEED / 2 for c in range(3)])
    np.testing.assert_allclose(step[:, 0], expected, rtol=1e-5)
    assert deviation < geometry.AFFINE_TOLERANCE


def test_range_start_carries_heave():
    """Transducer depth moves with heave, so sample zero sits at a different
    depth in each ping even at a constant sample interval."""
    ds = fixtures.synthetic(heave_amplitude=1.0, transducer_draft=5.0)
    start, _, _ = geometry.vertical_geometry(ds, "depth", "channel", "ping_time")

    assert start[0].std() > 0.1
    np.testing.assert_allclose(
        start[0], ds["transducer_depth"].values[0], rtol=1e-4
    )


def test_range_start_flat_without_heave():
    ds = fixtures.synthetic(heave_amplitude=0.0, transducer_draft=5.0)
    start, _, _ = geometry.vertical_geometry(ds, "depth", "channel", "ping_time")
    np.testing.assert_allclose(start[0], 5.0, rtol=1e-5)


def test_non_affine_range_is_refused():
    """The design assumes range is affine in sample index. If it ever is not,
    the sidecar cannot express it and that must be loud."""
    ds = fixtures.synthetic(n_channels=1, n_pings=4, n_samples=8)
    warped = ds["echo_range"].values.copy()
    warped[:, :, 4:] *= 2.0
    ds = ds.assign_coords(
        echo_range=(("channel", "ping_time", "range_sample"), warped)
    )

    with pytest.raises(geometry.GeometryError, match="not affine"):
        geometry.vertical_geometry(ds, "echo_range", "channel", "ping_time")


def test_transducer_depth_stored_separately():
    """Kept out of range_start so the vertical reference stays switchable."""
    ds = fixtures.synthetic(heave_amplitude=1.5)
    derived = geometry.derive(ds, "Sv")
    arrays = derived["arrays"]

    depth_start = arrays["range_start"]
    range_start = depth_start - arrays["transducer_depth"]
    np.testing.assert_allclose(range_start, 0.0, atol=1e-4)
    assert derived["meta"]["vertical_ref"] == "depth"


def test_vertical_geometry_ignores_dimension_order():
    """Real datasets carry echo_range and depth in whatever order the steps
    that made them left behind, and the two need not agree."""
    ds = fixtures.synthetic(heave_amplitude=1.0, transducer_draft=5.0)
    rolled = ds.assign(
        depth=ds["depth"].transpose("ping_time", "channel", "range_sample")
    )

    expected, _, _ = geometry.vertical_geometry(ds, "depth", "channel", "ping_time")
    start, _, _ = geometry.vertical_geometry(rolled, "depth", "channel", "ping_time")

    np.testing.assert_allclose(start, expected)


def test_transducer_depth_survives_a_range_referenced_store():
    """Heave makes depth irregular along the ping axis, so a store built for
    reduction is built on echo_range. The surface reference has to come with
    it, or the viewer can only ever draw range."""
    ds = fixtures.synthetic(heave_amplitude=1.5, transducer_draft=5.0)
    derived = geometry.derive(ds, "Sv", range_var="echo_range")
    arrays = derived["arrays"]

    assert derived["meta"]["vertical_ref"] == "range"
    np.testing.assert_allclose(arrays["range_start"], 0.0, atol=1e-4)
    assert arrays["transducer_depth"].std() > 0.1
    np.testing.assert_allclose(
        arrays["transducer_depth"][0], ds["transducer_depth"].values[0], rtol=1e-4
    )


def test_gps_matched_by_nearest_time_not_index():
    """Platform lat and lon are dimensioned by NMEA datagram time, so they are
    matched by time rather than by position."""
    ds = fixtures.synthetic(n_pings=32)
    platform = fixtures.platform_with_gaps(ds, invalid_fraction=0.0,
                                           offset_seconds=0.4)
    lat, _ = geometry.positions(ds, "ping_time", platform)

    np.testing.assert_allclose(lat, ds["latitude"].values, rtol=1e-9)


def test_invalid_gps_fixes_are_filtered():
    ds = fixtures.synthetic(n_pings=32)
    platform = fixtures.platform_with_gaps(ds, invalid_fraction=0.3)
    lat, lon = geometry.positions(ds, "ping_time", platform)

    assert lat is not None
    assert np.isfinite(lat).all()
    assert np.isfinite(lon).all()


def test_all_invalid_gps_returns_none():
    ds = fixtures.synthetic(n_pings=8)
    platform = xr.Dataset(
        {
            "latitude": ("time1", np.full(8, np.nan)),
            "longitude": ("time1", np.full(8, np.nan)),
        },
        coords={"time1": ds["ping_time"].values},
    )
    assert geometry.positions(ds, "ping_time", platform) == (None, None)


def test_distance_diverges_from_average_speed():
    """`_calculate_speed_from_gps` uses one average speed for the whole window.
    The sidecar accumulates true distance, so the two agree only at constant
    speed. This asserts the divergence rather than tolerating it."""
    ds = fixtures.synthetic(n_pings=64, speed_change=True)
    derived = geometry.derive(ds, "Sv")
    distance = derived["arrays"]["x_distance"]

    total = distance[-1]
    average_speed_model = np.linspace(0.0, total, distance.size)
    worst = np.max(np.abs(distance - average_speed_model))

    assert worst > 0.02 * total


def test_distance_matches_average_speed_at_constant_speed():
    ds = fixtures.synthetic(n_pings=64, speed_change=False)
    distance = geometry.derive(ds, "Sv")["arrays"]["x_distance"]
    straight = np.linspace(0.0, distance[-1], distance.size)
    np.testing.assert_allclose(distance, straight, rtol=1e-6)


def test_bin_ping_bounds_cover_original_pings():
    """A selection on binned data has to resolve to original ping indices."""
    original = np.datetime64("2024-06-01") + np.arange(40) * np.timedelta64(1, "s")
    bins = original[::4]

    start, end = geometry.bin_ping_bounds(bins, original)

    assert start[0] == 0
    assert end[-1] == 39
    assert (end >= start).all()
    np.testing.assert_array_equal(start[1:], end[:-1] + 1)


def test_gridded_detection():
    assert geometry.is_gridded(fixtures.synthetic(gridded=True), "depth")
    assert not geometry.is_gridded(fixtures.synthetic(gridded=False), "depth")


def test_single_gps_fix_does_not_wrap():
    """A one entry platform group must not index past the end of the array."""
    ds = fixtures.synthetic(n_pings=8)
    platform = xr.Dataset(
        {"latitude": ("time1", [44.0]), "longitude": ("time1", [-68.0])},
        coords={"time1": ds["ping_time"].values[:1]},
    )

    lat, lon = geometry.positions(ds, "ping_time", platform)

    assert lat.shape == (8,)
    np.testing.assert_allclose(lat, 44.0)
    np.testing.assert_allclose(lon, -68.0)


def test_single_sample_refused():
    ds = fixtures.synthetic(n_pings=4, n_samples=1, nodata=False)
    with pytest.raises(geometry.GeometryError, match="at least two"):
        geometry.vertical_geometry(ds, "echo_range", "channel", "ping_time")


def test_extra_dimension_named_in_error():
    ds = fixtures.synthetic(n_pings=4, n_samples=6).expand_dims({"frequency": 2})
    with pytest.raises(geometry.GeometryError, match="frequency"):
        geometry.find_channel_dim(ds, "Sv", "depth", "ping_time")


def test_bin_bounds_do_not_overflow_far_future():
    """Midpoints are an offset from the left edge, not a sum, which would
    overflow int64 nanoseconds past roughly the year 2262."""
    late = np.datetime64("2261-01-01") + np.arange(8) * np.timedelta64(1, "D")
    start, end = geometry.bin_ping_bounds(late[::2], late)

    assert start[0] == 0
    assert end[-1] == 7
    assert (end >= start).all()


@pytest.mark.parametrize("ndim", [1, 2, 3])
def test_vertical_geometry_is_measured_without_expanding_the_coordinate(ndim):
    """A gridded coordinate is one row for the whole survey. It is measured as
    stored, and the result has to equal what the full expansion gives."""
    n_channels, n_pings, n_samples = 3, 40, 25
    row = 8.9 + 2.0 * np.arange(n_samples)
    row[:3] = np.nan                      # leading NaNs are extrapolated past
    full = np.broadcast_to(row, (n_channels, n_pings, n_samples)).copy()
    dims = ("channel", "ping_time", "depth")
    coordinate = {1: (dims[2:], row), 2: (dims[1:], full[0]), 3: (dims, full)}[ndim]
    ds = xr.Dataset(
        {"Sv": (dims, np.zeros(full.shape)), "z": coordinate},
        coords={"channel": [f"c{i}" for i in range(n_channels)],
                "ping_time": np.arange(n_pings), "depth": np.arange(n_samples)},
    )
    expanded = ds.assign(z=(dims, full))

    start, step, deviation = geometry.vertical_geometry(ds, "z", "channel", "ping_time")
    want_start, want_step, want_dev = geometry.vertical_geometry(
        expanded, "z", "channel", "ping_time"
    )

    assert start.shape == step.shape == (n_channels, n_pings)
    assert start.dtype == step.dtype == np.float32
    np.testing.assert_array_equal(start, want_start)
    np.testing.assert_array_equal(step, want_step)
    assert deviation == want_dev
    np.testing.assert_allclose(start, 8.9, rtol=1e-6)
    np.testing.assert_allclose(step, 2.0, rtol=1e-6)
    start[0, 0] = 0.0                     # a real array, not a read-only view
