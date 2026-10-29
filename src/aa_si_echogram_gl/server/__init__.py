"""The catalog and data routes for a FastAPI host.

`build_router` is the server core: a host such as the recipe manager's client
server includes it under a prefix of its own and registers the folders it may
read with `Mounts.allow`. `create_app` wraps it in an application of its own,
for tests and for running under uvicorn. `aa-echogram serve` does not use
either; it serves the same routes on the standard library.

Needs FastAPI, the `server` extra.
"""

try:
    import fastapi  # noqa: F401
except ImportError as error:  # pragma: no cover - depends on the install
    raise ImportError(
        "the echogram router needs FastAPI: pip install 'aa-si-echogram-gl[server]'"
    ) from error

from .app import create_app  # noqa: E402
from .routes import build_router  # noqa: E402

__all__ = ["build_router", "create_app"]
