"""Command line entry point.

build writes a store from any dataset, validate checks one against the
contract, serve hosts a store and the app from one origin, and colormaps
exports matplotlib definitions for the web build. open mints a token and
launches the browser, and arrives with object storage support.
"""

import argparse
import logging
import sys

import xarray as xr

from . import colormaps as colormaps_module
from . import serve as serve_module
from .contract import validate_store
from .pyramid import build_pyramid


def main(argv=None):
    """Run the command line interface.

    Args:
        argv: Argument list, or None to read from sys.argv.

    Returns:
        int: Process exit code.
    """
    parser = argparse.ArgumentParser(prog="aa-echogram")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="write a viewable store from a dataset")
    build.add_argument("--input", required=True, help="zarr or netCDF dataset")
    build.add_argument("--out", required=True, help="destination store path")
    build.add_argument("--value", default=None, help="value variable name")
    build.add_argument("--range-var", default=None, help="depth or echo_range")
    build.add_argument("--levels", type=int, default=1)
    build.add_argument("--group", default=None, help="group within the input")

    check = sub.add_parser("validate", help="check a store against the contract")
    check.add_argument("path")

    host = sub.add_parser("serve", help="serve a store, and optionally an app")
    host.add_argument("--store", required=True, help="store directory")
    host.add_argument("--app", default=None, help="directory holding a built app")
    host.add_argument("--host", default="127.0.0.1")
    host.add_argument("--port", type=int, default=8000)

    lut = sub.add_parser("colormaps", help="export matplotlib colormaps as JSON")
    lut.add_argument("--out", default="web/src/render/colormaps.json")
    lut.add_argument("--reference", default="web/test/colormaps.reference.json")
    lut.add_argument("--names", nargs="*", default=None)

    later = sub.add_parser("open", help="not implemented until a later milestone")
    later.add_argument("args", nargs="*")

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.command == "build":
        return _build(args)
    if args.command == "validate":
        return _validate(args.path)
    if args.command == "serve":
        return serve_module.serve(args.store, args.app, args.host, args.port)
    if args.command == "colormaps":
        return _colormaps(args)

    print(f"{args.command} is not implemented yet", file=sys.stderr)
    return 2


def _build(args):
    """Open the input dataset and write a store."""
    ds = xr.open_dataset(args.input, group=args.group, engine=None)
    spec = build_pyramid(
        ds,
        args.out,
        value=args.value,
        range_var=args.range_var,
        levels=args.levels,
    )
    print(f"wrote {len(spec['datasets'])} level(s) to {args.out}")
    return _validate(args.out)


def _colormaps(args):
    """Write the colormap definitions and the reference the web test uses."""
    colormaps_module.write(args.out, colormaps_module.export(args.names))
    print(f"wrote {args.out}")
    if args.reference:
        document = colormaps_module.export_reference(args.names)
        colormaps_module.write(args.reference, document)
        print(f"wrote {args.reference}")
    return 0


def _validate(path):
    """Report contract problems for a store."""
    problems = validate_store(path)
    if not problems:
        print(f"{path}: contract satisfied")
        return 0
    for problem in problems:
        print(f"{problem}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
