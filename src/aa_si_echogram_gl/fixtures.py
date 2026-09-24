"""Synthetic datasets with known geometry.

Real survey data tells you whether the model is right. These tell you whether
the code is right, because every value is asserted rather than eyeballed.
"""

import numpy as np
import xarray as xr

SOUND_SPEED = 1500.0


def synthetic(n_channels=2, n_pings=64, n_samples=48, base_interval=6.4e-5,
              interval_per_channel=None, interval_varies_by_ping=False,
              heave_amplitude=0.0, transducer_draft=5.0, nodata=True,
              gridded=False, gps=True, speed_change=False, start="2024-06-01"):
    """Build a dataset whose geometry is known exactly.

    Args:
        n_channels: Number of channels.
        n_pings: Number of pings.
        n_samples: Samples per ping.
        base_interval: Sample interval in seconds for channel zero.
        interval_per_channel: Per channel sample intervals, or None to derive
            them by doubling base_interval for each channel.
        interval_varies_by_ping: Vary the sample interval along the ping axis,
            the case no known survey exhibits.
        heave_amplitude: Peak transducer depth excursion in meters.
        transducer_draft: Static transducer depth in meters.
        nodata: Insert a masked wedge and one fully masked ping.
        gridded: Emit a one dimensional vertical coordinate, as MVBS does.
        gps: Include latitude and longitude.
        speed_change: Halve the vessel speed halfway through.
        start: Start timestamp.

    Returns:
        xarray.Dataset: With Sv, a vertical coordinate and optional platform
            variables.
    """
    ping_time = np.datetime64(start) + np.arange(n_pings) * np.timedelta64(1, "s")

    if interval_per_channel is None:
        interval_per_channel = [base_interval * (2 ** c) for c in range(n_channels)]
    steps = np.array(interval_per_channel) * SOUND_SPEED / 2.0

    step_grid = np.repeat(steps[:, None], n_pings, axis=1)
    if interval_varies_by_ping:
        ramp = 1.0 + 0.5 * np.arange(n_pings) / max(n_pings - 1, 1)
        step_grid = step_grid * ramp[None, :]

    depth_offset = np.full(n_pings, transducer_draft, dtype="float64")
    if heave_amplitude:
        depth_offset += heave_amplitude * np.sin(
            2 * np.pi * np.arange(n_pings) / max(n_pings / 4, 1)
        )

    sample_index = np.arange(n_samples)
    echo_range = step_grid[:, :, None] * sample_index[None, None, :]
    depth = echo_range + depth_offset[None, :, None]

    sv = (
        -80.0
        + 10.0 * np.arange(n_channels)[:, None, None]
        + 0.1 * np.arange(n_pings)[None, :, None]
        + 0.01 * sample_index[None, None, :]
    )

    if nodata:
        sv[:, :, -5:] = np.nan
        sv[:, n_pings // 2, :] = np.nan

    coords = {
        "channel": [f"chan{c}" for c in range(n_channels)],
        "ping_time": ping_time,
        "range_sample": sample_index,
    }
    data_vars = {"Sv": (("channel", "ping_time", "range_sample"), sv)}

    if gridded:
        coords["depth"] = ("range_sample", depth[0, 0, :])
    else:
        coords["echo_range"] = (
            ("channel", "ping_time", "range_sample"),
            echo_range,
        )
        data_vars["depth"] = (("channel", "ping_time", "range_sample"), depth)
        data_vars["transducer_depth"] = (
            ("channel", "ping_time"),
            np.repeat(depth_offset[None, :], n_channels, axis=0),
        )

    ds = xr.Dataset(data_vars, coords=coords)

    if gps:
        lat, lon = _track(n_pings, speed_change)
        ds["latitude"] = ("ping_time", lat)
        ds["longitude"] = ("ping_time", lon)

    return ds


def _track(n_pings, speed_change):
    """Straight northward track, optionally halving speed halfway."""
    per_ping = np.full(n_pings, 1e-4)
    if speed_change:
        per_ping[n_pings // 2:] = 0.5e-4
    lat = 44.0 + np.concatenate([[0.0], np.cumsum(per_ping[:-1])])
    lon = np.full(n_pings, -68.0)
    return lat, lon


def platform_with_gaps(ds, invalid_fraction=0.3, offset_seconds=0.4):
    """Build a platform dataset on its own time axis with invalid fixes.

    Platform latitude and longitude are dimensioned by NMEA datagram time rather
    than by ping, and real surveys contain non finite fixes. Both are reproduced
    here so the nearest time matching and the isfinite filter are exercised.

    Args:
        ds: Dataset carrying the ping axis and a track.
        invalid_fraction: Share of fixes to make non finite.
        offset_seconds: Time offset between fixes and pings.

    Returns:
        xarray.Dataset: With latitude and longitude on a time1 axis.
    """
    ping_time = ds["ping_time"].values
    time1 = ping_time + np.timedelta64(int(offset_seconds * 1000), "ms")

    lat = np.asarray(ds["latitude"].values, dtype="float64").copy()
    lon = np.asarray(ds["longitude"].values, dtype="float64").copy()

    n_invalid = int(len(lat) * invalid_fraction)
    if n_invalid:
        stride = max(len(lat) // n_invalid, 1)
        lat[::stride] = np.nan
        lon[::stride] = np.nan

    return xr.Dataset(
        {"latitude": ("time1", lat), "longitude": ("time1", lon)},
        coords={"time1": time1},
    )


def feature_dataset(n_features=3, n_pings=32, n_samples=24):
    """Build a dataset whose channel like dimension is named 'feature'.

    ML datasets carry a feature dimension where acoustic datasets carry channel,
    which is why the builder discovers the name rather than assuming it.

    Args:
        n_features: Number of features.
        n_pings: Number of pings.
        n_samples: Samples per ping.

    Returns:
        xarray.Dataset: With an Sv array dimensioned by feature.
    """
    ds = synthetic(
        n_channels=n_features, n_pings=n_pings, n_samples=n_samples, gps=False
    )
    return ds.rename({"channel": "feature"})
