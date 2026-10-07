"""Serve the newest pyramid a recipe wrote to its cache.

Every recipe run that changes a setting writes the pyramid under a new
content-addressed folder, <cache>/<step>/<hash>/<run>/zarr/pyramid.zarr, so the
path to view moves from run to run. This finds the newest computation of the
step with the catalog's cache mode and serves it with the built app.

    python scripts/serve_latest.py --cache gs://bucket/path/user_cache
    python scripts/serve_latest.py --cache gs://bucket/path/user_cache --list

Local cache paths work too. Needs the gcs extra for gs:// caches. The served
app can also find a step itself, from a recipe, through /api/resolve.
"""

import argparse
import sys
from pathlib import Path

from aa_si_echogram_gl import catalog
from aa_si_echogram_gl import serve as serve_module

APP = Path(__file__).resolve().parents[1] / "src" / "aa_si_echogram_gl" / "static"


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--cache", required=True, help="recipe cache root (user_cache_dir)"
    )
    parser.add_argument(
        "--step", default="survey_echogram_store", help="step holding the pyramid"
    )
    parser.add_argument("--port", type=int, default=8129)
    parser.add_argument(
        "--list", action="store_true", help="describe what was found and exit"
    )
    args = parser.parse_args(argv)

    found = catalog.resolve_cache([args.cache], args.step)
    if found["status"] != "found" or found.get("kind") != "pyramid":
        sys.exit(f"no {args.step} pyramid under {args.cache}")
    if args.list:
        print(found["createdAt"], found["store"])
        return
    if not (APP / "index.html").exists():
        sys.exit(f"the app is not built: run `npm run build` in web/ first ({APP})")
    print(f"newest pyramid, written {found['createdAt']}:\n  {found['store']}")
    print(f"open http://127.0.0.1:{args.port}/")
    serve_module.serve(found["store"], str(APP), "127.0.0.1", args.port)


if __name__ == "__main__":
    main()
