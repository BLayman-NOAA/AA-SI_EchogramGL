"""A recipe cache written once and copied per test, shared by the catalog and
router tests through conftest.py.

`index_dir` is not autouse, so only the modules that ask for it with
`pytestmark` keep their indexes out of the user's cache.
"""

import json
import shutil
import time

import pytest
import zarr
from recipe_ops import FILES, file_mvbs

from aa_si_echogram_gl import catalog, fixtures, ops

OLD = {"fingerprint": {"params": {"bin_s": 20}}, "parents": [], "epoch": None}
NEW = {"fingerprint": {"params": {"bin_s": 10}}, "parents": [], "epoch": None}


@pytest.fixture
def index_dir(tmp_path, monkeypatch):
    """Keep indexes and headers out of the user's cache."""
    monkeypatch.setenv("AA_ECHOGRAM_CACHE", str(tmp_path / "index"))


def write_entry(root, step, key, output, form, payload, created,
                instance=None, item=None):
    """Write a cache entry's sidecar and return its run directory."""
    directory = root / step / key[: catalog.HASH_PREFIX]
    directory.mkdir(parents=True)
    meta = {
        "step_id": step,
        "step_hash": key,
        "run_id": "run1",
        "created_at": created,
        "outputs": {output: {"path": f"run1/zarr/{output}.zarr", "format": form}},
        "fingerprint_payload": payload,
        "instance_index": instance,
        "instance_discriminator": {"item": item} if item else None,
    }
    (directory / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return directory / "run1" / "zarr" / f"{output}.zarr"


def key(text):
    return f"{text:0<64}"


def write_zarr(value, path, attempts=10, **options):
    """Write a store, retrying the rename Windows sometimes refuses.

    zarr writes metadata to a temporary file and renames it into place, and on
    Windows a scanner holding the new file makes the rename fail with access
    denied. The recipe manager's own writer retries for the same reason.
    """
    for attempt in range(attempts):
        try:
            return value.to_zarr(path, zarr_format=2, **options)
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.3 * (attempt + 1))
            # The failed attempt left part of a store, which the default mode
            # refuses to write over.
            options.setdefault("mode", "w")


@pytest.fixture(scope="session")
def template(tmp_path_factory):
    """A cache holding two computations of a mapped step, a pyramid and a pickle.

    Written once for the session and copied for each test, since writing zarr
    is the slow part and the part that can be refused.
    """
    root = tmp_path_factory.mktemp("template") / "cache"
    for index, url in enumerate(FILES[:2]):
        path = write_entry(root, "file_mvbs", key(f"a{index}"), "ds_MVBS", "zarr",
                           OLD, "2026-01-01T00:00:00", index, url)
        ds = file_mvbs(url, bin_s=20)
        write_zarr(ds, path, mode="w", consolidated=True)
    for index, url in enumerate(FILES):
        path = write_entry(root, "file_mvbs", key(f"b{index}"), "ds_MVBS", "zarr",
                           NEW, f"2026-02-0{index + 1}T00:00:00", index, url)
        ds = file_mvbs(url)
        write_zarr(ds, path, mode="w", consolidated=True)

    tree = ops.build_echogram_pyramid(
        fixtures.synthetic(n_pings=32, n_samples=12, gridded=True, gps=False),
        levels=2,
        range_var="depth",
    )
    path = write_entry(root, "store", key("c"), "pyramid", "zarr_tree",
                       NEW, "2026-02-01T00:00:00")
    # Consolidated once at the end, as the checkpoint writer does. Consolidating
    # per node renames the same file once per level.
    write_zarr(tree, path, mode="w", consolidated=False)
    zarr.consolidate_metadata(str(path), zarr_format=2)

    write_entry(root, "model", key("d"), "fit", "pickle", NEW, "2026-02-01T00:00:00")
    return root


@pytest.fixture
def cache(template, tmp_path):
    """A copy of the template cache that a test may add to."""
    root = tmp_path / "cache"
    shutil.copytree(template, root)
    return root


