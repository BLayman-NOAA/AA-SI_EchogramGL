"""Build a viewer store from an aa-recipe checkpoint.

A stand-in for the milestone 13 `build_echogram_pyramid` op. That op will run
inside the recipe, where the dataset, the platform group and the provenance are
all in hand; this reads the same things back off disk afterwards, so a recipe
that produces a dataset can be viewed today without the recipe knowing about
the viewer.

Three things it does that `aa-echogram build` cannot:

* Resolves a step id to its checkpoint, including a mapped step's per instance
  checkpoints, which it concatenates along the ping axis.
* Builds on `echo_range` rather than `depth`. echo_range is identical for
  every ping and so reduces exactly, while depth carries heave and fails the
  pyramid's alignment check: averaging sample index i across pings that heaved
  averages different depths. The surface reference is not lost, because the
  sidecar keeps depth minus echo_range as the per ping transducer depth and
  the viewer applies it at draw time.
* Reads latitude and longitude from the raw files, since Sv carries no
  position and the EchoData that does is not checkpointed.

Example:
    python scripts/build_viewer_store.py \
        --cache ../AA-SI_recipe_manager/example_recipes/HB2407/recipe_cache \
        --manifest ../AA-SI_recipe_manager/example_recipes/HB2407/outputs/manifest.json \
        --raw ../AA-SI_recipe_manager/example_recipes/HB2407/raw/D20240924-T19*.raw \
        --out stores/hb2407_masked --levels 8
"""

import argparse
import json
import logging
import pathlib
import sys

import numpy as np
import xarray as xr

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "src"))

from aa_si_echogram_gl.contract import validate_store
from aa_si_echogram_gl.pyramid import build_pyramid

logger = logging.getLogger("build_viewer_store")


def find_checkpoints(cache, step, port, run_id=None):
    """Return the checkpoint paths for one step, in instance order.

    Args:
        cache: Recipe cache directory.
        step: Step id to look up.
        port: Output port name within that step.
        run_id: Run to prefer, or None for the most recent one holding the
            step. A step that was a cache hit keeps the run id of the run that
            first computed it, so a pinned run that holds none of a step falls
            back to the newest run that does.

    Returns:
        list: Paths to the stored outputs, ordered by instance index.

    Raises:
        FileNotFoundError: If the step has no checkpoint in the cache.
    """
    metas = []
    for path in sorted(pathlib.Path(cache).glob(f"{step}/*/meta.json")):
        meta = json.loads(path.read_text())
        if port in meta.get("outputs", {}):
            metas.append((path, meta))

    if not metas:
        raise FileNotFoundError(f"no {step}.{port} checkpoint under {cache}")

    runs = {meta["run_id"] for _, meta in metas}
    if run_id not in runs:
        newest = max(runs)
        if run_id is not None:
            logger.info("%s: cached by run %s, not %s", step, newest, run_id)
        run_id = newest
    metas = [(path, meta) for path, meta in metas if meta["run_id"] == run_id]

    metas.sort(key=lambda item: item[1].get("instance_index") or 0)
    return [path.parent / meta["outputs"][port]["path"] for path, meta in metas]


def open_checkpoint(cache, step, port, run_id=None, dim="ping_time"):
    """Open one step's checkpoint, concatenating a mapped step's instances.

    Args:
        cache: Recipe cache directory.
        step: Step id to look up.
        port: Output port name within that step.
        run_id: Run to take, or None for the most recent.
        dim: Dimension the instances are concatenated along.

    Returns:
        xarray.Dataset: The step's output.
    """
    paths = find_checkpoints(cache, step, port, run_id)
    parts = [xr.open_zarr(path) for path in paths]
    logger.info("%s.%s: %d checkpoint(s)", step, port, len(parts))
    if len(parts) == 1:
        return parts[0]
    return xr.concat(parts, dim=dim)


def read_positions(raw_paths, sonar_model, cache=None):
    """Return a dataset of ship positions from the raw files.

    Sv carries no position, and the EchoData that holds the Platform group is
    not checkpointed, so the fixes are read back from the raw files. The result
    keeps the NMEA time dimension; the pyramid matches fixes to pings by
    nearest time itself.

    Args:
        raw_paths: Raw files to read, in any order.
        sonar_model: Sonar model passed to echopype.
        cache: Path to store the positions at, reused on a later run.

    Returns:
        xarray.Dataset: Latitude and longitude over NMEA time, or None if no
            raw files were given.
    """
    if not raw_paths:
        return None

    if cache and pathlib.Path(cache).exists():
        logger.info("positions: reusing %s", cache)
        return xr.open_zarr(cache)

    import echopype as ep

    frames = []
    for path in sorted(raw_paths):
        platform = ep.open_raw(str(path), sonar_model=sonar_model)["Platform"]
        frames.append(platform[["latitude", "longitude"]].load())
        logger.info("positions: %s", pathlib.Path(path).name)

    positions = xr.concat(frames, dim="time1").sortby("time1")
    positions = positions.isel(time1=np.unique(positions["time1"], return_index=True)[1])

    if cache:
        pathlib.Path(cache).parent.mkdir(parents=True, exist_ok=True)
        positions.to_zarr(cache, mode="w")
    return positions


def main(argv=None):
    """Build the store.

    Args:
        argv: Argument list, or None to read from sys.argv.

    Returns:
        int: Process exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", required=True, help="recipe cache directory")
    parser.add_argument("--out", required=True, help="destination store path")
    parser.add_argument("--step", default="apply_mask", help="step to read")
    parser.add_argument("--port", default="ds_Sv", help="output port of that step")
    parser.add_argument("--manifest", default=None, help="run manifest, to pin the run")
    parser.add_argument("--raw", nargs="*", default=[], help="raw files, for positions")
    parser.add_argument("--positions", default=None, help="where to cache positions")
    parser.add_argument("--sonar-model", default="EK80")
    parser.add_argument("--value", default="Sv")
    parser.add_argument("--range-var", default="echo_range")
    parser.add_argument("--levels", type=int, default=8)
    parser.add_argument("--chunks", type=int, nargs=3, default=(1, 2048, 512))

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    run_id = None
    if args.manifest:
        run_id = json.loads(pathlib.Path(args.manifest).read_text())["run_id"]
        logger.info("run %s", run_id)

    ds = open_checkpoint(args.cache, args.step, args.port, run_id)
    logger.info("%s: %s", args.step, dict(ds.sizes))

    finite = int(np.isfinite(ds[args.value]).sum())
    total = int(ds[args.value].size)
    logger.info("kept %d of %d samples (%.1f%%)", finite, total, 100 * finite / total)

    positions = read_positions(args.raw, args.sonar_model, args.positions)

    spec = build_pyramid(
        ds,
        args.out,
        value=args.value,
        range_var=args.range_var,
        levels=args.levels,
        platform=positions,
        chunks=tuple(args.chunks),
    )
    for dataset in spec["datasets"]:
        logger.info("  level %s factor %s", dataset["path"], dataset["factors"]["ping"])

    problems = validate_store(args.out)
    for problem in problems:
        print(problem, file=sys.stderr)
    if not problems:
        print(f"{args.out}: contract satisfied")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
