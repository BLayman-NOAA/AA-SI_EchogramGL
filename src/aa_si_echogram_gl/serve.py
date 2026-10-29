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

The same routes are offered to a FastAPI host by `server.build_router`, over
the same `Mounts` and the same request functions. This module stays on the
standard library, so `aa-echogram serve` needs nothing more.
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

METADATA_KEYS = {".zarray", ".zattrs", ".zgroup", ".zmetadata", "zarr.json"}
"""Zarr metadata objects, which are JSON whatever their names say."""

GONE = "unknown mount; resolve the step again"


class UnknownMount(LookupError):
    """A mount this server has not handed out, as after a restart: 410."""


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
                self._api(include_body, started)
                return
            # Not a 404: the client reads a missing chunk as fill, and a mount
            # this server has not handed out is not an empty chunk. After a
            # restart it would draw blank tiles and keep them.
            mount = request[len(MOUNT_PREFIX):].partition("/")[0]
            if request.startswith(MOUNT_PREFIX) and not mounts.known(mount):
                self._refuse(
                    HTTPStatus.GONE, GONE, started
                )
                return
            try:
                found = self._resolve()
            except Exception as error:  # noqa: BLE001 - reported to the page
                # A read that raises would otherwise end this thread with a
                # traceback and no response, which the browser reports as a
                # bare failed fetch. A 500 carries the reason to the page.
                status = HTTPStatus.INTERNAL_SERVER_ERROR
                self._refuse(status, reason_line(error), started)
                return
            if found is None or found[1] is None:
                self._refuse(HTTPStatus.NOT_FOUND, None, started)
                return
            name, body = found
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
                # stops wanting a tile. Logged with the timing that tells a
                # cancellation from a stall.
                self.close_connection = True
                self._log("closed", started, read, len(body))
                return
            self._log(HTTPStatus.OK.value, started, read, len(body))

        def _refuse(self, status, message, started):
            """Send an error status, surviving a client that has already gone."""
            try:
                self.send_error(status, message)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                self.close_connection = True
            self._log(status.value, started)

        def _log(self, status, started, read=None, size=None):
            """One line per request: status, path, elapsed, and the store read."""
            elapsed = time.monotonic() - started
            detail = "" if read is None else f" (read {read:.2f} s, {size} B)"
            print(
                f"{time.strftime('%H:%M:%S')} {status} {self.path} {elapsed:.2f} s{detail}",
                flush=True,
            )

        def _api(self, include_body, started):
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
            except Exception as error:  # noqa: BLE001 - reported to the page
                status, message = status_of(error)
                if status == HTTPStatus.FORBIDDEN:
                    message += "; start aa-echogram serve with --cache-root for it"
                payload = {"error": message}
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
            self._log(status.value, started)

        def _resolve(self):
            """Map a request onto a name and its bytes, or None if there is none."""
            request = unquote(urlparse(self.path).path)
            if request.startswith(MOUNT_PREFIX):
                mount, _, key = request[len(MOUNT_PREFIX):].partition("/")
                source = mounts.source(mount)
                if source is None or not safe_key(key):
                    return None
                return key, source.read(key)
            if request.startswith(STORE_PREFIX):
                key = request[len(STORE_PREFIX):]
                if store is None or not safe_key(key):
                    return None
                return key, store.read(key)
            if app_root is None:
                return None
            if request in ("", "/"):
                request = "/index.html"
            path = under(app_root, request.lstrip("/"))
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
    name = str(path).replace("\\", "/").rsplit("/", 1)[-1]
    if name in METADATA_KEYS:
        return "application/json; charset=utf-8"
    extension = os.path.splitext(name)[1].lower()
    return CONTENT_TYPES.get(extension, "application/octet-stream")


class DirectorySource:
    """A store on disk, read one file per request."""

    def __init__(self, root):
        self.root = os.path.realpath(str(root))

    def read(self, key):
        """Return the bytes of one object, or None if there is no such file."""
        path = under(self.root, key)
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
    410: a restarted server learns its mounts again from the next resolve.

    Args:
        roots: Cache roots a request may read under, or None for any. An
            empty list allows none until `allow` adds some.
    """

    def __init__(self, roots=None):
        self.roots = None if roots is None else [_normalise(root) for root in roots]
        self.found = {}
        self.sources = {}

    def add(self, url, storage_options=None, tiled=False, stamp="", var=None):
        """Mount a store and return its id.

        A tiled mount is a dataset served under the viewer's chunking (see
        `tiles`). An untiled one is a store served as it is, such as a pyramid.
        The stamp says which writing of the store it is, for its header. A
        tiled mount serves one variable, so the same dataset with another
        variable is another mount.
        """
        key = f"{url}#{var}" if var else url
        mount = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
        held = self.found.get(mount)
        if held and held[3] != stamp:
            # Written again at the same path: the open reader holds the old.
            self.sources.pop(mount, None)
        self.found[mount] = (url, storage_options, tiled, stamp, var)
        return mount

    def known(self, mount):
        """Whether this server has handed out a mount."""
        return mount in self.found

    def source(self, mount):
        """A reader for a mounted store, or None."""
        if mount not in self.found:
            return None
        if mount not in self.sources:
            url, options, tiled, _, var = self.found[mount]
            if tiled:
                self.sources[mount] = tiles.TileSource(url, options, var)
            else:
                self.sources[mount] = open_source(url, options)
        return self.sources[mount]

    def describe(self, mount):
        """The viewer's header for a mounted dataset."""
        if mount not in self.found:
            raise UnknownMount(GONE)
        url, options, _, stamp, var = self.found[mount]
        return catalog.cached(
            "describe",
            f"{url}#{var}" if var else url,
            lambda: describe.describe(url, options, var),
            stamp,
        )

    def allow(self, roots):
        """Add cache roots a request may read under.

        A host adds the folders a session may read as sessions open. A set
        built to allow any root is left as it is.

        Args:
            roots: Directories or URLs.
        """
        if self.roots is None:
            return
        for root in roots:
            wanted = _normalise(root)
            if wanted not in self.roots:
                self.roots.append(wanted)

    def check(self, roots):
        """Refuse paths outside the folders this server reads."""
        if self.roots is None:
            return
        for root in roots:
            wanted = _normalise(root)
            if not any(wanted == r or wanted.startswith(r + "/") for r in self.roots):
                raise PermissionError(
                    f"{root} is outside the folders this server reads"
                )


def resolve_request(query, mounts, storage_options=None):
    """Answer `/api/resolve`.

    Recipe mode takes `recipe` and `step`, with optional repeated
    `input=NAME=VALUE`, `config`, `user_cache` and `survey_cache`. Cache mode
    takes repeated `cache` roots and `step`. Both take `output`, and `start` and
    `end` as ISO times or nanoseconds, which limit a mapped step to a window.

    Args:
        query: Query parameters, each a list of values.
        mounts: Mounts to add what is found to.
        storage_options: fsspec options for cache roots; a recipe's run
            config supplies its own.
    """

    def one(name):
        values = query.get(name)
        return values[0] if values else None

    step = one("step")
    if not step:
        raise catalog.CatalogError("name a step")
    window = parse_window(one("start"), one("end"))

    recipe = one("recipe")
    if recipe:
        # Reading the recipe and its config is itself a read.
        mounts.check(path for path in (recipe, one("config")) if path)
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
            recipe, step, inputs, one("config"), one("output"), window, *caches,
            var=one("var"),
        )
    else:
        roots = query.get("cache", [])
        if not roots:
            raise catalog.CatalogError("name a recipe, or one or more cache roots")
        mounts.check(roots)
        options = storage_options
        result = catalog.resolve_cache(
            roots, step, one("output"), window, options, var=one("var")
        )

    return mount_resolution(result, mounts, options)


def open_request(query, mounts, storage_options=None):
    """Answer `/api/open`: what is at a path the server reads.

    Takes `path`, a directory or a `gs://` URL. Answers as `/api/resolve`
    does, with a pyramid mounted as it is or a dataset mounted as one piece.

    Args:
        query: Query parameters, each a list of values.
        mounts: Mounts to add what is found to.
        storage_options: fsspec options for a URL.
    """
    path = (query.get("path") or [""])[0].strip()
    if not path:
        raise catalog.CatalogError("name a path")
    mounts.check([path])
    found = catalog.open_path(path, storage_options, var=one_of(query, "var"))
    return mount_resolution(found, mounts, storage_options)


def mount_resolution(result, mounts, storage_options=None):
    """Mount what a resolution names, and say where each is served.

    A pyramid gains `mount`, and each dataset instance gains its own.

    Args:
        result: A resolution, as `catalog.resolution` and the resolvers
            return it. Changed in place.
        mounts: Mounts to add to.
        storage_options: fsspec options for reading what is mounted.

    Returns:
        dict: The same resolution.
    """
    if result.get("store"):
        result["mount"] = mounts.add(result["store"], storage_options)
    for instance in result.get("instances", []):
        instance["mount"] = mounts.add(
            instance["store"],
            storage_options,
            tiled=True,
            stamp=instance["stamp"],
            var=instance.get("var"),
        )
    return result


def status_of(error):
    """The HTTP status a catalog error answers with, and its message.

    Args:
        error: What a request raised.

    Returns:
        tuple: (HTTPStatus, str). A request the catalog cannot answer is 400,
        a root not allowed 403, nothing there 404, a mount not handed out 410,
        and anything else a 500 whose message is one line.
    """
    if isinstance(error, UnknownMount):
        return HTTPStatus.GONE, str(error)
    if isinstance(error, catalog.CatalogError):
        return HTTPStatus.BAD_REQUEST, str(error)
    if isinstance(error, PermissionError):
        return HTTPStatus.FORBIDDEN, str(error)
    if isinstance(error, LookupError):
        return HTTPStatus.NOT_FOUND, str(error)
    return HTTPStatus.INTERNAL_SERVER_ERROR, reason_line(error)


def one_of(query, name):
    """The first value of a query parameter, or None."""
    values = query.get(name)
    return values[0] if values else None


def parse_window(start=None, end=None):
    """A time window from two optional ISO times or nanosecond counts.

    Args:
        start: Start of the window, or None or empty for open.
        end: End of the window, or None or empty for open.

    Returns:
        tuple | None: (start, end) in nanoseconds since 1970, or None when
        neither is given.

    Raises:
        CatalogError: If either is not a time.
    """
    if not start and not end:
        return None
    return (_nanoseconds(start, -(2**62)), _nanoseconds(end, 2**62))


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
    """A root for prefix comparison: forward slashes, no trailing slash.

    A local path is resolved through any links, so a link inside a root
    cannot name something outside it.
    """
    text = str(root).replace("\\", "/").rstrip("/")
    if "://" in text:
        return text
    return os.path.normcase(os.path.realpath(text)).replace("\\", "/")


def reason_line(error):
    """An exception as a status line reason: one line, short."""
    text = f"{type(error).__name__}: {error}".replace("\r", " ").replace("\n", " ")
    return text[:300]


class Server(ThreadingHTTPServer):
    """One thread per connection, with room for a burst of them.

    The default backlog of five pending connections is overrun by a browser
    opening many during a fast zoom, and on Windows an overrun is an immediate
    reset, which the viewer reports as a failed fetch. Daemon threads, so a
    read still waiting on a bucket does not hold the process open at exit.
    """

    request_queue_size = 128
    daemon_threads = True


def safe_key(key):
    """Whether a request key stays inside the store it is addressed to."""
    parts = [p for p in posixpath.normpath(key).split("/") if p not in ("", ".")]
    return not any(p == ".." for p in parts)


def under(root, relative):
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
    server = Server((host, port), make_handler(source, app, mounts))
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
