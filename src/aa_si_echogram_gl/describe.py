"""Describing a dataset for the viewer.

A pyramid carries its geometry in sidecar arrays the builder wrote. A
dataset a recipe step checkpointed carries coordinates instead, in whatever
shape the step left them: a three dimensional `echo_range`, a one
dimensional `depth` grid, a time encoded in CF units. This turns one of those
into a header the client can draw from, with the same `geometry.derive` the
builder uses, so the client reads only value chunks and never works geometry
out for itself.
"""

import base64

import numpy as np

from . import contract, geometry

VALUE_NAMES = ("Sv_corrected", "Sv_Corrected", "Sv", "_da")
"""Variables looked for, best first. `_da` is what the recipe manager names a
checkpointed DataArray."""

LABEL_HINTS = ("label", "cluster")

TILE = {"channel": 1, "ping": 2048, "sample": 1024}
"""Chunk length per axis the server serves a variable in. 2048 pings is the
client's tile height, so a tile reads one row of chunks. See `tiles`."""

RAMP_SAMPLES = 256
"""Samples of a per ping vertical read to find its start and step.

A three dimensional `echo_range` is as large as the values, a few hundred
megabytes for one file of Sv at full resolution, and only its first samples
are needed. The affine check runs over these rather than over the whole
column."""


def open_dataset(url, storage_options=None):
    """Open a zarr dataset lazily, reading consolidated metadata where present."""
    import xarray as xr

    return xr.open_zarr(
        url,
        consolidated=None,
        chunks=None,
        storage_options=storage_options or None,
    )


def value_var(ds, name=None):
    """The variable to draw.

    Args:
        ds: xarray Dataset.
        name: Explicit name, or None to choose.

    Returns:
        str: Variable name.

    Raises:
        geometry.GeometryError: If nothing drawable is found.
    """
    if name is not None:
        if name not in ds.data_vars:
            raise geometry.GeometryError(f"no variable named {name!r}")
        return name
    for candidate in VALUE_NAMES:
        if candidate in ds.data_vars:
            return candidate
    for candidate, values in ds.data_vars.items():
        if "ping_time" in values.dims and values.ndim >= 2:
            return candidate
    raise geometry.GeometryError(
        "no variable with a ping_time dimension and a vertical one to draw"
    )


def kind_of(ds, var, range_var):
    """`labels`, `mvbs` or `sv`, which sets how a layer opens.

    Cluster labels arrive as float64 with NaN where nothing was clustered, so
    the dtype alone does not say. What does is the `source_variable` attribute
    the ML gridding sets, on a two dimensional result; a gridded feature set
    carries a feature axis as well.
    """
    values = ds[var]
    lowered = var.lower()
    if values.dtype.kind in "iu" or any(hint in lowered for hint in LABEL_HINTS):
        return "labels"
    if "source_variable" in values.attrs and values.ndim == 2:
        return "labels"
    if geometry.is_gridded(ds, range_var):
        return "mvbs"
    return "sv"


def extent(ds, var):
    """Channels and samples of the variable to draw, without reading it."""
    range_var = geometry.resolve_range_var(ds)
    channel_dim = geometry.find_channel_dim(ds, var, range_var, "ping_time")
    channels = int(ds.sizes[channel_dim]) if channel_dim else 1
    sample = [d for d in ds[var].dims if d not in ("ping_time", channel_dim)]
    return channels, int(ds.sizes[sample[0]])


def describe(url, storage_options=None, var=None):
    """A header for one dataset: its shape, layout and per ping geometry.

    Args:
        url: Dataset location, a path or an fsspec URL.
        storage_options: fsspec options for it.
        var: Variable to draw, or None to choose.

    Returns:
        dict: JSON serialisable. Sidecars are base64 float64, little endian.
    """
    ds = open_dataset(url, storage_options)
    var = value_var(ds, var)
    range_var = geometry.resolve_range_var(ds)
    vertical = ds[range_var]
    sample_dim = vertical.dims[-1]
    trimmed = ds
    if vertical.ndim > 1:
        trimmed = ds.isel({sample_dim: slice(0, RAMP_SAMPLES)})

    derived = geometry.derive(trimmed, var, range_var=range_var)
    meta = derived["meta"]
    arrays = derived["arrays"]
    values = ds[var]
    channel_dim = meta["channel_dim"]
    dims = list(values.dims)
    sample = [d for d in dims if d not in ("ping_time", channel_dim)]

    kind = kind_of(ds, var, range_var)
    data_type = {"labels": "Cluster-MVBS", "mvbs": "MVBS"}.get(kind, "Sv")
    if kind == "labels" and not meta["gridded"]:
        data_type = "Sv"

    sidecars = {}
    for name in ("ping_time", "range_start", "range_step", "transducer_depth",
                 "x_distance"):
        if name in arrays:
            sidecars[name] = encode(arrays[name])

    return {
        "var": var,
        "kind": kind,
        "dims": dims,
        "order": {
            "channel": dims.index(channel_dim) if channel_dim else None,
            "ping": dims.index("ping_time"),
            "sample": dims.index(sample[0]),
        },
        "shape": [int(n) for n in values.shape],
        # As the server serves it, not as it is stored. See `tiles`.
        "chunks": tile_chunks(ds, var),
        "dtype": "float32",
        "storedChunks": stored_chunks(values),
        "storedDtype": values.dtype.name,
        "channels": meta["n_channels"],
        "pings": meta["n_pings"],
        "samples": int(ds.sizes[sample[0]]),
        "dataType": data_type,
        "verticalRef": meta["vertical_ref"],
        "rangeVar": range_var,
        "gridded": meta["gridded"],
        "hasGps": meta["has_gps"],
        "channelNames": meta["channel_names"],
        "channelFrequencies": meta["channel_frequencies"],
        "nodata": contract.NODATA,
        "nodataThreshold": contract.NODATA_THRESHOLD,
        "sidecars": sidecars,
    }


def encode(values):
    """An array as base64 float64, with its shape, for a JSON header."""
    data = np.asarray(values)
    if np.issubdtype(data.dtype, np.datetime64):
        data = data.astype("datetime64[ns]").astype("int64")
    data = np.ascontiguousarray(data, dtype="<f8")
    return {
        "shape": list(data.shape),
        "data": base64.b64encode(data.tobytes()).decode("ascii"),
    }


def tile_chunks(ds, var):
    """The chunk shape the server serves a variable in, in its dimension order."""
    range_var = geometry.resolve_range_var(ds)
    channel_dim = geometry.find_channel_dim(ds, var, range_var, "ping_time")
    chunks = []
    for dim, size in zip(ds[var].dims, ds[var].shape, strict=True):
        if dim == channel_dim:
            length = TILE["channel"]
        elif dim == "ping_time":
            length = TILE["ping"]
        else:
            length = TILE["sample"]
        chunks.append(int(min(length, size)))
    return chunks


def stored_chunks(values):
    """The stored chunk shape of a lazily opened variable."""
    found = values.encoding.get("chunks") or values.encoding.get("preferred_chunks")
    if isinstance(found, dict):
        found = [found.get(d) for d in values.dims]
    if found:
        return [int(n) for n in found]
    return [int(n) for n in values.shape]
