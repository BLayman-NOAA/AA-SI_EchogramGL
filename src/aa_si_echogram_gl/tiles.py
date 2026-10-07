"""Serving a checkpointed dataset in chunks the viewer can use.

A dataset a recipe step checkpoints is chunked for processing, not for
drawing. A file of Sv from `compute_sv` is one chunk: every channel, every
ping and every sample, about 300 MB compressed for an hour of EK80. The viewer
reads one channel a tile at a time, and zarr reads whole chunks, so each tile
would fetch the whole file.

So the server presents the variable the viewer draws under a chunking of its
own: one channel, 2048 pings and 1024 samples, float32, compressed with zstd.
A source chunk too large to read for each tile is decoded once and held in a
memory budget shared by every mount; anything smaller is read a slab at a
time.

The fix that belongs upstream is to write checkpoints in reasonable chunks.
This makes the viewer usable on the caches that exist.
"""

import json
import os
import threading
from collections import OrderedDict

import numpy as np

from . import describe

LOAD_THRESHOLD = 32 * 2**20
"""Source chunks larger than this are decoded once and held, rather than
decoded again for every tile that touches them."""

MEMORY_ENV = "AA_ECHOGRAM_SERVER_MEMORY"
DEFAULT_MEMORY = 2 * 2**30
"""Bytes of decoded variables held across every mount."""


class Loaded:
    """Decoded variables, least recently used first, within a byte budget."""

    def __init__(self, budget=None):
        self.budget = budget or int(os.environ.get(MEMORY_ENV, DEFAULT_MEMORY))
        self.held = OrderedDict()
        self.lock = threading.Lock()
        self.loading = {}

    def get(self, key, load):
        """The array under key, loading it once however many ask at a time."""
        with self.lock:
            if key in self.held:
                self.held.move_to_end(key)
                return self.held[key]
            event = self.loading.get(key)
            if event is None:
                self.loading[key] = threading.Event()
        if event is not None:
            event.wait()
            return self.get(key, load)
        try:
            values = load()
            with self.lock:
                self.held[key] = values
                self._trim(key)
            return values
        finally:
            with self.lock:
                self.loading.pop(key).set()

    def _trim(self, keep):
        total = sum(values.nbytes for values in self.held.values())
        for key in list(self.held):
            if total <= self.budget or key == keep:
                continue
            total -= self.held.pop(key).nbytes


LOADED = Loaded()


class TileSource:
    """A dataset's drawn variable, served under the viewer's chunking.

    Answers the keys zarr asks for when it opens the variable and reads its
    chunks, and nothing else: the geometry reaches the client in the header.

    Args:
        url: Dataset location.
        storage_options: fsspec options for it.
        var: The variable, or None to choose as `describe` does.
    """

    def __init__(self, url, storage_options=None, var=None):
        self.url = url
        self.ds = describe.open_dataset(url, storage_options)
        self.var = describe.value_var(self.ds, var)
        values = self.ds[self.var]
        self.dims = list(values.dims)
        self.shape = [int(n) for n in values.shape]
        self.chunks = describe.tile_chunks(self.ds, self.var)
        stored = describe.stored_chunks(values)
        self.whole = int(np.prod(stored)) * values.dtype.itemsize > LOAD_THRESHOLD

    def metadata(self):
        """The zarr v2 array metadata the client opens."""
        return {
            "zarr_format": 2,
            "shape": self.shape,
            "chunks": self.chunks,
            "dtype": "<f4",
            "compressor": {"id": "zstd", "level": 1},
            "fill_value": "NaN",
            "order": "C",
            "filters": None,
            "dimension_separator": ".",
        }

    def read(self, key):
        """Bytes for one key, or None where there is nothing there."""
        if key == ".zgroup":
            return json.dumps({"zarr_format": 2}).encode()
        if key == ".zattrs":
            return b"{}"
        name, _, rest = key.partition("/")
        if name != self.var:
            return None
        if rest == ".zarray":
            return json.dumps(self.metadata()).encode()
        if rest == ".zattrs":
            return json.dumps({"_ARRAY_DIMENSIONS": self.dims}).encode()
        try:
            index = [int(part) for part in rest.split(".")]
        except ValueError:
            return None
        if len(index) != len(self.shape):
            return None
        return self.chunk(index)

    def chunk(self, index):
        """One chunk, padded to the full chunk shape as zarr v2 stores edges."""
        import numcodecs

        start = [i * c for i, c in zip(index, self.chunks, strict=True)]
        if any(s >= n for s, n in zip(start, self.shape, strict=True)):
            return None
        stop = [
            min(s + c, n) for s, c, n in zip(start, self.chunks, self.shape, strict=True)
        ]
        region = tuple(slice(s, e) for s, e in zip(start, stop, strict=True))
        if self.whole:
            values = LOADED.get(self.url, self._load)[region]
        else:
            selection = dict(zip(self.dims, region, strict=True))
            values = np.asarray(self.ds[self.var].isel(selection).values, dtype="<f4")
        block = np.full(self.chunks, np.nan, dtype="<f4")
        block[tuple(slice(0, e - s) for s, e in zip(start, stop, strict=True))] = values
        return numcodecs.Zstd(level=1).encode(np.ascontiguousarray(block))

    def _load(self):
        return np.asarray(self.ds[self.var].values, dtype="<f4")

