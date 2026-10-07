"""Local development server.

Serves a store and the built web app from one origin, so the browser stays in a
secure context and CORS never enters the picture.

The store may be a directory or an fsspec URL such as `gs://bucket/prefix`. An
object store is read one object per request, with whatever credentials the
process already has, which is what makes it possible to look at a published
pyramid without making a bucket public or configuring CORS on it. It is a
development convenience and not the published path: every chunk costs a round
trip from here to the bucket and another to the browser.

Chunks are served with no-store because a store under development is rebuilt in
place. Published objects are content addressed and carry immutable cache
headers instead.

It also finds what a recipe step left in a cache. `/api/resolve` names a step,
by a recipe and its id or by cache roots and its id, and answers with what the
step wrote and where it sits in time. `/api/open` answers the same for a store
or dataset named by its path. Each dataset it names is mounted under a
stable id, served under `/mount/<id>/`, and described under
`/api/describe/<id>`. The browser cannot list a bucket, so this is the part
that has to live on the server.
"""

import hashlib
import json
import os
import posixpath
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np

from . import catalog, describe, tiles

STORE_PREFIX = "/store/"
MOUNT_PREFIX = "/mount/"
API_PREFIX = "/api/"

CONTENT_TYPES = {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".map": "application/json",
    ".mjs": "text/javascript",
    ".svg": "image/svg+xml",
    ".wgsl": "text/plain",
    ".woff2": "font/woff2",
}
"""Declared rather than guessed. On Windows mimetypes reads the registry, where
.js can be mapped to text/plain, and a module script served as text/plain is
refused by the browser."""


def make_handler(store_root=None, app_root=None, mounts=None):
    """Build a request handler bound to one store and one app directory.

    Args:
        store_root: Directory holding the store, served under /store/, or None.
        app_root: Directory holding the web app, served at the root, or None.
        mounts: Mounts the catalog routes add to, or None for a new set.

    Returns:
        type: A BaseHTTPRequestHandler subclass.
    """
    if store_root is None or hasattr(store_root, "read"):
        store = store_root
    else:
        store = open_source(store_root)
    app_root = os.path.realpath(str(app_root)) if app_root else None
    mounts = mounts if mounts is not None else Mounts()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self._respond(include_body=True)

        def do_HEAD(self):
            self._respond(include_body=False)

        def log_message(self, format, *args):
            pass

        def _respond(self, include_body):
            started = time.monotonic()
            request = unquote(urlparse(self.path).path)
            if request.startswith(API_PREFIX):
                self._api(include_body)
                return
            # Not a 404: the client reads a missing chunk as fill, and a mount
            # this server has not handed out is not an empty chunk. After a
            # restart it would draw blank tiles and keep them.
            mount = request[len(MOUNT_PREFIX):].partition("/")[0]
            if request.startswith(MOUNT_PREFIX) and not mounts.known(mount):
                self.send_error(
                    HTTPStatus.GONE, "unknown mount; resolve the step again"
                )
                return
            found = self._resolve()
            if found is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            name, body = found
            if body is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            read = time.monotonic() - started

            try:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type(name))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if include_body:
                    self.wfile.write(body)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                # The browser hung up, which the viewer does on purpose when it
                # stops wanting a tile. One line rather than a traceback, with
                # the timing that tells a cancellation from a stall.
                self.close_connection = True
                print(
                    f"{time.strftime('%H:%M:%S')} client closed {self.path} "
                    f"after {time.monotonic() - started:.2f} s "
                    f"(store read {read:.2f} s, {len(body)} bytes)",
                    flush=True,
                )

        def _api(self, include_body):
            """Answer a catalog request with JSON, errors included."""
            parsed = urlparse(self.path)
            request = unquote(parsed.path)
            query = parse_qs(parsed.query)
            try:
                if request == f"{API_PREFIX}resolve":
                    payload = resolve_request(query, mounts)
                elif request == f"{API_PREFIX}open":
                    payload = open_request(query, mounts)
                elif request.startswith(f"{API_PREFIX}describe/"):
                    payload = mounts.describe(request.rsplit("/", 1)[-1])
                else:
                    raise LookupError(f"no route {request}")
                status = HTTPStatus.OK
            except catalog.CatalogError as error:
                status, payload = HTTPStatus.BAD_REQUEST, {"error": str(error)}
            except PermissionError as error:
                status, payload = HTTPStatus.FORBIDDEN, {"error": str(error)}
            except LookupError as error:
                status, payload = HTTPStatus.NOT_FOUND, {"error": str(error)}
            except Exception as error:  # noqa: BLE001 - reported to the page
                status = HTTPStatus.INTERNAL_SERVER_ERROR
                payload = {"error": f"{type(error).__name__}: {error}"}
            body = json.dumps(payload).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if include_body:
                    self.wfile.write(body)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                self.close_connection = True

        def _resolve(self):
            """Map a request onto a name and its bytes, or None if there is none."""
            request = unquote(urlparse(self.path).path)
            if request.startswith(MOUNT_PREFIX):
                mount, _, key = request[len(MOUNT_PREFIX):].partition("/")
                source = mounts.source(mount)
                if source is None or not _safe(key):
                    return None
                return key, source.read(key)
            if request.startswith(STORE_PREFIX):
                key = request[len(STORE_PREFIX):]
                if store is None or not _safe(key):
                    return None
                return key, store.read(key)
            if app_root is None:
                return None
            if request in ("", "/"):
                request = "/index.html"
            path = _under(app_root, request.lstrip("/"))
            if path is None:
                return None
            try:
                with open(path, "rb") as handle:
                    return path, handle.read()
            except OSError:
                return None

    return Handler


def content_type(path):
    """Return the media type for a file, defaulting to opaque bytes.

    Args:
        path: Filesystem path being served.

    Returns:
        str: Media type.
    """
    extension = os.path.splitext(path)[1].lower()
    return CONTENT_TYPES.get(extension, "application/octet-stream")


class DirectorySource:
    """A store on disk, read one file per request."""

    def __init__(self, root):
        self.root = os.path.realpath(str(root))

    def read(self, key):
        """Return the bytes of one object, or None if there is no such file."""
        path = _under(self.root, key)
        if path is None:
            return None
        try:
            with open(path, "rb") as handle:
                return handle.read()
        except OSError:
            return None


class ObjectSource:
    """A store in object storage, read one object per request.

    Uses whatever credentials the process already has, which for Google Cloud
    means application default credentials: `gcloud auth application-default
    login` once, and this reads a private bucket without it being made public
    and without CORS being configured on it, because the browser only ever
    talks to this server.
    """

    def __init__(self, url, storage_options=None):
        try:
            import fsspec
        except ImportError as error:  # pragma: no cover - depends on the install
            raise SystemExit(
                f"reading {url} needs fsspec. Install the extra with "
                "`pip install -e .[gcs]` for Google Cloud Storage."
            ) from error
        try:
            options = storage_options or {}
            self.fs, self.root = fsspec.core.url_to_fs(url, **options)
        except ImportError as error:  # pragma: no cover - depends on the install
            raise SystemExit(
                f"reading {url} needs a driver fsspec does not have: {error}. "
                "For Google Cloud Storage, `pip install -e .[gcs]`."
            ) from error
        self.root = self.root.rstrip("/")

    def read(self, key):
        """Return the bytes of one object, or None if it is not there."""
        path = f"{self.root}/{key}" if key else self.root
        try:
            return self.fs.cat_file(path)
        except FileNotFoundError:
            return None
        except OSError:
            # An absent chunk is a fill value to zarr, and object stores report
            # a missing key in more than one way. Anything else worth knowing
            # about shows up as the store failing to open at all.
            return None


def open_source(store, storage_options=None):
    """Choose a source for a store named as a path or an fsspec URL.

    Args:
        store: Directory path, or a URL such as gs://bucket/prefix.
        storage_options: fsspec options for a URL.

    Returns:
        object: Something with a read(key) returning bytes or None.
    """
    text = str(store)
    if "://" in text:
        return ObjectSource(text, storage_options)
    return DirectorySource(text)


class Mounts:
    """Datasets the catalog has named, by an id stable across restarts.

    The id is a digest of the dataset's location, so refreshing a source that
    still names the same checkpoint keeps the same URL, and the browser's and
    the viewer's caches stay valid. An id this server has not handed out is a
    404: a restarted server learns its mounts again from the next resolve.

    Args:
        roots: Cache roots a request may read under, or None for any.
    """

    def __init__(self, roots=None):
        self.roots = [_normalise(root) for root in roots] if roots else None
        self.found = {}
        self.sources = {}

    def add(self, url, storage_options=None, tiled=False, stamp=""):
        """Mount a store and return its id.

        A tiled mount is a dataset served under the viewer's chunking (see
        `tiles`). An untiled one is a store served as it is, such as a pyramid.
        The stamp says which writing of the store it is, for its header.
        """
        mount = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
        held = self.found.get(mount)
        if held and held[3] != stamp:
            # Written again at the same path: the open reader holds the old.
            self.sources.pop(mount, None)
        self.found[mount] = (url, storage_options, tiled, stamp)
        return mount

    def known(self, mount):
        """Whether this server has handed out a mount."""
        return mount in self.found

    def source(self, mount):
        """A reader for a mounted store, or None."""
        if mount not in self.found:
            return None
        if mount not in self.sources:
            url, options, tiled, _ = self.found[mount]
            if tiled:
                self.sources[mount] = tiles.TileSource(url, options)
            else:
                self.sources[mount] = open_source(url, options)
        return self.sources[mount]

    def describe(self, mount):
        """The viewer's header for a mounted dataset."""
        if mount not in self.found:
            raise LookupError(f"no mount {mount}; resolve the step again")
        url, options, _, stamp = self.found[mount]
        return catalog.cached(
            "describe", url, lambda: describe.describe(url, options), stamp
        )

    def check(self, roots):
        """Refuse cache roots outside the ones this server was started with."""
        if self.roots is None:
            return
        for root in roots:
            wanted = _normalise(root)
            if not any(wanted == r or wanted.startswith(r + "/") for r in self.roots):
                raise PermissionError(
                    f"{root} is outside the cache roots this server reads; "
                    f"start it with --cache-root {root}"
                )


def resolve_request(query, mounts):
    """Answer `/api/resolve`.

    Recipe mode takes `recipe` and `step`, with optional repeated
    `input=NAME=VALUE`, `config`, `user_cache` and `survey_cache`. Cache mode
    takes repeated `cache` roots and `step`. Both take `output`, and `start` and
    `end` as ISO times or nanoseconds, which limit a mapped step to a window.
    """

    def one(name):
        values = query.get(name)
        return values[0] if values else None

    step = one("step")
    if not step:
        raise catalog.CatalogError("name a step")
    window = None
    if one("start") or one("end"):
        window = (_nanoseconds(one("start"), -(2**62)), _nanoseconds(one("end"), 2**62))

    recipe = one("recipe")
    if recipe:
        inputs = {}
        for item in query.get("input", []):
            name, found, value = item.partition("=")
            if not found:
                raise catalog.CatalogError(f"input {item!r} is not NAME=VALUE")
            inputs[name.strip()] = value.strip()
        caches = (one("user_cache"), one("survey_cache"))
        tiers, options, _ = catalog.recipe_tiers(recipe, one("config"), *caches)
        mounts.check(tier.root for tier in tiers)
        result = catalog.resolve_recipe(
            recipe, step, inputs, one("config"), one("output"), window, *caches
        )
    else:
        roots = query.get("cache", [])
        if not roots:
            raise catalog.CatalogError("name a recipe, or one or more cache roots")
        mounts.check(roots)
        options = None
        result = catalog.resolve_cache(roots, step, one("output"), window)

    return _mount(result, mounts, options)


def open_request(query, mounts):
    """Answer `/api/open`: what is at a path the server reads.

    Takes `path`, a directory or a `gs://` URL. Answers as `/api/resolve`
    does, with a pyramid mounted as it is or a dataset mounted as one piece.
    """
    path = (query.get("path") or [""])[0].strip()
    if not path:
        raise catalog.CatalogError("name a path")
    mounts.check([path])
    return _mount(catalog.open_path(path), mounts, None)


def _mount(result, mounts, options):
    """Mount what a resolution names, and say where each is served."""
    if result.get("store"):
        result["mount"] = mounts.add(result["store"], options)
    for instance in result.get("instances", []):
        instance["mount"] = mounts.add(
            instance["store"], options, tiled=True, stamp=instance["stamp"]
        )
    return result


def _nanoseconds(value, default):
    """Nanoseconds since 1970 from an ISO time or a count, or the default."""
    if value in (None, ""):
        return default
    if value.lstrip("-").isdigit():
        return int(value)
    try:
        return int(np.datetime64(value, "ns").astype("int64"))
    except ValueError as error:
        raise catalog.CatalogError(f"{value!r} is not a time") from error


def _normalise(root):
    """A root for prefix comparison: forward slashes, no trailing slash."""
    text = str(root).replace("\\", "/").rstrip("/")
    if "://" in text:
        return text
    return os.path.normcase(os.path.abspath(text)).replace("\\", "/")


def _safe(key):
    """Whether a request key stays inside the store it is addressed to."""
    parts = [p for p in posixpath.normpath(key).split("/") if p not in ("", ".")]
    return not any(p == ".." for p in parts)


def _under(root, relative):
    """Resolve a relative path under a root, refusing anything that escapes it.

    Args:
        root: Real path of the directory being served.
        relative: Slash separated path from the request.

    Returns:
        str: Real path of an existing file, or None.
    """
    parts = [p for p in posixpath.normpath(relative).split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return None
    path = os.path.realpath(os.path.join(root, *parts))
    if path != root and not path.startswith(root + os.sep):
        return None
    return path if os.path.isfile(path) else None


def serve(store=None, app=None, host="127.0.0.1", port=8000, cache_roots=None):
    """Serve a store, and optionally an app directory, until interrupted.

    Args:
        store: Store directory, or an fsspec URL such as gs://bucket/prefix, or
            None to serve only what the catalog mounts.
        app: Directory holding a built web app, or None.
        host: Interface to bind.
        port: Port to bind, or 0 to let the system choose.
        cache_roots: Cache roots the catalog may read under, or None for any.

    Returns:
        int: Process exit code.
    """
    source = open_source(store) if store else None
    mounts = Mounts(cache_roots)
    server = ThreadingHTTPServer((host, port), make_handler(source, app, mounts))
    bound = server.server_address[1]
    if store:
        print(f"serving {store}")
        print(f"store at http://{host}:{bound}{STORE_PREFIX}")
    print(f"catalog at http://{host}:{bound}{API_PREFIX}resolve")
    if app:
        print(f"app at http://{host}:{bound}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
