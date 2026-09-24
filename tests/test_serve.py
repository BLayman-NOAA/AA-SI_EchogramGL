"""Development server tests."""

import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from aa_si_echogram_gl import fixtures, pyramid, serve


@pytest.fixture
def served(tmp_path):
    """Serve a store and an app directory on a system chosen port."""
    store = tmp_path / "store.zarr"
    pyramid.build_pyramid(fixtures.synthetic(n_pings=8, n_samples=6), store)

    app = tmp_path / "app"
    app.mkdir()
    (app / "index.html").write_text("<title>viewer</title>", encoding="utf-8")

    server = ThreadingHTTPServer(("127.0.0.1", 0), serve.make_handler(store, app))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def fetch(url):
    """Return status and body for a URL, treating an error as its status."""
    try:
        with urllib.request.urlopen(url) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def test_serves_store_metadata(served):
    status, body = fetch(f"{served}/store/zarr.json")
    assert status == 200
    assert b"multiscales" in body


def test_serves_a_chunk(served):
    status, body = fetch(f"{served}/store/0/Sv/c/0/0/0")
    assert status == 200
    assert body


def test_declares_content_types_rather_than_guessing():
    """On Windows mimetypes reads the registry, where .js can be text/plain,
    and a module script served as text/plain is refused by the browser."""
    assert serve.content_type("assets/index-abc.js") == "text/javascript"
    assert serve.content_type("index.html") == "text/html"
    assert serve.content_type("zarr.json") == "application/json"
    assert serve.content_type("0/Sv/c/0/0/0") == "application/octet-stream"


def test_missing_key_is_404(served):
    """zarr reads an absent chunk as fill value, so this has to be a clean 404
    rather than an error page with a 200."""
    status, _ = fetch(f"{served}/store/0/Sv/c/9/9/9")
    assert status == 404


def test_serves_the_app_at_the_root(served):
    status, body = fetch(f"{served}/")
    assert status == 200
    assert b"viewer" in body


def test_refuses_paths_that_escape_the_store(served):
    status, _ = fetch(f"{served}/store/..%2F..%2Fsecrets.txt")
    assert status == 404


def test_no_app_directory_means_no_root(tmp_path):
    store = tmp_path / "store.zarr"
    pyramid.build_pyramid(fixtures.synthetic(n_pings=8, n_samples=6), store)
    handler = serve.make_handler(store, None)

    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, _ = fetch(f"http://127.0.0.1:{server.server_address[1]}/")
        assert status == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class FakeFilesystem:
    """Enough of an fsspec filesystem to answer object reads."""

    def __init__(self, objects):
        self.objects = objects
        self.asked = []

    def cat_file(self, path):
        self.asked.append(path)
        if path not in self.objects:
            raise FileNotFoundError(path)
        return self.objects[path]


def object_source(objects, root="bucket/prefix"):
    """An ObjectSource over a fake filesystem, with no credentials involved."""
    source = serve.ObjectSource.__new__(serve.ObjectSource)
    source.fs = FakeFilesystem(objects)
    source.root = root
    return source


def test_a_store_url_says_what_to_install_when_it_cannot_be_read():
    """The likeliest first encounter with gs://, so it has to be actionable.

    Skipped once the driver is installed, because then the URL opens and there
    is nothing to report. Asserting the failure only where it can happen beats
    asserting nothing.
    """
    try:
        import gcsfs  # noqa: F401
    except ImportError:
        pass
    else:
        pytest.skip("gcsfs is installed, so a gs:// store opens rather than failing")

    with pytest.raises(SystemExit) as failure:
        serve.open_source("gs://bucket/prefix")
    assert "pip install" in str(failure.value)


def test_a_directory_is_read_as_files(tmp_path):
    assert isinstance(serve.open_source(str(tmp_path)), serve.DirectorySource)


def test_an_object_store_serves_a_chunk():
    source = object_source({"bucket/prefix/0/Sv/c/0/0/0": b"chunk"})
    assert source.read("0/Sv/c/0/0/0") == b"chunk"
    assert source.fs.asked == ["bucket/prefix/0/Sv/c/0/0/0"]


def test_an_absent_object_is_an_absence():
    """zarr reads a missing chunk as fill value, so this is not an error."""
    source = object_source({})
    assert source.read("0/Sv/c/9/9/9") is None


def test_an_object_store_is_served_over_http(tmp_path):
    """The whole path, with the bucket replaced by a dictionary."""
    objects = {
        "bucket/prefix/zarr.json": b'{"ok": true}',
        "bucket/prefix/0/Sv/c/0/0/0": b"\x01\x02",
    }
    handler = serve.make_handler(object_source(objects), None)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(f"{origin}/store/zarr.json") as response:
            assert response.status == 200
            assert response.headers["Content-Type"] == "application/json"
            assert response.read() == b'{"ok": true}'
        with urllib.request.urlopen(f"{origin}/store/0/Sv/c/0/0/0") as response:
            assert response.read() == b"\x01\x02"
        try:
            urllib.request.urlopen(f"{origin}/store/nope")
            raise AssertionError("expected a 404")
        except urllib.error.HTTPError as error:
            assert error.code == 404
    finally:
        server.shutdown()
        server.server_close()


def test_an_object_store_refuses_a_key_that_escapes_it():
    """A bucket has no directories, but the prefix is still a boundary."""
    objects = {"bucket/secret": b"no"}
    handler = serve.make_handler(object_source(objects), None)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        try:
            urllib.request.urlopen(f"{origin}/store/../secret")
            raise AssertionError("expected a 404")
        except urllib.error.HTTPError as error:
            assert error.code == 404
    finally:
        server.shutdown()
        server.server_close()
