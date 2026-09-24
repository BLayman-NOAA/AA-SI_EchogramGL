"""Recipe ops for building viewer pyramids.

Three callables, and the shape of them is the point.

`build_echogram_pyramid` turns an Sv dataset into a pyramid and returns it as a
DataTree, one node per level. That is a checkpointable step output, so a recipe
run leaves the store in its own cache under the step's content address, and the
viewer is pointed straight at it. Nothing has to be published anywhere for a
pyramid to be looked at.

`plan_pyramid_segments` and `merge_echogram_pyramids` are the parallel form.
A pyramid is a reduction along the ping axis, so it splits along that axis and
the pieces concatenate, but only if the cuts fall where the reduction's own cell
boundaries fall. The planner puts them there, which is the whole of the trick:

    level k merges 2**k pings, so a segment whose ping count is a multiple of
    2**(levels-1) reduces to a whole number of cells at every level, and level k
    of the survey is exactly level k of each segment laid end to end.

The last segment is exempt and does not need to be a multiple of anything. Its
final cell is short, which is what the serial build produces at the end of a
survey anyway: `_reduce_pings` pads the last block with the sentinel. So a
segmented build is not an approximation of the serial one, it is the same
answer, and `tests/test_ops.py` asserts that against a real survey.
"""

import logging

import numpy as np
import xarray as xr

from . import contract, summaries as summaries_module
from .pyramid import DEFAULT_CHUNKS, build_levels

logger = logging.getLogger(__name__)

SUMMARIES_ATTR = "chunkSummaries"

DEFAULT_SEGMENT_PINGS = 32768
"""Pings a segment aims for, which is 2048 * 16.

Sized for the memory of one mapped instance rather than for chunk alignment.
A segment is held whole while its levels are reduced, so at five channels and
an uncropped 1400 sample column, 32,768 pings is about 0.9 GB at level zero and
twice that through the cascade. 262,144 would be 7.3 and 14.7, per worker, with
several running at once.

The larger number is not arbitrary and it is what this was: 2048 * 128 is the
only size that leaves every one of eight levels a whole number of 2048 ping
chunks, which a collect could one day exploit by copying chunk objects instead
of decoding them. 32,768 keeps that property for levels zero to four and gives
it up for five, six and seven, where a segment holds 1024, 512 and 256 pings.
Those three are small enough to concatenate by reading whatever happens, so the
trade buys eight times the headroom for a fast path that does not exist yet.

Raise it for a wide machine, lower it for a deep water column.
"""


def build_echogram_pyramid(
    ds_Sv,
    levels=8,
    value=None,
    range_var="echo_range",
    ping_range=None,
    platform=None,
    chunks=DEFAULT_CHUNKS,
    aggregation="linear_mean",
):
    """Build a viewer pyramid from an Sv dataset.

    Args:
        ds_Sv: Sv Dataset with a vertical coordinate and ping_time.
        levels: Levels to build, halving the ping axis each time.
        value: Value variable name, or None to resolve it.
        range_var: Vertical coordinate, echo_range by default. See the note in
            scripts/build_viewer_store.py: depth carries heave and fails the
            alignment check, because averaging sample index i across pings that
            heaved averages different depths.
        ping_range: Optional [start, stop] to build one segment of the survey,
            which is what the mapped form passes. The slice is taken here
            rather than upstream so a mapped instance reads only its own pings.
        platform: Optional Dataset carrying latitude and longitude.
        chunks: Chunk shape as (channel, ping, sample).
        aggregation: 'linear_mean' or 'max'.

    Returns:
        xarray.DataTree: One node per level, with the multiscales block and the
        per chunk summaries on the root.

    Raises:
        ValueError: If ping_range is not a two element range inside the data.
    """
    if ping_range is not None:
        start, stop = _range(ping_range, ds_Sv.sizes["ping_time"])
        ds_Sv = ds_Sv.isel(ping_time=slice(start, stop))

    built = build_levels(
        ds_Sv,
        value=value,
        range_var=range_var,
        levels=levels,
        platform=platform,
        chunks=chunks,
        aggregation=aggregation,
    )
    logger.info(
        "built %d level(s) over %d pings",
        len(built.levels),
        built.levels[0].values.shape[1],
    )
    return _as_tree(built)


def plan_pyramid_segments(ds_Sv, levels=8, target_pings=DEFAULT_SEGMENT_PINGS):
    """Choose ping ranges that a pyramid can be built over independently.

    Every range but the last is a multiple of 2**(levels-1), so it reduces to a
    whole number of cells at every level and the results concatenate exactly.
    The last range is whatever is left, which is the one place a short cell is
    correct.

    Args:
        ds_Sv: Sv Dataset, read only for its ping count.
        levels: Levels the build will produce, which sets the grid.
        target_pings: Rough size to aim for, rounded down onto the grid. See
            DEFAULT_SEGMENT_PINGS for how the default was chosen and what it
            costs a mapped instance in memory.

    Returns:
        dict: 'ranges', a list of [start, stop] pairs, and 'grid', the multiple
        they are aligned to.

    Raises:
        ValueError: If levels or target_pings is not positive.
    """
    if levels < 1:
        raise ValueError(f"levels must be at least 1, got {levels}")
    if target_pings < 1:
        raise ValueError(f"target_pings must be positive, got {target_pings}")

    total = int(ds_Sv.sizes["ping_time"])
    grid = 2 ** (levels - 1)
    step = max(grid, (target_pings // grid) * grid)

    ranges = []
    start = 0
    while start < total:
        stop = min(start + step, total)
        # Absorb a final scrap into the previous range rather than emitting a
        # segment shorter than the grid: two short segments in a row would put
        # a partial cell somewhere other than the end.
        if total - stop < grid and stop != total:
            stop = total
        ranges.append([start, stop])
        start = stop

    logger.info(
        "planned %d segment(s) of about %d pings on a %d ping grid",
        len(ranges),
        step,
        grid,
    )
    return {"ranges": ranges, "grid": grid}


def merge_echogram_pyramids(parts, dim="ping_time", chunks=DEFAULT_CHUNKS):
    """Concatenate per segment pyramids into one.

    Level k of the survey is level k of each part laid end to end, so this is a
    concatenation per level and not a rebuild. Nothing is reduced again and no
    level is added: each part already carries every level.

    The summaries are recomputed rather than merged. They are keyed by chunk
    coordinate, and a part's chunk grid is not the whole survey's, so the keys
    cannot be shifted into place. Recomputing costs one pass over values that
    are in memory anyway.

    Args:
        parts: Pyramid DataTrees, in ping order.
        dim: Ping dimension name.
        chunks: Chunk shape the merged store should use, as the build would
            have been given. Not taken from the parts: a part's chunks were
            clipped to the length of a segment, and reusing those would chunk
            the whole survey as if it were one, which is a different store from
            the one a serial build writes.

    Returns:
        xarray.DataTree: The combined pyramid.

    Raises:
        ValueError: If the parts disagree about levels or hold nothing.
    """
    parts = [p for p in parts if p is not None]
    if not parts:
        raise ValueError("no pyramids to merge")
    if len(parts) == 1:
        return parts[0]

    names = [_level_names(p) for p in parts]
    if any(n != names[0] for n in names[1:]):
        raise ValueError(
            "the parts do not have the same levels: "
            + "; ".join(",".join(n) for n in names)
        )

    spec = _spec_of(parts[0])
    value_var = spec["name"]

    merged = {}
    all_summaries = {}
    for index, name in enumerate(names[0]):
        pieces = [p[name].to_dataset() for p in parts]
        level = xr.concat(pieces, dim=dim, data_vars="all", coords="all",
                          join="exact", combine_attrs="override")
        merged[name] = level

        effective = tuple(
            min(c, s)
            for c, s in zip(chunks, level[value_var].shape, strict=True)
        )
        spec["datasets"][index]["chunks"] = list(effective)
        all_summaries[name] = summaries_module.summarize_level(
            np.asarray(level[value_var].values),
            effective,
            contract.NODATA_THRESHOLD,
        )

    tree = xr.DataTree.from_dict({f"/{k}": v for k, v in merged.items()})
    tree.attrs["multiscales"] = [spec]
    tree.attrs[SUMMARIES_ATTR] = all_summaries
    logger.info(
        "merged %d part(s) into %d pings at level zero",
        len(parts),
        merged[names[0][0]].sizes[dim],
    )
    return tree


def _as_tree(built):
    """Lay a built pyramid out as a DataTree, one node per level."""
    nodes = {}
    for level in built.levels:
        data = {
            built.value_var: (
                ("channel", "ping_time", "range_sample"),
                level.values.astype(contract.VALUE_DTYPE),
            )
        }
        for key, array in level.arrays.items():
            data[key] = (_sidecar_dims(array, level.values.shape), array)
        nodes[f"/{level.name}"] = xr.Dataset(data)

    tree = xr.DataTree.from_dict(nodes)
    tree.attrs["multiscales"] = [built.spec]
    tree.attrs[SUMMARIES_ATTR] = built.summaries
    return tree


def _sidecar_dims(array, shape):
    """Name a sidecar's dimensions from its shape.

    Per (channel, ping) for the geometry, per ping for a ping coordinate, per
    channel for anything the channel axis alone indexes.
    """
    channels, pings, _ = shape
    if array.ndim == 2:
        return ("channel", "ping_time")
    if array.ndim == 1 and array.shape[0] == pings:
        return ("ping_time",)
    if array.ndim == 1 and array.shape[0] == channels:
        return ("channel",)
    return tuple(f"dim_{i}" for i in range(array.ndim))


def _level_names(tree):
    """Level names of a pyramid tree, in level order."""
    names = [name for name in tree.children if name.isdigit()]
    return sorted(names, key=int)


def _spec_of(tree):
    """The multiscales block of a pyramid tree, copied so it can be edited."""
    blocks = tree.attrs.get("multiscales")
    if not blocks:
        raise ValueError("a part has no multiscales attribute, so it is not a pyramid")
    spec = blocks[0]
    spec = dict(spec)
    spec["datasets"] = [dict(d) for d in spec["datasets"]]
    return spec


def _range(ping_range, total):
    """Validate a [start, stop] pair against the data it indexes."""
    try:
        start, stop = ping_range
    except (TypeError, ValueError) as error:
        raise ValueError(
            f"ping_range must be a [start, stop] pair, got {ping_range!r}"
        ) from error
    start, stop = int(start), int(stop)
    if not 0 <= start < stop <= total:
        raise ValueError(
            f"ping_range {[start, stop]} is outside 0 to {total}"
        )
    return start, stop
