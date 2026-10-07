"""Recipe ops for the catalog tests: a file list and per file MVBS.

Called by name from the recipes the tests write, so this module has to be
importable from the tests directory.
"""

import numpy as np

from aa_si_echogram_gl import catalog, fixtures

FILES = [
    "gs://bucket/raw/D20160725-T205800.raw",
    "gs://bucket/raw/D20160725-T210800.raw",
    "gs://bucket/raw/D20160725-T211800.raw",
]

PINGS = 12


def file_list():
    """The raw files a survey query would return."""
    return list(FILES)


def file_mvbs(url, bin_s=10):
    """MVBS for one file, starting at the time in its name."""
    start = np.datetime64(catalog.file_time(url), "ns")
    ds = fixtures.synthetic(
        n_pings=PINGS, n_samples=20, gridded=True, gps=False, nodata=False
    )
    times = start + np.arange(PINGS) * np.timedelta64(bin_s, "s")
    return ds.assign_coords(ping_time=times)
