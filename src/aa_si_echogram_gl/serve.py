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
"""

import os
import posixpath
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

STORE_PREFIX = "/store/"

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


def make_handler(store_root, app_root=None):
    """Build a request handler bound to one store and one app directory.

    Args:
        store_root: Directory holding the store, served under /store/.
        app_root: Directory holding the web app, served at the root, or None.

    Returns:
        type: A BaseHTTPRequestHandler subclass.
    """
    store = store_root if hasattr(store_root, "read") else open_source(store_root)
    app_root = os.path.realpath(str(app_root)) if app_root else None

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self._respond(include_body=True)

        def do_HEAD(self):
            self._respond(include_body=False)

        def log_message(self, format, *args):
            pass

        def _respond(self, include_body):
            found = self._resolve()
            if found is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            name, body = found
            if body is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type(name))
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if include_body:
                self.wfile.write(body)

        def _resolve(self):
            """Map a request onto a name and its bytes, or None if there is none."""
            request = unquote(urlparse(self.path).path)
            if request.startswith(STORE_PREFIX):
                key = request[len(STORE_PREFIX):]
                if not _safe(key):
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

    def __init__(self, url):
        try:
            import fsspec
        except ImportError as error:  # pragma: no cover - depends on the install
            raise SystemExit(
                f"reading {url} needs fsspec. Install the extra with "
                "`pip install -e .[gcs]` for Google Cloud Storage."
            ) from error
        try:
            self.fs, self.root = fsspec.core.url_to_fs(url)
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


def open_source(store):
    """Choose a source for a store named as a path or an fsspec URL.

    Args:
        store: Directory path, or a URL such as gs://bucket/prefix.

    Returns:
        object: Something with a read(key) returning bytes or None.
    """
    text = str(store)
    return ObjectSource(text) if "://" in text else DirectorySource(text)


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


def serve(store, app=None, host="127.0.0.1", port=8000):
    """Serve a store, and optionally an app directory, until interrupted.

    Args:
        store: Store directory, or an fsspec URL such as gs://bucket/prefix.
        app: Directory holding a built web app, or None.
        host: Interface to bind.
        port: Port to bind, or 0 to let the system choose.

    Returns:
        int: Process exit code.
    """
    source = open_source(store)
    server = ThreadingHTTPServer((host, port), make_handler(source, app))
    bound = server.server_address[1]
    print(f"serving {store}")
    print(f"store at http://{host}:{bound}{STORE_PREFIX}")
    if app:
        print(f"app at http://{host}:{bound}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
