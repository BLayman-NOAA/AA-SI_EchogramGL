"""Per chunk summaries written alongside a level.

Two uses, both worth the negligible build cost. A chunk marked allNodata is
never requested by the client, which for seafloor masked data skips a large
share of the array below the bottom. Min, max and a coarse histogram let the
client set display limits at overview zoom from metadata alone, before any
sample data has arrived.
"""

import numpy as np

HIST_RANGE = (-120.0, 0.0)
"""Fixed dB range so histograms from different chunks are summable."""

HIST_BINS = 32


def summarize_level(values, chunks, nodata_threshold):
    """Summarize every chunk of one level.

    Args:
        values: Array shaped (channel, ping, sample) holding sentinel nodata.
        chunks: Chunk shape as a three tuple.
        nodata_threshold: Values at or below this are nodata.

    Returns:
        dict: Keys are 'c.p.s' chunk coordinates, values are per chunk summaries.
    """
    out = {}
    grid = [
        range(0, values.shape[axis], chunks[axis])
        for axis in range(3)
    ]
    for ci, c0 in enumerate(grid[0]):
        for pi, p0 in enumerate(grid[1]):
            for si, s0 in enumerate(grid[2]):
                block = values[
                    c0:c0 + chunks[0],
                    p0:p0 + chunks[1],
                    s0:s0 + chunks[2],
                ]
                out[f"{ci}.{pi}.{si}"] = summarize_chunk(block, nodata_threshold)
    return out


def summarize_chunk(block, nodata_threshold):
    """Summarize one chunk.

    Args:
        block: Array slice holding sentinel nodata.
        nodata_threshold: Values at or below this are nodata.

    Returns:
        dict: Either {'allNodata': True} or min, max and histogram counts.
    """
    data = np.asarray(block, dtype="float32")
    valid = data > nodata_threshold
    if not valid.any():
        return {"allNodata": True}

    present = data[valid]
    counts, _ = np.histogram(present, bins=HIST_BINS, range=HIST_RANGE)
    return {
        "allNodata": False,
        "min": float(present.min()),
        "max": float(present.max()),
        "count": int(valid.sum()),
        "hist": counts.astype("int64").tolist(),
    }


def nodata_fraction(summaries):
    """Return the share of chunks that are entirely nodata.

    Useful as a measurement rather than as a check: it sets expectations for how
    much skipping those chunks actually saves on a seafloor masked survey.

    Args:
        summaries: Mapping produced by summarize_level.

    Returns:
        float: Between 0 and 1.
    """
    if not summaries:
        return 0.0
    empty = sum(1 for entry in summaries.values() if entry.get("allNodata"))
    return empty / len(summaries)
