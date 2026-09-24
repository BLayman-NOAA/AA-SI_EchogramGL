"""Recipe op tests.

The one that matters is the equivalence: a pyramid built in segments and
concatenated has to be the pyramid built in one pass, not an approximation of
it. Everything else here is about the planner putting the cuts where that holds.
"""

import numpy as np
import pytest
import xarray as xr

from aa_si_echogram_gl import contract, fixtures, ops


def survey(n_pings=600, n_channels=2, n_samples=16):
    return fixtures.synthetic(
        n_channels=n_channels, n_pings=n_pings, n_samples=n_samples
    )


def test_a_pyramid_comes_back_as_a_tree_of_levels():
    tree = ops.build_echogram_pyramid(survey(), levels=4)

    assert sorted(tree.children, key=int) == ["0", "1", "2", "3"]
    spec = tree.attrs["multiscales"][0]
    assert [d["factors"]["ping"] for d in spec["datasets"]] == [1, 2, 4, 8]
    assert tree["0"].to_dataset()[spec["name"]].dims == (
        "channel",
        "ping_time",
        "range_sample",
    )


def test_the_tree_carries_what_the_viewer_reads():
    tree = ops.build_echogram_pyramid(survey(), levels=2)
    spec = tree.attrs["multiscales"][0]

    assert spec["nodata"] == contract.NODATA
    assert spec["aggregation"] == "linear_mean"
    # The geometry the vertex shader positions every quad from.
    level = tree["0"].to_dataset()
    assert level["range_start"].dims == ("channel", "ping_time")
    assert level["range_step"].dims == ("channel", "ping_time")
    assert "0" in tree.attrs[ops.SUMMARIES_ATTR]


def test_a_ping_range_builds_one_segment():
    whole = ops.build_echogram_pyramid(survey(n_pings=600), levels=1)
    part = ops.build_echogram_pyramid(survey(n_pings=600), levels=1,
                                      ping_range=[128, 384])

    assert part["0"].to_dataset().sizes["ping_time"] == 256
    name = whole.attrs["multiscales"][0]["name"]
    np.testing.assert_array_equal(
        part["0"].to_dataset()[name].values,
        whole["0"].to_dataset()[name].values[:, 128:384, :],
    )


def test_a_ping_range_outside_the_data_is_refused():
    with pytest.raises(ValueError, match="outside 0 to"):
        ops.build_echogram_pyramid(survey(n_pings=100), ping_range=[0, 500])
    with pytest.raises(ValueError, match="start, stop"):
        ops.build_echogram_pyramid(survey(n_pings=100), ping_range=7)


class TestPlanning:
    def test_every_range_but_the_last_sits_on_the_grid(self):
        plan = ops.plan_pyramid_segments(survey(n_pings=13320), levels=8,
                                         target_pings=4096)
        ranges, grid = plan["ranges"], plan["grid"]

        assert grid == 128
        assert ranges[0][0] == 0
        assert ranges[-1][1] == 13320
        for start, stop in ranges[:-1]:
            assert (stop - start) % grid == 0
        # And they tile the survey with no gap or overlap.
        for (_, stop), (start, _) in zip(ranges[:-1], ranges[1:]):
            assert stop == start

    def test_a_target_below_the_grid_still_lands_on_it(self):
        plan = ops.plan_pyramid_segments(survey(n_pings=1000), levels=8,
                                         target_pings=10)
        assert plan["ranges"][0][1] % 128 == 0

    def test_a_survey_shorter_than_one_segment_is_one_range(self):
        plan = ops.plan_pyramid_segments(survey(n_pings=300), levels=8)
        assert plan["ranges"] == [[0, 300]]

    def test_a_final_scrap_joins_the_range_before_it(self):
        """Two short segments in a row would put a partial cell in the middle."""
        plan = ops.plan_pyramid_segments(survey(n_pings=4100), levels=8,
                                         target_pings=4096)
        assert plan["ranges"] == [[0, 4100]]

    def test_nonsense_is_refused(self):
        with pytest.raises(ValueError, match="levels"):
            ops.plan_pyramid_segments(survey(), levels=0)
        with pytest.raises(ValueError, match="target_pings"):
            ops.plan_pyramid_segments(survey(), target_pings=0)


class TestMerging:
    def test_segments_rebuild_the_serial_pyramid_exactly(self):
        """The claim the whole parallel form rests on.

        Not close, the same. Interior segments are a multiple of the grid so
        they never pad; the last one pads exactly where a serial build does.
        """
        ds = survey(n_pings=1000, n_channels=2, n_samples=16)
        levels = 4

        serial = ops.build_echogram_pyramid(ds, levels=levels)
        plan = ops.plan_pyramid_segments(ds, levels=levels, target_pings=256)
        assert len(plan["ranges"]) > 2
        parts = [
            ops.build_echogram_pyramid(ds, levels=levels, ping_range=r)
            for r in plan["ranges"]
        ]
        merged = ops.merge_echogram_pyramids(parts)

        name = serial.attrs["multiscales"][0]["name"]
        for level in sorted(serial.children, key=int):
            want = serial[level].to_dataset()
            got = merged[level].to_dataset()
            assert want[name].shape == got[name].shape, f"level {level} shape"
            np.testing.assert_array_equal(
                np.asarray(want[name].values), np.asarray(got[name].values)
            )
            for sidecar in ("range_start", "range_step"):
                np.testing.assert_allclose(
                    np.asarray(want[sidecar].values),
                    np.asarray(got[sidecar].values),
                )

    def test_a_misaligned_split_does_not_reproduce_it(self):
        """The grid is load bearing, so the test says what goes wrong without it.

        Cutting off the grid gives a partial cell in the middle of the survey,
        and every coarse level after it is a different length.
        """
        ds = survey(n_pings=1000, n_channels=1, n_samples=8)
        serial = ops.build_echogram_pyramid(ds, levels=4)
        parts = [
            ops.build_echogram_pyramid(ds, levels=4, ping_range=r)
            for r in ([0, 300], [300, 1000])
        ]
        merged = ops.merge_echogram_pyramids(parts)

        name = serial.attrs["multiscales"][0]["name"]
        assert (
            serial["3"].to_dataset()[name].shape
            != merged["3"].to_dataset()[name].shape
        )

    def test_merging_recomputes_the_summaries_for_the_new_chunk_grid(self):
        ds = survey(n_pings=1000, n_channels=1, n_samples=8)
        plan = ops.plan_pyramid_segments(ds, levels=3, target_pings=256)
        parts = [
            ops.build_echogram_pyramid(ds, levels=3, ping_range=r)
            for r in plan["ranges"]
        ]
        merged = ops.merge_echogram_pyramids(parts)

        found = merged.attrs[ops.SUMMARIES_ATTR]
        assert set(found) == {"0", "1", "2"}
        # Keyed for the merged store rather than carried over from a part,
        # which also means the merged store is chunked the way a serial build
        # would have chunked it and not the way a 256 ping segment was.
        serial = ops.build_echogram_pyramid(ds, levels=3)
        assert set(found["0"]) == set(serial.attrs[ops.SUMMARIES_ATTR]["0"])
        assert (
            merged.attrs["multiscales"][0]["datasets"][0]["chunks"]
            == serial.attrs["multiscales"][0]["datasets"][0]["chunks"]
        )

    def test_one_part_is_returned_as_it_stands(self):
        part = ops.build_echogram_pyramid(survey(n_pings=200), levels=2)
        assert ops.merge_echogram_pyramids([part]) is part

    def test_parts_that_disagree_are_refused(self):
        ds = survey(n_pings=512, n_channels=1, n_samples=8)
        two = ops.build_echogram_pyramid(ds, levels=2, ping_range=[0, 256])
        three = ops.build_echogram_pyramid(ds, levels=3, ping_range=[256, 512])
        with pytest.raises(ValueError, match="same levels"):
            ops.merge_echogram_pyramids([two, three])

    def test_nothing_to_merge_is_refused(self):
        with pytest.raises(ValueError, match="no pyramids"):
            ops.merge_echogram_pyramids([])

    def test_something_that_is_not_a_pyramid_is_refused(self):
        empty = xr.DataTree.from_dict({"/0": xr.Dataset()})
        with pytest.raises(ValueError, match="not a pyramid"):
            ops.merge_echogram_pyramids([empty, empty])
