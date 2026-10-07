"""Finding what a recipe step left in a cache.

Two ways in. Recipe mode is the one meant to last: a recipe and a step id
name a checkpoint, because the recipe's current parameters hash to it, and the
recipe manager computes that hash without running anything. Cache mode takes
cache roots and a step id and returns the newest computation of that step, for
when no recipe is to hand.

A step that is not fanned out has one entry, at `<root>/<step>/<hash[:8]>`. A
mapped or swept step has one entry per instance, each under its own hash, and
every one of them records the step's fingerprint payload. Instances of one
computation are therefore the entries whose payload is the step's, whichever
run wrote them: a run that reused most instances leaves them with older run
ids, so the run id cannot be used.

The user tier is read before the survey tier, the order a run reads them, and
a run's instances can be split between the two.
"""

import hashlib
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

META_FILENAME = "meta.json"
HASH_PREFIX = 8
"""Characters of a step hash in its entry directory name, as the recipe
manager writes it."""

INDEX_THREADS = 16

CONFIG_FILENAME = "aa-recipe.config.yaml"
CONFIG_ENV = "AA_RECIPE_CONFIG"
DEFAULT_CACHE_DIR = "recipe_cache"

UNSUPPORTED = {
    "pickle": "a pickled output, which only Python can read",
    "netcdf": "netCDF, which the viewer does not read; checkpoint the step as zarr",
    "netcdf_da": "netCDF, which the viewer does not read; checkpoint the step as zarr",
    "echodata_zarr": "EchoData, which is raw data; view a step that computes Sv",
    "json": "a value rather than an array",
}

FILE_TIME = re.compile(r"D(\d{8})-T(\d{6})")
"""Start time in an echosounder file name, such as D20160725-T205800.raw."""


class CatalogError(ValueError):
    """Raised when a request cannot be resolved, with what to do about it."""


@dataclass(frozen=True)
class RunDefaults:
    """What a run config supplies when there is no run config."""

    user_cache_dir: str | None = None
    survey_cache_dir: str | None = None
    storage_options: dict | None = None
    inputs: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Tier:
    """One cache root, named as the recipe manager names it."""

    name: str
    root: str


@dataclass(frozen=True)
class Entry:
    """One cache entry: where it is and what its sidecar says."""

    tier: str
    directory: str
    meta: dict

    def artifact(self, output):
        """Location of one of this entry's outputs."""
        path = self.meta["outputs"][output]["path"]
        if "://" in path or os.path.isabs(path):
            return path
        return f"{self.directory}/{path}"


def step_directory(step):
    """The directory name a step's entries live under."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", step) or "_"


def filesystem(url, storage_options=None):
    """An fsspec filesystem and path for a local path or URL."""
    import fsspec

    return fsspec.core.url_to_fs(url, **(storage_options or {}))


def join(root, *parts):
    """Join a root and parts with forward slashes, as fsspec spells paths."""
    return "/".join([root.rstrip("/"), *parts])


def full(fs, path):
    """A path as a URL the server can open again."""
    protocol = fs.protocol[0] if isinstance(fs.protocol, (list, tuple)) else fs.protocol
    if protocol in ("file", "local"):
        return path
    return f"{protocol}://{path}"


def read_entries(tier, step, storage_options=None):
    """Every entry of a step in one tier.

    The sidecars are read in one batched call, which matters for a mapped step
    with thousands of instances in a bucket.
    """
    fs, root = filesystem(tier.root, storage_options)
    pattern = join(root, step_directory(step), "*", META_FILENAME)
    paths = sorted(fs.glob(pattern))
    if not paths:
        return []
    found = fs.cat(paths)
    entries = []
    for path in paths:
        meta = json.loads(found[path])
        directory = full(fs, path.rsplit("/", 1)[0])
        entries.append(Entry(tier.name, directory, meta))
    return entries


def read_entry(tier, step, step_hash, storage_options=None):
    """The entry at a step hash in one tier, or None."""
    fs, root = filesystem(tier.root, storage_options)
    directory = join(root, step_directory(step), step_hash[:HASH_PREFIX])
    path = join(directory, META_FILENAME)
    try:
        meta = json.loads(fs.cat_file(path))
    except FileNotFoundError:
        return None
    if meta.get("step_hash") != step_hash:
        return None
    return Entry(tier.name, full(fs, directory), meta)


def find_config(recipe):
    """The run config a recipe would be run with, searched from the recipe.

    The same files `aa-recipe` looks for, except that the working directory is
    replaced by the recipe's directory and its parents: a server is not run
    from where the recipe was.
    """
    env = os.environ.get(CONFIG_ENV)
    if env:
        return Path(env)
    recipe = Path(recipe).resolve()
    beside = recipe.with_name(f"{recipe.stem}.config.yaml")
    if beside.is_file():
        return beside
    for folder in [recipe.parent, *recipe.parent.parents]:
        candidate = folder / CONFIG_FILENAME
        if candidate.is_file():
            return candidate
    home = Path.home() / ".config" / "aa-recipe" / "config.yaml"
    return home if home.is_file() else None


def recipe_tiers(recipe, config=None, user_cache=None, survey_cache=None):
    """Cache tiers, storage options and config inputs for a recipe.

    Relative cache paths are taken from the config file's directory, or the
    recipe's where there is no config, standing in for the directory the run
    was started from.

    Returns:
        tuple: (tiers, storage_options, inputs).
    """
    from aa_recipe_manager.config import load_run_config

    path = Path(config) if config else find_config(recipe)
    run_config = load_run_config(path) if path else None
    base = (path or Path(recipe).resolve()).parent

    def place(value):
        if value is None or "://" in value or os.path.isabs(value):
            return value
        return str((base / value).resolve())

    configured = run_config or RunDefaults()
    user = place(user_cache or configured.user_cache_dir or DEFAULT_CACHE_DIR)
    survey = place(survey_cache or configured.survey_cache_dir)
    tiers = [Tier("user", user)]
    if survey:
        tiers.append(Tier("survey", survey))
    return tiers, configured.storage_options or None, dict(configured.inputs)


def resolve_recipe(recipe, step, inputs=None, config=None, output=None,
                   window=None, user_cache=None, survey_cache=None):
    """The checkpoint a recipe's current parameters name for one step.

    Args:
        recipe: Path to the recipe file.
        step: Step id.
        inputs: Pipeline inputs, over the config's.
        config: Run config path, or None to find one.
        output: Output name, or None for the first one that can be drawn.
        window: Optional (start, end) in nanoseconds since 1970, limiting
            the instances of a fanned out step.
        user_cache, survey_cache: Cache roots in place of the config's.

    Returns:
        dict: The resolution; see `resolution`.

    Raises:
        CatalogError: If the recipe manager is not importable or the step is
            not in the recipe.
    """
    try:
        from aa_recipe_manager import api
    except ImportError as error:
        raise CatalogError(
            "resolving a recipe needs aa_recipe_manager in the server's "
            "environment; run aa-echogram serve from the recipe manager's venv"
        ) from error

    caches = (user_cache, survey_cache)
    tiers, options, config_inputs = recipe_tiers(recipe, config, *caches)
    merged = {**config_inputs, **(inputs or {})}
    hashes = api.step_hashes(recipe, inputs=merged or None, storage_options=options)
    if step not in hashes:
        raise CatalogError(
            f"no step {step!r} in {recipe}; steps are {', '.join(hashes)}"
        )
    identity = hashes[step]

    payload = identity.payload
    if identity.fanned_out:
        candidates = [e for tier in tiers for e in read_entries(tier, step, options)]
        matched = _first_per_hash(
            e for e in candidates if e.meta.get("fingerprint_payload") == payload
        )
    else:
        candidates = None
        entry = None
        for tier in tiers:
            entry = read_entry(tier, step, identity.step_hash, options)
            if entry:
                break
        matched = [entry] if entry else []

    result = {
        "mode": "recipe",
        "recipe": str(recipe),
        "step": step,
        "stepHash": identity.step_hash,
        "fannedOut": identity.fanned_out,
        "tiers": {tier.name: tier.root for tier in tiers},
    }
    if matched:
        found = resolution(matched, identity.fanned_out, output, window, options)
        return {**result, **found}

    if candidates is None:
        candidates = [e for tier in tiers for e in read_entries(tier, step, options)]
    result["status"] = "not_run" if candidates else "never_run"
    if candidates:
        nearest = max(candidates, key=lambda e: e.meta.get("created_at") or "")
        stored = nearest.meta.get("fingerprint_payload")
        result["nearest"] = _describe_entry(nearest)
        result["differences"] = (
            api.fingerprint_differences(stored, identity.payload) if stored else []
        )
    return result


def resolve_cache(roots, step, output=None, window=None, storage_options=None):
    """The newest computation of a step in some cache roots.

    Entries are grouped by fingerprint payload, which is one group per
    computation, and the group holding the newest entry wins.

    Args:
        roots: Cache roots, user tier first.
        step: Step id.
        output, window: As for `resolve_recipe`.
        storage_options: fsspec options for the roots.

    Returns:
        dict: The resolution; see `resolution`.
    """
    tiers = [Tier(f"root{index}", root) for index, root in enumerate(roots)]
    entries = [e for tier in tiers for e in read_entries(tier, step, storage_options)]
    result = {
        "mode": "cache",
        "step": step,
        "tiers": {tier.name: tier.root for tier in tiers},
    }
    if not entries:
        return {**result, "status": "never_run"}

    groups = {}
    for entry in entries:
        key = json.dumps(entry.meta.get("fingerprint_payload"), sort_keys=True)
        groups.setdefault(key, []).append(entry)
    newest = max(
        groups.values(),
        key=lambda group: max(e.meta.get("created_at") or "" for e in group),
    )
    fanned_out = any(e.meta.get("instance_discriminator") for e in newest)
    if not fanned_out:
        newest = [max(newest, key=lambda e: e.meta.get("created_at") or "")]
    entries = _first_per_hash(newest)
    found = resolution(entries, fanned_out, output, window, storage_options)
    return {**result, "fannedOut": fanned_out, **found}


def open_path(path, storage_options=None):
    """What is at a path: a pyramid, or a dataset to draw as one piece.

    For a store or dataset named by where it is rather than by the recipe
    step that wrote it. Answers in the shape `resolve_recipe` does, so a
    client opens either the same way.

    Raises:
        LookupError: If there is nothing at the path.
    """
    fs, root = filesystem(path, storage_options)
    if not fs.exists(root):
        raise LookupError(f"nothing at {path}")
    name = path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    found = {"mode": "path", "step": name, "status": "found", "outputs": []}
    if _is_pyramid(path, storage_options):
        return {**found, "kind": "pyramid", "store": path}

    stamp = _path_stamp(fs, root)
    try:
        record = cached("index", path, lambda: _index(path, storage_options), stamp)
    except Exception as error:
        raise CatalogError(
            f"{path} is not a dataset the viewer can draw: {error}"
        ) from error
    instance = {
        "id": hashlib.sha1(path.encode()).hexdigest(),
        "item": name,
        "index": 0,
        "store": path,
        "tier": "path",
        "stamp": stamp,
        **record,
    }
    return {
        **found,
        "kind": "dataset",
        "instances": [instance],
        "bytes": record.get("bytes") or 0,
    }


def _path_stamp(fs, root):
    """When a store at a path was last written, for keying what is cached."""
    for name in (".zmetadata", "zarr.json", ".zgroup", ""):
        try:
            info = fs.info(join(root, name) if name else root)
        except (FileNotFoundError, OSError):
            continue
        for key in ("mtime", "updated", "LastModified", "created"):
            if info.get(key):
                return str(info[key])
    return ""


def resolution(entries, fanned_out, output=None, window=None, storage_options=None):
    """What the client needs to draw a set of matched entries.

    Every output is listed with whether it can be drawn. A pyramid output is
    returned as one store to open. A dataset output is returned as instances,
    one per entry, each placed in time, which is what lets a mapped step be
    laid out before any of it is read.

    Returns:
        dict: status, outputs, output, kind, and either store or instances.
    """
    first = entries[0]
    names = list(first.meta["outputs"])
    outputs = [_output_kind(first, name, storage_options) for name in names]
    drawable = [item for item in outputs if item["kind"]]
    if output is None:
        chosen = drawable[0]["name"] if drawable else None
    else:
        if output not in first.meta["outputs"]:
            raise CatalogError(
                f"no output {output!r}; outputs are {', '.join(first.meta['outputs'])}"
            )
        chosen = output
    result = {
        "status": "found",
        "outputs": outputs,
        "output": chosen,
        "createdAt": max(e.meta.get("created_at") or "" for e in entries),
        "entries": len(entries),
    }
    kind = next((item["kind"] for item in outputs if item["name"] == chosen), None)
    result["kind"] = kind
    if not kind:
        return result
    if kind == "pyramid":
        result["store"] = first.artifact(chosen)
        return result

    ordered = sorted(entries, key=lambda e: (e.meta.get("instance_index") or 0))
    if window and fanned_out:
        ordered = _near_window(ordered, window)
    instances, skipped = index_instances(ordered, chosen, storage_options)
    if window:
        instances = [i for i in instances if _overlaps(i, window)]
    if not instances and skipped:
        result["kind"] = None
    result["instances"] = instances
    result["skipped"] = skipped
    result["bytes"] = sum(i.get("bytes") or 0 for i in instances)
    return result


def index_instances(entries, output, storage_options=None):
    """Place each entry's dataset in time, reading as little as possible.

    The first and last ping, the shape, the value variable and the stored size
    are what laying an instance out needs. They are cached on disk by the
    artifact's location and when its entry was written, so a step already
    indexed costs nothing the second time.

    An instance that cannot be indexed, an empty file or one missing its
    output, is reported rather than allowed to fail the thousands beside it.

    Returns:
        tuple: (instances, skipped), each a list of records.
    """

    def one(entry):
        url = entry.artifact(output)
        discriminator = entry.meta.get("instance_discriminator") or {}
        named = {
            "id": entry.meta["step_hash"],
            "item": discriminator.get("item"),
            "index": entry.meta.get("instance_index"),
            "store": url,
            "tier": entry.tier,
            "stamp": stamp_of(entry),
        }
        try:
            record = cached(
                "index", url, lambda: _index(url, storage_options), named["stamp"]
            )
        except Exception as error:  # noqa: BLE001 - reported per instance
            return {**named, "error": f"{type(error).__name__}: {error}"}
        return {**named, **record}

    with ThreadPoolExecutor(max_workers=INDEX_THREADS) as pool:
        records = list(pool.map(one, entries))
    instances = [record for record in records if "error" not in record]
    skipped = [record for record in records if "error" in record]
    return instances, skipped


def stamp_of(entry):
    """What distinguishes one writing of an entry from another at its path."""
    return f"{entry.meta.get('run_id')}@{entry.meta.get('created_at')}"


def _index(url, storage_options):
    """Time span, shape and size of one dataset."""
    from . import describe

    ds = describe.open_dataset(url, storage_options)
    var = describe.value_var(ds)
    channels, samples = describe.extent(ds, var)
    times = ds["ping_time"].values
    if not len(times):
        raise ValueError("it holds no pings")
    fs, path = filesystem(url, storage_options)
    try:
        size = int(fs.du(join(path, var)))
    except (FileNotFoundError, OSError):
        size = None
    return {
        "var": var,
        "dims": list(ds[var].dims),
        "shape": [int(n) for n in ds[var].shape],
        "start": int(times[0].astype("datetime64[ns]").astype("int64")),
        "end": int(times[-1].astype("datetime64[ns]").astype("int64")),
        "pings": int(ds.sizes["ping_time"]),
        "channels": channels,
        "samples": samples,
        "bytes": size,
    }


def cache_dir():
    """Where indexes and descriptions are kept between runs of the server."""
    root = os.environ.get("AA_ECHOGRAM_CACHE")
    path = Path(root) if root else Path.home() / ".cache" / "aa-echogram"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cached(kind, url, compute, stamp=""):
    """Return a JSON record for a location, computing it once.

    Keyed by the location and a stamp of when it was written, so a store
    written again at the same path, as a forced rerun can, is read afresh. The
    record is written to a temporary file and moved into place, so a server
    stopped halfway leaves nothing half written, and one that cannot be read
    is computed again. A failure is not recorded.
    """
    import uuid

    key = hashlib.sha1(f"{url}|{stamp}".encode()).hexdigest()
    path = cache_dir() / f"{kind}-{key}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    record = compute()
    partial = path.with_name(f"{path.name}.{uuid.uuid4().hex}.partial")
    partial.write_text(json.dumps(record), encoding="utf-8")
    try:
        os.replace(partial, path)
    except OSError:
        # Another thread put the same record in place first.
        partial.unlink(missing_ok=True)
    return record


def _output_kind(entry, name, storage_options):
    """Whether one output can be drawn, and as what."""
    found = entry.meta["outputs"][name]
    form = found.get("format", "")
    if form in UNSUPPORTED:
        return {"name": name, "format": form, "kind": None, "reason": UNSUPPORTED[form]}
    if form == "zarr_tree":
        if _is_pyramid(entry.artifact(name), storage_options):
            return {"name": name, "format": form, "kind": "pyramid"}
        return {
            "name": name,
            "format": form,
            "kind": None,
            "reason": "a tree of datasets that is not an echogram pyramid",
        }
    if form.startswith("zarr"):
        return {"name": name, "format": form, "kind": "dataset"}
    return {"name": name, "format": form, "kind": None, "reason": f"format {form!r}"}


def _is_pyramid(url, storage_options):
    """Whether a zarr group carries the multiscales attribute."""
    fs, path = filesystem(url, storage_options)
    for name in (".zattrs", "zarr.json"):
        try:
            attrs = json.loads(fs.cat_file(join(path, name)))
        except FileNotFoundError:
            continue
        attrs = attrs.get("attributes", attrs)
        return "multiscales" in attrs
    return False


def _first_per_hash(entries):
    """One entry per instance hash, the first tier's where both hold it."""
    seen = set()
    kept = []
    for entry in entries:
        key = entry.meta.get("step_hash")
        if key in seen:
            continue
        seen.add(key)
        kept.append(entry)
    return kept


def _describe_entry(entry):
    return {
        "tier": entry.tier,
        "createdAt": entry.meta.get("created_at"),
        "runId": entry.meta.get("run_id"),
        "stepHash": entry.meta.get("step_hash"),
    }


def _overlaps(instance, window):
    start, end = window
    return instance["end"] >= start and instance["start"] <= end


def file_time(item):
    """Nanoseconds since 1970 at the start of a file, from its name, or None."""
    if not isinstance(item, str):
        return None
    found = FILE_TIME.search(item.rsplit("/", 1)[-1])
    if not found:
        return None
    stamp = np.datetime64(
        f"{found[1][:4]}-{found[1][4:6]}-{found[1][6:]}T"
        f"{found[2][:2]}:{found[2][2:4]}:{found[2][4:]}",
        "ns",
    )
    return int(stamp.astype("int64"))


def _near_window(entries, window):
    """Entries whose file could reach into a window, judged by file names.

    Indexing reads every instance, which for a survey is thousands of
    datasets. Echosounder files are named for their start time, so the files
    that can reach a window are those starting before its end whose successor
    starts after its start. Entries whose names carry no time are kept.
    """
    timed = [(file_time((e.meta.get("instance_discriminator") or {}).get("item")), e)
             for e in entries]
    if any(start is None for start, _ in timed):
        return entries
    timed.sort(key=lambda pair: pair[0])
    start, end = window
    kept = []
    for position, (begins, entry) in enumerate(timed):
        following = timed[position + 1][0] if position + 1 < len(timed) else None
        if begins <= end and (following is None or following >= start):
            kept.append(entry)
    return kept
