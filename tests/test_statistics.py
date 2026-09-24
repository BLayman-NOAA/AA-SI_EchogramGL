"""The Python side of the region statistics comparison.

NFR-9 asks that region statistics match the same computation performed in
Python on the resolved slice. There was no NASC anywhere in the codebase to
match, so this is the reference rather than a check against one: it states the
definition, and the viewer's arithmetic is asserted against these numbers in
web/test/statistics.test.ts.

That is a weaker guarantee than matching an implementation the science already
trusts, and it is worth saying so. What it does rule out is the two drifting
apart, and the mean being taken in the wrong space.
"""

import numpy as np

from aa_si_echogram_gl import contract, fixtures, pyramid

METRES_PER_NAUTICAL_MILE = 1852


def region_statistics(sv, range_step, pings):
    """Mean linear Sv in decibels and NASC over a slice of an Sv array.

    Args:
        sv: Sv in decibels, with nodata already removed.
        range_step: Metres per sample, one per counted sample.
        pings: Pings the region spans, which the depth integral is averaged over.

    Returns:
        dict: count, mean_sv and nasc.
    """
    # float64 first. A store holds Sv as float16, and 10 ** (-80 / 10) is 1e-8,
    # which is below float16's smallest subnormal of about 6e-8: converting in
    # the stored dtype rounds every sample to zero and the mean comes out as
    # negative infinity. The shader has no such problem, since it converts in
    # f32, but anything comparing against it does.
    linear = 10 ** (np.asarray(sv, dtype="float64") / 10)
    if not linear.size:
        return {"count": 0, "mean_sv": None, "nasc": None}
    area_scattering = float((linear * range_step).sum()) / pings
    return {
        "count": int(linear.size),
        "mean_sv": float(10 * np.log10(linear.mean())),
        "nasc": 4 * np.pi * METRES_PER_NAUTICAL_MILE**2 * area_scattering,
    }


def test_mean_is_taken_in_linear_space():
    """The mean of decibels is a different and wrong quantity, per NFR-8."""
    sv = np.array([-60.0, -40.0])
    found = region_statistics(sv, np.full(2, 0.19), pings=1)

    assert found["mean_sv"] == float(np.float64(-42.96708621881338))
    assert found["mean_sv"] != sv.mean()


def test_nasc_is_the_depth_integral_averaged_over_pings():
    sv = np.full(8, -50.0)
    step = np.full(8, 0.19)
    found = region_statistics(sv, step, pings=4)

    expected = 4 * np.pi * 1852**2 * (10 ** (-5.0) * 0.19 * 8) / 4
    assert np.isclose(found["nasc"], expected)


def test_nodata_is_excluded_before_the_mean():
    """The sentinel is not a value, and averaging it in would drag every mean
    towards minus ten thousand."""
    values = np.array([-60.0, contract.NODATA, -40.0])
    kept = values[values > contract.NODATA_THRESHOLD]
    found = region_statistics(kept, np.full(kept.size, 0.19), pings=1)

    assert found["count"] == 2
    assert found["mean_sv"] > -50


def test_a_built_store_reduces_to_the_same_numbers(tmp_path):
    """The reference, run over a real store's level zero.

    Not a GPU comparison: it fixes what the viewer's compute pass has to agree
    with once the readback harness exists, over data the fixture builder and
    the browser can both read.
    """
    ds = fixtures.synthetic(n_channels=1, n_pings=16, n_samples=32)
    spec = pyramid.build_pyramid(ds, tmp_path / "store", levels=1)
    assert not contract.validate_store(tmp_path / "store")

    import zarr

    root = zarr.open_group(str(tmp_path / "store"), mode="r")
    values = np.asarray(root["0"][spec["name"]][0])
    steps = np.asarray(root["0"]["range_step"][0])

    kept = values > contract.NODATA_THRESHOLD
    step_per_sample = np.broadcast_to(steps[:, None], values.shape)
    found = region_statistics(values[kept], step_per_sample[kept], pings=values.shape[0])

    assert found["count"] == int(kept.sum())
    assert -100 < found["mean_sv"] < 0
    assert found["nasc"] > 0


def test_linear_conversion_needs_more_than_the_stored_precision():
    """The trap the store's own dtype sets.

    Sv is stored as float16, and the linear value of a quiet sample is below
    what float16 can hold at all. Converting before widening turns the whole
    region into zeros.
    """
    stored = np.float16(-80.0)
    assert 10 ** (stored / 10) == 0
    assert 10 ** (np.float64(stored) / 10) > 0
