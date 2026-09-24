"""The published store contract.

Defines the on disk shape a viewer can read, and a validator that checks a
written store against it. The validator is the executable form of the contract:
every later milestone checks its failures against this rather than against
prose.
"""

from dataclasses import dataclass

import zarr

NODATA = -9999.0
"""Sentinel written in place of NaN. Stored as float16, so the round tripped
value is not exactly this. Comparisons use NODATA_THRESHOLD instead."""

NODATA_THRESHOLD = -5000.0
"""Anything at or below this is nodata. Real Sv spans roughly -120 to 0 dB, so
the gap is large and the test is robust to float16 rounding of the sentinel."""

VALUE_DTYPE = "float16"

REQUIRED_AXES = ("ping", "sample")

SIDECAR_PER_CHANNEL = ("range_start", "range_step")
"""Vertical geometry is per channel because transducers can record at different
sample intervals and can sit at different depths."""

SIDECAR_PER_PING = ("ping_time",)

SIDECAR_OPTIONAL = (
    "x_distance",
    "latitude",
    "longitude",
    "transducer_depth",
    "bin_ping_start",
    "bin_ping_end",
)

X_AXIS_UNITS = ("datetime", "seconds", "pings", "bins", "meters")
Y_AXIS_UNITS = ("meters", "range_sample", "bins")

AGGREGATIONS = ("linear_mean", "max")

VERTICAL_REFS = ("range", "depth")


@dataclass(frozen=True)
class Problem:
    """A single contract violation.

    Attributes:
        code: Short stable identifier, suitable for asserting against.
        message: Human readable description.
        where: Path within the store, or an empty string for the root.
    """

    code: str
    message: str
    where: str = ""

    def __str__(self):
        prefix = f"{self.where}: " if self.where else ""
        return f"{prefix}{self.message}"


def validate_store(path):
    """Check a written store against the contract.

    Args:
        path: Filesystem path or fsspec URL of the store root.

    Returns:
        list[Problem]: Empty when the store satisfies the contract.
    """
    problems = []
    try:
        root = zarr.open_group(str(path), mode="r")
    except Exception as exc:  # noqa: BLE001 - a validator reports, never raises
        return [Problem("unreadable", f"could not open store: {exc}")]

    multiscales = root.attrs.get("multiscales")
    if not multiscales:
        return [Problem("no_multiscales", "root has no multiscales attribute")]

    spec = multiscales[0]
    problems += _check_spec(spec)
    problems += _check_levels(root, spec)
    return problems


def _check_spec(spec):
    """Check the multiscales block itself."""
    problems = []
    for field in ("name", "axes", "datasets", "aggregation", "nodata",
                  "dataType", "channelDim", "verticalRef"):
        if field not in spec:
            problems.append(Problem("missing_field", f"multiscales has no {field}"))

    axis_names = [a["name"] for a in spec.get("axes", [])]
    for required in REQUIRED_AXES:
        if required not in axis_names:
            problems.append(
                Problem("missing_axis", f"axes must include {required}")
            )

    if spec.get("aggregation") not in AGGREGATIONS:
        problems.append(
            Problem("bad_aggregation", f"aggregation must be one of {AGGREGATIONS}")
        )

    if spec.get("verticalRef") not in VERTICAL_REFS:
        problems.append(
            Problem("bad_vertical_ref", f"verticalRef must be one of {VERTICAL_REFS}")
        )

    for unit in spec.get("validXAxes", []):
        if unit not in X_AXIS_UNITS:
            problems.append(Problem("bad_x_unit", f"unknown x axis unit {unit}"))
    for unit in spec.get("validYAxes", []):
        if unit not in Y_AXIS_UNITS:
            problems.append(Problem("bad_y_unit", f"unknown y axis unit {unit}"))

    for entry in spec.get("datasets", []):
        if "path" not in entry or "factors" not in entry:
            problems.append(
                Problem("bad_dataset", "each datasets entry needs path and factors")
            )
            continue
        missing = set(axis_names) - set(entry["factors"]) - {spec.get("channelDim")}
        if missing:
            problems.append(
                Problem(
                    "missing_factor",
                    f"level {entry['path']} has no factor for {sorted(missing)}",
                )
            )
    return problems


def _check_levels(root, spec):
    """Check each level group that lives inside this store."""
    problems = []
    value_name = spec["name"]

    for entry in spec.get("datasets", []):
        level = entry["path"]
        if "://" in level or level.startswith("/"):
            continue  # referenced elsewhere, not ours to validate

        try:
            group = root[level]
        except KeyError:
            problems.append(Problem("missing_level", "level group absent", level))
            continue

        if value_name not in group:
            problems.append(
                Problem("missing_value", f"no {value_name} array", level)
            )
            continue

        value = group[value_name]
        if value.dtype.name != VALUE_DTYPE:
            problems.append(
                Problem(
                    "bad_dtype",
                    f"{value_name} is {value.dtype.name}, expected {VALUE_DTYPE}",
                    level,
                )
            )

        if getattr(value, "shards", None) is not None:
            problems.append(
                Problem(
                    "sharded",
                    "value array is sharded; one object per chunk is required",
                    level,
                )
            )

        if value.ndim < 3:
            problems.append(
                Problem(
                    "bad_rank",
                    f"{value_name} has {value.ndim} dimensions, expected at "
                    f"least 3; extra axes such as frequency are permitted",
                    level,
                )
            )
            continue

        n_channels, n_pings = value.shape[0], value.shape[1]
        problems += _check_sidecar(group, level, n_channels, n_pings)

    return problems


def _check_sidecar(group, level, n_channels, n_pings):
    """Check sidecar arrays present in one level group."""
    problems = []

    for name in SIDECAR_PER_CHANNEL:
        if name not in group:
            problems.append(Problem("missing_sidecar", f"no {name}", level))
            continue
        if group[name].shape != (n_channels, n_pings):
            problems.append(
                Problem(
                    "bad_sidecar_shape",
                    f"{name} is {group[name].shape}, "
                    f"expected {(n_channels, n_pings)}",
                    level,
                )
            )

    for name in SIDECAR_PER_PING:
        if name not in group:
            problems.append(Problem("missing_sidecar", f"no {name}", level))
            continue
        if group[name].shape != (n_pings,):
            problems.append(
                Problem(
                    "bad_sidecar_shape",
                    f"{name} is {group[name].shape}, expected {(n_pings,)}",
                    level,
                )
            )

    for name in SIDECAR_OPTIONAL:
        if name in group and group[name].shape not in (
            (n_pings,),
            (n_channels, n_pings),
        ):
            problems.append(
                Problem(
                    "bad_sidecar_shape",
                    f"{name} is {group[name].shape}, expected per ping "
                    f"or per channel and ping",
                    level,
                )
            )

    return problems
