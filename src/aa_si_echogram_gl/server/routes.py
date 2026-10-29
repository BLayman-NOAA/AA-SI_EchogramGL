"""The catalog and data routes as a FastAPI router.

The same requests `aa-echogram serve` answers, through the same functions in
`serve`, so the two cannot disagree about what a resolution holds or where a
mount reads. Every route is a plain function, which FastAPI runs in its
thread pool, as the standard library server runs one thread per connection.

Errors are raised as `HTTPException` with the reason as the detail, and each
host renders them its own way.
"""

import json

from fastapi import APIRouter, HTTPException, Request, Response

from ..serve import (
    GONE,
    Mounts,
    content_type,
    open_request,
    reason_line,
    resolve_request,
    safe_key,
    status_of,
)

NO_STORE = {"Cache-Control": "no-store"}


def build_router(mounts: Mounts, *, storage_options=None) -> APIRouter:
    """The catalog and data routes over one Mounts, for any FastAPI host.

    Routes, relative to wherever the host includes the router:
    `GET /api/resolve`, `GET /api/open`, `GET /api/describe/{mount}` and
    `GET /mount/{mount}/{key}`.

    Args:
        mounts: The mounts every route reads and adds to. A host that limits
            what may be read builds it with `roots=[]` and calls `allow`.
        storage_options: fsspec options for cache roots and paths named in a
            request; a recipe's run config supplies its own.

    Returns:
        APIRouter: The routes, for `include_router`.
    """
    router = APIRouter()

    @router.get("/api/resolve")
    def resolve(request: Request) -> Response:
        return _json(lambda: resolve_request(_query(request), mounts, storage_options))

    @router.get("/api/open")
    def open_(request: Request) -> Response:
        return _json(lambda: open_request(_query(request), mounts, storage_options))

    @router.get("/api/describe/{mount}")
    def describe(mount: str) -> Response:
        return _json(lambda: mounts.describe(mount))

    @router.get("/mount/{mount}/{key:path}")
    def chunk(mount: str, key: str) -> Response:
        # Not a 404: the client reads a missing chunk as fill, and a mount this
        # server has not handed out is not an empty chunk.
        if not mounts.known(mount):
            raise HTTPException(410, GONE)
        if not safe_key(key):
            raise HTTPException(404)
        return read_key(lambda: mounts.source(mount), key)

    return router


def read_key(open_source, key):
    """A response holding one object of a source, a 404, or a 500 with why.

    Opening the source is inside the same handling as reading it, since a
    mounted dataset is opened on its first read and can fail there too.

    Args:
        open_source: Called for something with `read(key)` returning bytes or
            None, or for None.
        key: The object's key, already checked with `safe_key`.

    Returns:
        Response: The object's bytes, never cached by the browser.
    """
    try:
        source = open_source()
        body = source.read(key) if source is not None else None
    except Exception as error:  # noqa: BLE001 - reported to the page
        raise HTTPException(500, reason_line(error)) from error
    if body is None:
        raise HTTPException(404)
    return Response(body, media_type=content_type(key), headers=NO_STORE)


def _query(request):
    """The query string as `parse_qs` gives it: each name to a list of values."""
    params = request.query_params
    return {name: params.getlist(name) for name in params}


def _json(compute):
    """Answer with what `compute` returns as JSON, mapping errors to statuses.

    Encoded as the standard library server encodes it, so a NaN in a header
    is written the same way by both.
    """
    try:
        payload = compute()
    except Exception as error:  # noqa: BLE001 - reported to the page
        status, message = status_of(error)
        raise HTTPException(status.value, message) from error
    body = json.dumps(payload).encode("utf-8")
    return Response(body, media_type="application/json", headers=NO_STORE)
