"""A FastAPI application around the router, for tests and for uvicorn.

    uvicorn aa_si_echogram_gl.server.app:create_app --factory

Serves what `aa-echogram serve` serves: the catalog and mounts, a store under
`/store/` when one is given, and a built app at the root.
"""

import os

from fastapi import FastAPI, HTTPException, Response

from ..serve import (
    STORE_PREFIX,
    Mounts,
    content_type,
    open_source,
    safe_key,
    under,
)
from .routes import build_router, read_key


def create_app(store=None, app_root=None, cache_roots=None, storage_options=None):
    """Build an application serving the catalog, a store and an app.

    Args:
        store: Store directory or URL served under /store/, or None.
        app_root: Directory holding a built web app, served at the root, or
            None.
        cache_roots: Cache roots the catalog may read under, or None for any.
        storage_options: fsspec options for the store and for cache roots.

    Returns:
        FastAPI: The application, with its `Mounts` at `app.state.mounts`.
    """
    app = FastAPI(title="aa-echogram", docs_url=None, redoc_url=None)
    mounts = Mounts(cache_roots)
    app.state.mounts = mounts
    app.include_router(build_router(mounts, storage_options=storage_options))

    if store is not None:
        source = store
        if not hasattr(store, "read"):
            source = open_source(store, storage_options)

        @app.get(STORE_PREFIX + "{key:path}")
        def store_key(key: str) -> Response:
            if not safe_key(key):
                raise HTTPException(404)
            return read_key(lambda: source, key)

    if app_root is not None:
        root = os.path.realpath(str(app_root))

        # Last, so it answers only what no route above does.
        @app.get("/{path:path}")
        def app_file(path: str) -> Response:
            found = under(root, path or "index.html")
            if found is None:
                raise HTTPException(404)
            with open(found, "rb") as handle:
                body = handle.read()
            return Response(body, media_type=content_type(found))

    return app
