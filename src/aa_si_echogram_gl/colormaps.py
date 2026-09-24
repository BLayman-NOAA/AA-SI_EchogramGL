"""Colormap export for the web build.

The viewer has to map a value to the same color the existing matplotlib figures
do, so definitions come from matplotlib rather than being written a second time
in TypeScript. This module writes two JSON files: definitions the web build
imports, and a reference the web test asserts against.
"""

import json

LUT_SIZE = 256
"""Entries per colormap. Matches the length of matplotlib's own table, so the
export is the table itself rather than a resampling of it."""

DEFAULT_NAMES = (
    "viridis",
    "magma",
    "inferno",
    "plasma",
    "jet",
    "turbo",
    "gray",
    # Diverging, for difference layers. A difference is signed and symmetric
    # about zero, and a sequential map hides the sign in a brightness ramp.
    "coolwarm",
    "RdBu",
)

NODATA_COLOR = "#2E2E2E"
"""Masked samples, from `cmap.set_bad()` in AA-SI_Visualization."""

NOISE_COLOR = "#000000"
"""Cluster label -1 in AA-SI_Visualization, deliberately receding."""

CLUSTER_PALETTE = (
    "#00F3FC",
    "#35E200",
    "#0400FF",
    "#F943FF",
    "#F30101",
    "#EDFF4D",
    "#4E9200",
    "#970021",
    "#5600C7",
    "#017685",
    "#FFA600",
)
"""Categorical colors for cluster layers, in the order AA-SI_Visualization
assigns them."""


def to_byte(value):
    """Quantize a 0 to 1 channel the way matplotlib does.

    matplotlib truncates rather than rounds, so matching it keeps viewer pixels
    identical to figure pixels instead of off by one.

    Args:
        value: Channel value in the closed interval 0 to 1.

    Returns:
        int: Byte value.
    """
    return min(int(value * 255), 255)


def definition(name, size=LUT_SIZE):
    """Sample a matplotlib colormap as float RGB triples.

    Values are written at full precision. Rounding them could move one across
    a byte boundary, and the point of the export is that the web build lands on
    the same byte matplotlib does.

    Args:
        name: Registered matplotlib colormap name.
        size: Number of entries.

    Returns:
        list: `size` entries, each a list of three floats.
    """
    import numpy as np
    from matplotlib import colormaps

    colors = colormaps[name](np.linspace(0.0, 1.0, size))[:, :3]
    return [[float(c) for c in row] for row in colors]


def reference(name, size=LUT_SIZE):
    """Sample a matplotlib colormap as bytes, using matplotlib's own conversion.

    Args:
        name: Registered matplotlib colormap name.
        size: Number of entries.

    Returns:
        list: Flat RGBA bytes, four per entry.
    """
    import numpy as np
    from matplotlib import colormaps

    rgba = colormaps[name](np.linspace(0.0, 1.0, size), bytes=True)
    return [int(v) for v in rgba.reshape(-1)]


def export(names=None, size=LUT_SIZE):
    """Build the definitions document.

    Args:
        names: Colormap names, or None for DEFAULT_NAMES.
        size: Entries per colormap.

    Returns:
        dict: Serializable definitions.
    """
    names = tuple(names) if names else DEFAULT_NAMES
    return {
        "version": 1,
        "size": size,
        "source": _source(),
        "nodataColor": NODATA_COLOR,
        "noiseColor": NOISE_COLOR,
        "clusterPalette": list(CLUSTER_PALETTE),
        "continuous": {name: definition(name, size) for name in names},
    }


def export_reference(names=None, size=LUT_SIZE):
    """Build the reference document the web test asserts against.

    Args:
        names: Colormap names, or None for DEFAULT_NAMES.
        size: Entries per colormap.

    Returns:
        dict: Serializable reference bytes.
    """
    names = tuple(names) if names else DEFAULT_NAMES
    return {
        "version": 1,
        "size": size,
        "source": _source(),
        "continuous": {name: reference(name, size) for name in names},
    }


def write(path, document):
    """Write a document as JSON.

    Args:
        path: Destination file path.
        document: Result of export or export_reference.
    """
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=1)
        handle.write("\n")


def _source():
    """Identify the matplotlib that produced an export."""
    import matplotlib

    return f"matplotlib {matplotlib.__version__}"
