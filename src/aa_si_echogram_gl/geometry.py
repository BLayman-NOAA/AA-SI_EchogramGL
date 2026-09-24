"""Derive the per ping geometry sidecar from a dataset.

The viewer renders on the index grid and positions samples from these arrays, so
everything that maps index space to physical space is computed once here rather
than per frame.

Vertical geometry is per channel because transducers can record at different
sample intervals and can sit at different depths. Horizontal geometry is per
ping because all channels in one dataset share a ping axis.
"""

import logging
import warnings

import numpy as np

logger = logging.getLogger(__name__)

EARTH_RADIUS_M = 6371000.0

AFFINE_TOLERANCE = 1e-3
"""Maximum relative deviation of sample spacing within one ping before the
range mapping is judged non affine. The whole design assumes affine, so this is
a real check rather than a formality."""


class GeometryError(ValueError):
    """Raised when a dataset cannot be expressed as per ping affine geometry."""


def resolve_range_var(ds):
    """Return the name of the vertical coordinate.

    Follows the same alternation `AA-SI_Visualization.resolve_range_var` and
    `Echoshader._check_input` handle: a dataset carries either depth or
    echo_range.

    Args:
        ds: xarray Dataset.

    Returns:
        str: 'depth' or 'echo_range'.

    Raises:
        GeometryError: If neither is present.
    """
    for name in ("depth", "echo_range"):
        if name in ds.coords or name in ds.variables:
            return name
    raise GeometryError(
        "dataset carries neither 'depth' nor 'echo_range'; one is required"
    )


def resolve_value_var(ds, value=None):
    """Return the name of the array to render.

    Args:
        ds: xarray Dataset.
        value: Explicit variable name, or None to guess.

    Returns:
        str: Variable name.

    Raises:
        GeometryError: If the name is absent or cannot be guessed.
    """
    if value is not None:
        if value not in ds.variables:
            raise GeometryError(f"no variable named {value!r} in dataset")
        return value
    for name in ("Sv", "sv"):
        if name in ds.variables:
            return name
    raise GeometryError(
        "could not find a value variable; pass value= explicitly"
    )


def find_channel_dim(ds, value_var, range_var, ping_dim):
    """Return the channel like dimension of the value array.

    Discovered rather than assumed, because ML datasets carry a 'feature'
    dimension where acoustic datasets carry 'channel'. This mirrors what
    `MvbsDataHandler.slice_data_for_frequency` does at plot time.

    Args:
        ds: xarray Dataset.
        value_var: Name of the value array.
        range_var: Name of the vertical coordinate.
        ping_dim: Name of the ping dimension.

    Returns:
        str: Dimension name, or None when the array has no third dimension.
    """
    sample_dim = _sample_dim(ds, value_var, ping_dim, range_var)
    others = [d for d in ds[value_var].dims if d not in (ping_dim, sample_dim)]

    if not others:
        return None
    if len(others) > 1:
        raise GeometryError(
            f"{value_var} has extra dimensions {others} beyond ping and sample. "
            f"The store contract permits additional indexable axes such as "
            f"frequency, but the builder does not write them yet."
        )
    return others[0]


def _sample_dim(ds, value_var, ping_dim, range_var):
    """Return the dimension the vertical coordinate varies along."""
    if range_var in ds.coords and ds[range_var].ndim >= 1:
        return ds[range_var].dims[-1]
    dims = [d for d in ds[value_var].dims if d != ping_dim]
    return dims[-1] if dims else None


def is_gridded(ds, range_var):
    """Return True when the vertical coordinate is one dimensional.

    A one dimensional coordinate means every ping shares the same vertical bins,
    which is what `compute_mvbs` produces because it assigns samples to bins by
    value rather than by sample index.

    Args:
        ds: xarray Dataset.
        range_var: Name of the vertical coordinate.

    Returns:
        bool: True for gridded data such as MVBS.
    """
    return ds[range_var].ndim == 1


def vertical_geometry(ds, range_var, channel_dim, ping_dim):
    """Compute per channel per ping range_start and range_step.

    Args:
        ds: xarray Dataset.
        range_var: Name of the vertical coordinate.
        channel_dim: Name of the channel like dimension, or None.
        ping_dim: Name of the ping dimension.

    Returns:
        tuple: (range_start, range_step, max_relative_deviation) where the first
            two are float arrays shaped (n_channels, n_pings).

    Raises:
        GeometryError: If sample spacing is not affine within a ping.
    """
    n_channels = ds.sizes[channel_dim] if channel_dim else 1
    n_pings = ds.sizes[ping_dim]
    # Canonical (channel, ping, sample), the same order the value array is put
    # in. A dataset can carry echo_range and depth in different orders, and
    # reading either one raw would transpose the sidecar against the other.
    array = ds[range_var]
    order = [d for d in (channel_dim, ping_dim) if d in array.dims]
    order += [d for d in array.dims if d not in order]
    grid = np.asarray(array.transpose(*order).values, dtype="float64")

    if grid.ndim not in (1, 2, 3):
        raise GeometryError(
            f"{range_var} has {grid.ndim} dimensions; expected 1, 2 or 3"
        )

    if grid.shape[-1] < 2:
        raise GeometryError(
            f"{range_var} has {grid.shape[-1]} sample(s) per ping; at least two "
            f"are needed to determine the sample spacing"
        )

    # Spacing is a property of each row of the coordinate, so it is measured on
    # the coordinate as stored and only the per ping results are broadcast. A
    # gridded product has one row for the whole survey, and expanding it to
    # every channel and ping first costs gigabytes to learn one number.
    diffs = np.diff(grid, axis=-1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        step = np.nanmedian(diffs, axis=-1)

    with np.errstate(invalid="ignore"):
        deviation = np.abs(diffs - step[..., None])
        scale = np.where(np.abs(step) > 0, np.abs(step), 1.0)
        relative = deviation / scale[..., None]
    max_deviation = float(np.nanmax(relative)) if relative.size else 0.0

    if max_deviation > AFFINE_TOLERANCE:
        raise GeometryError(
            f"{range_var} is not affine in sample index: sample spacing varies "
            f"by up to {max_deviation:.3%} within a ping, above the "
            f"{AFFINE_TOLERANCE:.3%} tolerance. The geometry sidecar cannot "
            f"represent this; a per sample range array would be required."
        )

    start = _first_finite_extrapolated(grid, step)
    if grid.ndim == 2:  # (ping, sample), shared by every channel
        start, step = start[None, ...], step[None, ...]
    shape = (n_channels, n_pings)
    start = np.broadcast_to(start, shape).astype("float32")
    step = np.broadcast_to(step, shape).astype("float32")
    return start, step, max_deviation


def _first_finite_extrapolated(grid, step):
    """Return the sample zero value, extrapolating past leading NaNs."""
    finite = np.isfinite(grid)
    any_finite = finite.any(axis=-1)
    first_index = np.argmax(finite, axis=-1)

    taken = np.take_along_axis(grid, first_index[..., None], axis=-1)[..., 0]
    start = taken - first_index * step
    return np.where(any_finite, start, 0.0)


def transducer_depth(ds, range_var, channel_dim, ping_dim, n_channels, n_pings):
    """Return depth of the transducer face below the surface, per channel ping.

    Stored separately from range_start rather than folded into it, so the
    vertical reference stays switchable at render time.

    Args:
        ds: xarray Dataset.
        range_var: Name of the resolved vertical coordinate.
        channel_dim: Name of the channel like dimension, or None.
        ping_dim: Name of the ping dimension.
        n_channels: Channel count.
        n_pings: Ping count.

    Returns:
        numpy.ndarray: Shape (n_channels, n_pings), zeros when unavailable.
    """
    if "transducer_depth" in ds.variables:
        values = np.asarray(ds["transducer_depth"].values, dtype="float64")
        return np.broadcast_to(
            values if values.ndim == 2 else values[None, ...],
            (n_channels, n_pings),
        ).astype("float32")

    if "depth" in ds.variables and "echo_range" in ds.variables:
        # Whichever of the two is the store's vertical, the other one gives the
        # offset between them, so a store built on echo_range still knows where
        # the surface is.
        depth_start, _, _ = vertical_geometry(ds, "depth", channel_dim, ping_dim)
        range_start, _, _ = vertical_geometry(ds, "echo_range", channel_dim, ping_dim)
        return (depth_start - range_start).astype("float32")

    return np.zeros((n_channels, n_pings), dtype="float32")


def haversine(lat1, lon1, lat2, lon2):
    """Great circle distance in meters between successive positions.

    Args:
        lat1: Latitudes of the first points, degrees.
        lon1: Longitudes of the first points, degrees.
        lat2: Latitudes of the second points, degrees.
        lon2: Longitudes of the second points, degrees.

    Returns:
        numpy.ndarray: Distances in meters.
    """
    lat1, lon1, lat2, lon2 = (np.radians(np.asarray(a, dtype="float64"))
                              for a in (lat1, lon1, lat2, lon2))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def positions(ds, ping_dim, platform=None):
    """Return latitude and longitude aligned onto the ping axis.

    Platform latitude and longitude are dimensioned by NMEA datagram time rather
    than by ping, so they are matched by nearest time rather than by position,
    following `_calculate_speed_from_gps`. Non finite fixes are excluded before
    matching, because real surveys contain them.

    Args:
        ds: xarray Dataset carrying the ping axis.
        ping_dim: Name of the ping dimension.
        platform: Optional Dataset with time indexed latitude and longitude.

    Returns:
        tuple: (latitude, longitude) as float arrays over pings, or
            (None, None) when no usable fixes exist.
    """
    source = platform if platform is not None else ds
    if "latitude" not in source.variables or "longitude" not in source.variables:
        return None, None

    lat = source["latitude"]
    lon = source["longitude"]

    if lat.dims == (ping_dim,):
        lat_values = np.asarray(lat.values, dtype="float64")
        lon_values = np.asarray(lon.values, dtype="float64")
        valid = np.isfinite(lat_values) & np.isfinite(lon_values)
        if not valid.any():
            logger.warning("no finite GPS fixes on the ping axis")
            return None, None
        return _fill_from_valid(lat_values, valid), _fill_from_valid(lon_values, valid)

    time_dim = lat.dims[0]
    lat_values = np.asarray(lat.values, dtype="float64")
    lon_values = np.asarray(lon.values, dtype="float64")
    valid = np.isfinite(lat_values) & np.isfinite(lon_values)
    if not valid.any():
        logger.warning("no finite GPS fixes in the platform group")
        return None, None

    fix_times = np.asarray(source[time_dim].values)[valid]
    ping_times = np.asarray(ds[ping_dim].values)
    nearest = _nearest_index(fix_times, ping_times)
    return lat_values[valid][nearest], lon_values[valid][nearest]


def _fill_from_valid(values, valid):
    """Replace non finite entries with the nearest valid one."""
    index = np.arange(values.size)
    return np.interp(index, index[valid], values[valid])


def _nearest_index(source_times, target_times):
    """Index into source_times of the nearest entry for each target time."""
    source = source_times.astype("datetime64[ns]").astype("int64")
    target = target_times.astype("datetime64[ns]").astype("int64")

    if source.size == 1:
        return np.zeros(target.size, dtype="int64")

    right = np.clip(np.searchsorted(source, target), 1, source.size - 1)
    left = right - 1
    choose_right = np.abs(source[right] - target) < np.abs(target - source[left])
    return np.where(choose_right, right, left)


def along_track_distance(lat, lon):
    """Cumulative along track distance in meters, starting at zero.

    This is true accumulated distance between successive fixes, not elapsed time
    multiplied by one average speed. The two agree only at constant speed, and
    `_calculate_speed_from_gps` computes the latter, so viewer and figure
    distance axes will differ wherever the vessel changed speed.

    Args:
        lat: Latitudes over pings, degrees.
        lon: Longitudes over pings, degrees.

    Returns:
        numpy.ndarray: Cumulative distance in meters.
    """
    steps = haversine(lat[:-1], lon[:-1], lat[1:], lon[1:])
    return np.concatenate([[0.0], np.cumsum(steps)]).astype("float64")


def bin_ping_bounds(ping_times, original_ping_times):
    """Map each bin back to the original ping index range it covers.

    A selection made on binned data has to resolve to original pings.
    `MvbsDataHandler.calculate_ping_range` does this conversion by nearest time
    at plot time; recording it at build time means the viewer and any downstream
    step agree on one mapping.

    Args:
        ping_times: Bin centre times of the gridded dataset.
        original_ping_times: Ping times of the dataset the bins came from.

    Returns:
        tuple: (start, end) int arrays of original ping indices, inclusive.
    """
    bins = np.asarray(ping_times).astype("datetime64[ns]").astype("int64")
    original = np.asarray(original_ping_times).astype("datetime64[ns]").astype("int64")

    # Computed as an offset from the left edge rather than as a sum, which
    # would overflow int64 nanoseconds for dates beyond roughly the year 2262.
    midpoints = bins[:-1] + (bins[1:] - bins[:-1]) // 2
    edges = np.concatenate([[np.iinfo("int64").min], midpoints,
                            [np.iinfo("int64").max]])

    start = np.searchsorted(original, edges[:-1], side="left")
    end = np.searchsorted(original, edges[1:], side="left") - 1
    start = np.clip(start, 0, original.size - 1)
    end = np.clip(end, 0, original.size - 1)
    return start.astype("int32"), end.astype("int32")


def derive(ds, value_var, ping_dim="ping_time", range_var=None, platform=None,
           original_ping_times=None):
    """Compute the full geometry sidecar for one dataset.

    Args:
        ds: xarray Dataset.
        value_var: Name of the value array.
        ping_dim: Name of the ping dimension.
        range_var: Vertical coordinate name, or None to resolve it.
        platform: Optional Dataset carrying latitude and longitude.
        original_ping_times: Ping times of the pre binning dataset, enabling
            the bin to ping mapping.

    Returns:
        dict: Sidecar arrays under 'arrays' and descriptive fields under 'meta'.
    """
    range_var = range_var or resolve_range_var(ds)
    channel_dim = find_channel_dim(ds, value_var, range_var, ping_dim)
    n_channels = ds.sizes[channel_dim] if channel_dim else 1
    n_pings = ds.sizes[ping_dim]

    start, step, deviation = vertical_geometry(ds, range_var, channel_dim, ping_dim)
    depth = transducer_depth(
        ds, range_var, channel_dim, ping_dim, n_channels, n_pings
    )

    arrays = {
        "ping_time": np.asarray(ds[ping_dim].values),
        "range_start": start,
        "range_step": step,
        "transducer_depth": depth,
    }

    lat, lon = positions(ds, ping_dim, platform)
    if lat is not None:
        arrays["latitude"] = lat.astype("float64")
        arrays["longitude"] = lon.astype("float64")
        arrays["x_distance"] = along_track_distance(lat, lon)

    if original_ping_times is not None:
        first, last = bin_ping_bounds(arrays["ping_time"], original_ping_times)
        arrays["bin_ping_start"] = first
        arrays["bin_ping_end"] = last

    return {
        "arrays": arrays,
        "meta": {
            "range_var": range_var,
            "channel_dim": channel_dim,
            "vertical_ref": "depth" if range_var == "depth" else "range",
            "gridded": is_gridded(ds, range_var),
            "affine_deviation": deviation,
            "has_gps": lat is not None,
            "n_channels": n_channels,
            "n_pings": n_pings,
            "channel_names": channel_names(ds, channel_dim),
            "channel_frequencies": channel_frequencies(ds, channel_dim),
        },
    }


def channel_names(ds, channel_dim):
    """Return a name per channel, or None when the dataset carries none.

    Args:
        ds: xarray Dataset.
        channel_dim: Name of the channel like dimension, or None.

    Returns:
        list: One string per channel, or None.
    """
    if not channel_dim or channel_dim not in ds.coords:
        return None
    values = np.asarray(ds[channel_dim].values)
    if values.dtype.kind not in "US O":
        return None
    return [str(value) for value in values]


def channel_frequencies(ds, channel_dim):
    """Return the nominal frequency per channel in hertz, or None.

    The frequency is what an analyst reading a stack of tinted layers is
    choosing between, so it is worth carrying even though nothing renders from
    it. Only a per channel array will do: a scalar says nothing about which
    channel is which.

    Args:
        ds: xarray Dataset.
        channel_dim: Name of the channel like dimension, or None.

    Returns:
        list: One float per channel, or None.
    """
    if not channel_dim or "frequency_nominal" not in ds.variables:
        return None
    values = ds["frequency_nominal"]
    if values.dims != (channel_dim,):
        return None
    numbers = np.asarray(values.values, dtype="float64")
    if not np.isfinite(numbers).all():
        return None
    return [float(value) for value in numbers]
