"""Serve the newest pyramid a recipe wrote to its cache.

Every recipe run that changes a setting writes the pyramid under a new
content-addressed folder, <cache>/<step>/<hash>/<run>/zarr/pyramid.zarr, so the
path to view moves from run to run. This finds the newest one by the time its
checkpoint was written and serves it with the built app.

    python scripts/serve_latest.py --cache gs://bucket/path/user_cache
    python scripts/serve_latest.py --cache gs://bucket/path/user_cache --list

Local cache paths work too. Needs the gcs extra for gs:// caches.
"""

import argparse
import json
import sys
from pathlib import Path

import fsspec

from aa_si_echogram_gl import serve as serve_module

APP = Path(__file__).resolve().parents[1] / "src" / "aa_si_echogram_gl" / "static"


def find_stores(cache, step):
    """Pyramids under a cache for one step, newest first.

    Args:
        cache: Cache root, local path or gs:// URL.
        step: Step id whose checkpoint holds the pyramid.

    Returns:
        list: ``(created_at, store_url)`` tuples, newest first.
    """
    fs, root = fsspec.core.url_to_fs(cache)
    protocol = cache.split("://", 1)[0] + "://" if "://" in cache else ""
    found = []
    for meta_path in fs.glob(f"{root.rstrip('/')}/{step}/*/meta.json"):
        meta = json.loads(fs.cat_file(meta_path))
        folder = meta_path.rsplit("/", 1)[0]
        for output in meta.get("outputs", {}).values():
            path = output.get("path", "")
            if path.endswith("pyramid.zarr"):
                found.append((meta.get("created_at", ""), f"{protocol}{folder}/{path}"))
    return sorted(found, reverse=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", required=True, help="recipe cache root (user_cache_dir)")
    parser.add_argument("--step", default="survey_echogram_store", help="step holding the pyramid")
    parser.add_argument("--port", type=int, default=8129)
    parser.add_argument("--list", action="store_true", help="list the pyramids found and exit")
    args = parser.parse_args(argv)

    stores = find_stores(args.cache, args.step)
    if not stores:
        sys.exit(f"no {args.step} pyramid under {args.cache}")
    if args.list:
        for created, url in stores:
            print(created, url)
        return
    created, url = stores[0]
    if not (APP / "index.html").exists():
        sys.exit(f"the app is not built: run `npm run build` in web/ first ({APP})")
    print(f"newest pyramid, written {created}:\n  {url}\nopen http://127.0.0.1:{args.port}/")
    serve_module.serve(url, str(APP), "127.0.0.1", args.port)


if __name__ == "__main__":
    main()
