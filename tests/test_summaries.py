"""Per chunk summary tests."""

import numpy as np

from aa_si_echogram_gl import contract, summaries


def test_all_nodata_chunk_flagged():
    """A chunk marked allNodata is never requested by the client, which for
    seafloor masked data skips a large share of the array below the bottom."""
    block = np.full((1, 4, 4), contract.NODATA, dtype="float32")
    result = summaries.summarize_chunk(block, contract.NODATA_THRESHOLD)
    assert result == {"allNodata": True}


def test_partial_chunk_reports_range():
    block = np.full((1, 4, 4), contract.NODATA, dtype="float32")
    block[0, 0, 0] = -70.0
    block[0, 1, 1] = -50.0

    result = summaries.summarize_chunk(block, contract.NODATA_THRESHOLD)

    assert result["allNodata"] is False
    assert result["min"] == -70.0
    assert result["max"] == -50.0
    assert result["count"] == 2


def test_histogram_counts_only_valid_samples():
    block = np.full((1, 8, 8), contract.NODATA, dtype="float32")
    block[0, :, :4] = -60.0

    result = summaries.summarize_chunk(block, contract.NODATA_THRESHOLD)

    assert sum(result["hist"]) == result["count"] == 32


def test_histogram_bins_are_comparable_across_chunks():
    """A fixed dB range means histograms from different chunks are summable,
    which is what makes auto contrast from metadata possible."""
    low = np.full((1, 2, 2), -100.0, dtype="float32")
    high = np.full((1, 2, 2), -20.0, dtype="float32")

    a = summaries.summarize_chunk(low, contract.NODATA_THRESHOLD)
    b = summaries.summarize_chunk(high, contract.NODATA_THRESHOLD)

    assert np.argmax(a["hist"]) < np.argmax(b["hist"])
    assert len(a["hist"]) == len(b["hist"]) == summaries.HIST_BINS


def test_level_summary_covers_every_chunk():
    values = np.full((2, 8, 6), -60.0, dtype="float32")
    result = summaries.summarize_level(values, (1, 4, 3), contract.NODATA_THRESHOLD)

    assert len(result) == 2 * 2 * 2
    assert set(result) == {
        f"{c}.{p}.{s}" for c in range(2) for p in range(2) for s in range(2)
    }


def test_nodata_fraction():
    values = np.full((1, 4, 4), contract.NODATA, dtype="float32")
    values[0, :2, :2] = -60.0
    result = summaries.summarize_level(values, (1, 2, 2), contract.NODATA_THRESHOLD)

    assert summaries.nodata_fraction(result) == 0.75
