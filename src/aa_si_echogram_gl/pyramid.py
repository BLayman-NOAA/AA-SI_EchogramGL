"""Build a published echogram store from an xarray Dataset.

This is a plain function over a Dataset, not a recipe op. The recipe op is a
thin wrapper around it, so any dataset from any source can be made viewable
without the recipe system being involved.
"""

import json
import logging
import warnings
from dataclasses import dataclass

import numpy as np
import zarr

from . import contract, geometry, summaries

logger = logging.getLogger(__name__)

DEFAULT_CHUNKS = (1, 2048, 512)

ALIGNMENT_TOLERANCE = 0.5
"""How far range_start may vary within one coarse cell, as a fraction of
range_step, before reduction along the ping axis is refused."""


class AlignmentError(ValueError):
    """Raised when reduction would average samples at different depths."""


def build_pyramid(ds, out, value=None, ping_dim="ping_time", range_var=None,
                  levels=1, platform=None, original_ping_times=None,
                  chunks=DEFAULT_CHUNKS, aggregation="linear_mean",
                  alignment_tolerance=ALIGNMENT_TOLERANCE, auxiliary=None,
                  consolidate=True):
    """Write a viewable store from a dataset.

    Args:
        ds: xarray Dataset holding the value array and a vertical coordinate.
        out: Destination path for the store root.
        value: Value variable name, or None to resolve it.
        ping_dim: Name of the ping dimension.
        range_var: Vertical coordinate name, or None to resolve it.
        levels: Number of levels to write, halving the ping axis each time.
        platform: Optional Dataset carrying latitude and longitude.
        original_ping_times: Ping times before binning, enabling the bin to
            ping mapping.
        chunks: Chunk shape as (channel, ping, sample).
        aggregation: 'linear_mean' or 'max'.
        alignment_tolerance: Permitted variation of range_start within a coarse
            cell, as a fraction of range_step.
        auxiliary: Optional mapping of name to (dims, array) for small shared
            arrays that sit off the sample grid, such as a decomposition basis
            or a categorical palette.
        consolidate: Write consolidated metadata, collapsing the client's
            metadata read to a single request.

    Returns:
        dict: The multiscales block that was written.

    Raises:
        AlignmentError: If reduction would average samples at different depths.
        geometry.GeometryError: If the dataset is not affine in sample index.
    """
    built = build_levels(
        ds,
        value=value,
        ping_dim=ping_dim,
        range_var=range_var,
        levels=levels,
        platform=platform,
        original_ping_times=original_ping_times,
        chunks=chunks,
        aggregation=aggregation,
        alignment_tolerance=alignment_tolerance,
    )

    root = zarr.open_group(str(out), mode="w")
    for level in built.levels:
        _write_level(
            root,
            level.name,
            built.value_var,
            level.values,
            level.arrays,
            level.chunks,
        )

    spec = built.spec
    if auxiliary:
        spec = dict(spec)
        spec["auxiliary"] = _write_auxiliary(root, auxiliary)
    root.attrs["multiscales"] = [spec]
    root.attrs["chunkSummaries"] = "summaries.json"
    _write_summaries(out, built.summaries)

    if consolidate:
        _consolidate(root)

    logger.info(
        "wrote %d level(s) to %s, nodata chunk fraction %.1f%%",
        len(built.levels),
        out,
        100 * summaries.nodata_fraction(built.summaries["0"]),
    )
    return spec


@dataclass(frozen=True)
class Level:
    """One level of a pyramid, before it is written anywhere."""

    name: str
    factor: int
    values: "np.ndarray"
    arrays: dict
    chunks: tuple


@dataclass(frozen=True)
class Pyramid:
    """Every level, and the metadata that describes them together.

    The thing a build produces before it is a store or a DataTree. Both of
    those are a way of laying this out, and keeping them apart is what lets one
    build be written to disk, handed to a recipe as a checkpointable output, or
    concatenated with another one.
    """

    value_var: str
    levels: list
    spec: dict
    summaries: dict


def build_levels(ds, value=None, ping_dim="ping_time", range_var=None, levels=1,
                 platform=None, original_ping_times=None, chunks=DEFAULT_CHUNKS,
                 aggregation="linear_mean",
                 alignment_tolerance=ALIGNMENT_TOLERANCE):
    """Reduce a dataset into levels without writing anything.

    The arguments it shares with build_pyramid mean the same things.

    Returns:
        Pyramid: The levels, the multiscales block and the per chunk summaries.

    Raises:
        AlignmentError: If reduction would average samples at different depths.
        geometry.GeometryError: If the dataset is not affine in sample index.
    """
    value_var = geometry.resolve_value_var(ds, value)
    derived = geometry.derive(
        ds,
        value_var,
        ping_dim=ping_dim,
        range_var=range_var,
        platform=platform,
        original_ping_times=original_ping_times,
    )
    meta = derived["meta"]

    level_values = _as_sentinel_array(ds, value_var, ping_dim, meta)
    level_arrays = derived["arrays"]
    factor = 1

    built = []
    datasets = []
    all_summaries = {}
    for level in range(levels):
        if level > 0:
            _check_alignment(level_arrays["range_start"],
                             level_arrays["range_step"],
                             alignment_tolerance)
            level_values = _reduce_pings(level_values, 2, aggregation)
            level_arrays = _reduce_sidecar(level_arrays, 2)
            factor *= 2

        name = str(level)
        effective = tuple(
            min(c, s) for c, s in zip(chunks, level_values.shape, strict=True)
        )
        built.append(Level(name, factor, level_values, level_arrays, effective))
        datasets.append({
            "path": name,
            "factors": {"ping": factor, "sample": 1},
            "chunks": list(effective),
        })
        all_summaries[name] = summaries.summarize_level(
            level_values, effective, contract.NODATA_THRESHOLD
        )

    return Pyramid(
        value_var=value_var,
        levels=built,
        spec=_multiscales(value_var, meta, datasets, aggregation),
        summaries=all_summaries,
    )


def _as_sentinel_array(ds, value_var, ping_dim, meta):
    """Return the value array as (channel, ping, sample) with sentinel nodata."""
    data = ds[value_var]
    channel_dim = meta["channel_dim"]
    remaining = [d for d in data.dims if d not in (ping_dim, channel_dim)]
    if len(remaining) != 1:
        raise ValueError(
            f"{value_var} has dimensions {list(data.dims)}; the builder writes "
            f"exactly one sample axis alongside ping and channel"
        )

    order = [d for d in (channel_dim, ping_dim, remaining[0]) if d is not None]
    values = np.asarray(data.transpose(*order).values, dtype="float32")
    if channel_dim is None:
        values = values[None, ...]

    return np.where(np.isfinite(values), values, contract.NODATA)


def _check_alignment(range_start, range_step, tolerance):
    """Refuse reduction when range_start varies across the pings being merged.

    Averaging sample index i across pings averages different depths whenever the
    transducer moved, which heave guarantees. At MVBS resolution the smear is
    small; at raw Sv resolution a metre of heave is tens of samples.

    `compute_mvbs` assigns samples to bins by value rather than by sample index,
    so data binned by depth arrives already regularized and passes this check.
    """
    if range_start.shape[1] < 2:
        return

    start = _pad_pings(range_start, 2, mode="edge")
    step = _pad_pings(range_step, 2, mode="edge")

    pairs = start.reshape(start.shape[0], -1, 2)
    spread = np.abs(pairs[:, :, 0] - pairs[:, :, 1])
    scale = np.abs(step[:, ::2])
    scale = np.where(scale > 0, scale, 1.0)
    worst = float(np.max(spread / scale))

    if worst > tolerance:
        raise AlignmentError(
            f"range_start varies by up to {worst:.2f} sample spacings within a "
            f"coarse cell, above the {tolerance} tolerance. Reducing along the "
            f"ping axis would average samples at different depths. Bin by depth "
            f"upstream, for example with compute_mvbs using range_var='depth', "
            f"so the vertical grid is regular before the pyramid is built."
        )


def _pad_pings(values, factor, mode, fill=None):
    """Extend the ping axis to a whole multiple of factor.

    Trimming the remainder instead would leave coarse levels covering less than
    level zero, which shows at overview zoom as missing data at the right hand
    edge. Padding keeps every level over the same extent, and because nodata is
    excluded from aggregation, a partial cell simply averages fewer
    contributors.
    """
    axis = 1 if values.ndim == 2 or values.ndim == 3 else 0
    remainder = values.shape[axis] % factor
    if remainder == 0:
        return values

    pad_width = [(0, 0)] * values.ndim
    pad_width[axis] = (0, factor - remainder)
    if mode == "edge":
        return np.pad(values, pad_width, mode="edge")
    return np.pad(values, pad_width, mode="constant", constant_values=fill)


def _reduce_pings(values, factor, aggregation):
    """Halve the ping axis, aggregating in linear space and excluding nodata."""
    padded = _pad_pings(values, factor, mode="constant", fill=contract.NODATA)
    n_channels, n_pings, n_samples = padded.shape
    block = padded.reshape(n_channels, n_pings // factor, factor, n_samples)

    valid = block > contract.NODATA_THRESHOLD
    masked = np.where(valid, block, np.nan)

    # Cells whose contributors are all nodata reduce to NaN and become the
    # sentinel below, so the empty slice warning is expected rather than a fault.
    with np.errstate(invalid="ignore", divide="ignore"), \
            warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        if aggregation == "max":
            reduced = np.nanmax(masked, axis=2)
        else:
            linear = np.power(10.0, masked / 10.0)
            reduced = 10.0 * np.log10(np.nanmean(linear, axis=2))

    return np.where(np.isfinite(reduced), reduced, contract.NODATA).astype("float32")


def _reduce_sidecar(arrays, factor):
    """Reduce sidecar arrays alongside the value array."""
    out = {}
    for name, values in arrays.items():
        numeric = np.issubdtype(values.dtype, np.floating)
        padded = _pad_pings(
            values, factor,
            mode="constant" if numeric else "edge",
            fill=np.nan if numeric else None,
        )

        if values.ndim == 2:
            block = padded.reshape(values.shape[0], -1, factor)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                out[name] = np.nanmean(block, axis=2).astype(values.dtype)
        else:
            block = padded.reshape(-1, factor)
            if np.issubdtype(values.dtype, np.datetime64):
                # Bin centre, so ping_time is consistent with latitude,
                # longitude and x_distance, which are averaged.
                as_int = block.astype("datetime64[ns]").astype("int64")
                mid = as_int[:, 0] + (as_int[:, -1] - as_int[:, 0]) // 2
                out[name] = mid.astype("datetime64[ns]")
            elif name == "bin_ping_start":
                out[name] = block[:, 0]
            elif name == "bin_ping_end":
                out[name] = block[:, -1]
            else:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)
                    out[name] = np.nanmean(block, axis=1).astype(values.dtype)
    return out


def _write_level(root, name, value_var, values, arrays, chunks):
    """Write one level group, value array plus sidecar."""
    group = root.create_group(name)

    shape = values.shape
    array = group.create_array(
        name=value_var, shape=shape, dtype=contract.VALUE_DTYPE, chunks=chunks
    )
    array[:] = values.astype(contract.VALUE_DTYPE)

    for key, data in arrays.items():
        if np.issubdtype(data.dtype, np.datetime64):
            data = data.astype("datetime64[ns]").astype("int64")
        sidecar = group.create_array(
            name=key, shape=data.shape, dtype=data.dtype, chunks=data.shape
        )
        sidecar[:] = data


def _multiscales(value_var, meta, datasets, aggregation):
    """Assemble the multiscales block."""
    axes = [
        {"name": "ping", "type": "time"},
        {"name": "sample", "type": "space", "unit": "meter"},
    ]
    channel_dim = meta["channel_dim"]
    if channel_dim:
        axes.insert(0, {"name": channel_dim, "type": "channel", "indexable": True})

    valid_x = ["datetime", "seconds", "pings"]
    if meta["has_gps"]:
        valid_x.append("meters")
    valid_y = ["meters", "range_sample"]
    if meta["gridded"]:
        valid_x.append("bins")
        valid_y.append("bins")

    block = {
        "name": value_var,
        "axes": axes,
        "datasets": datasets,
        "aggregation": aggregation,
        "nodata": contract.NODATA,
        "nodataThreshold": contract.NODATA_THRESHOLD,
        "dataType": "MVBS" if meta["gridded"] else "Sv",
        "channelDim": channel_dim,
        "verticalRef": meta["vertical_ref"],
        "rangeVar": meta["range_var"],
        "validXAxes": valid_x,
        "validYAxes": valid_y,
        "histRange": list(summaries.HIST_RANGE),
        "histBins": summaries.HIST_BINS,
    }

    # Optional, and omitted rather than written empty: a viewer that finds
    # neither falls back to the channel index, and a store written before this
    # existed is still a valid store.
    if meta.get("channel_names"):
        block["channelNames"] = meta["channel_names"]
    if meta.get("channel_frequencies"):
        block["channelFrequencies"] = meta["channel_frequencies"]
    return block


def _consolidate(root):
    """Write consolidated metadata into the root.

    A client opening a four level store otherwise reads one metadata document
    per array, roughly two dozen requests before any sample data is fetched.
    Consolidation collapses that to one, which matters over a network far more
    than it does on local disk.

    Zarr v3 has not standardized this yet, but it is additive: the consolidated
    block lives alongside the per array documents, so a reader that ignores it
    still opens the store correctly. That makes the warning informational rather
    than a reason to skip it.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        zarr.consolidate_metadata(root.store)


def _write_auxiliary(root, auxiliary):
    """Write small shared arrays that sit off the sample grid.

    The motivating case is a reconstruction basis, whose axes are component and
    frequency rather than ping and sample, but the slot is general: categorical
    palettes for cluster layers and calibration parameters fit the same shape.
    """
    group = root.create_group("aux")
    declared = {}
    for name, (dims, values) in auxiliary.items():
        data = np.asarray(values)
        array = group.create_array(
            name=name, shape=data.shape, dtype=data.dtype, chunks=data.shape
        )
        array[:] = data
        declared[name] = {"path": f"aux/{name}", "dims": list(dims)}
    return declared


def _write_summaries(out, all_summaries):
    """Write the per chunk summary sidecar next to the store.

    Beside the store wherever the store is. zarr writes the levels through
    fsspec when `out` is a URL, and this has to follow it there: a local open()
    on a gs:// path does not fail loudly, it writes a directory named after the
    bucket into the working directory, and the published store silently has no
    summaries.

    Args:
        out: Store root, as a path or an fsspec URL.
        all_summaries: Level name to its per chunk summaries.
    """
    import os

    text = json.dumps(all_summaries)
    target = str(out)
    if "://" in target:
        import fsspec

        with fsspec.open(
            f"{target.rstrip('/')}/summaries.json", "w", encoding="utf-8"
        ) as handle:
            handle.write(text)
        return
    path = os.path.join(target, "summaries.json")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
