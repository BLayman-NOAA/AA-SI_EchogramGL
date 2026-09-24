"""GPU echogram viewer: store builder and control plane.

The pyramid builder is a plain function over an xarray Dataset, so any dataset
from any source can be made viewable without the recipe system being involved.
"""

from .contract import NODATA, NODATA_THRESHOLD, Problem, validate_store
from .pyramid import AlignmentError, build_pyramid

__all__ = [
    "NODATA",
    "NODATA_THRESHOLD",
    "AlignmentError",
    "Problem",
    "build_pyramid",
    "validate_store",
]

__version__ = "0.0.1.dev0"
