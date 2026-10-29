"""The catalog and data routes as a FastAPI router, as a host mounts them."""

import shutil

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from recipe_ops import PINGS  # noqa: E402

from aa_si_echogram_gl import fixtures, pyramid, serve  # noqa: E402
from aa_si_echogram_gl.server import build_router, create_app  # noqa: E402

pytestmark = pytest.mark.usefixtures("index_dir")


@pytest.fixture
def client(cache):
    """An application limited to the template cache."""
    return TestClient(create_app(cache_roots=[str(cache)])), cache


def resolve(client, cache, step="file_mvbs", **extra):
    params = {"cache": str(cache), "step": step, **extra}
    return client.get("/api/resolve", params=params)


def test_resolve_mounts_each_instance(client):
    client, cache = client
    answer = resolve(client, cache)
    assert answer.status_code == 200
    assert answer.headers["cache-control"] == "no-store"
    found = answer.json()
    assert len(found["instances"]) == 3
    mount = found["instances"][0]["mount"]
    meta = client.get(f"/mount/{mount}/Sv/.zarray")
    assert meta.status_code == 200
    assert meta.json()["chunks"] == [1, PINGS, 20]
    assert meta.headers["content-type"] == "application/json; charset=utf-8"
    chunk = client.get(f"/mount/{mount}/Sv/1.0.0")
    assert chunk.status_code == 200
    assert chunk.headers["cache-control"] == "no-store"
    assert chunk.headers["content-type"] == "application/octet-stream"
    header = client.get(f"/api/describe/{mount}")
    assert header.status_code == 200
    assert header.json()["kind"] == "mvbs"


def test_a_mount_is_stable_across_resolves(client):
    client, cache = client
    first = resolve(client, cache).json()["instances"][0]["mount"]
    second = resolve(client, cache).json()["instances"][0]["mount"]
    assert first == second


def test_unknown_mounts_and_escapes_are_refused(client):
    client, cache = client
    gone = client.get("/mount/0123456789abcdef/Sv/.zarray")
    assert gone.status_code == 410
    assert "resolve the step again" in gone.json()["detail"]
    mount = resolve(client, cache).json()["instances"][0]["mount"]
    assert client.get(f"/mount/{mount}/..%2F..%2Fmeta.json").status_code == 404
    assert client.get(f"/mount/{mount}/Sv/9.9.9").status_code == 404
    header = client.get("/api/describe/0123456789abcdef")
    assert header.status_code == 410
    assert header.json()["detail"] == gone.json()["detail"]


def test_a_root_outside_the_allowed_ones_is_forbidden(client, tmp_path):
    client, _ = client
    answer = resolve(client, tmp_path / "elsewhere")
    assert answer.status_code == 403
    assert "outside the folders this server reads" in answer.json()["detail"]
    # A host's users cannot start the server with flags.
    assert "--cache-root" not in answer.json()["detail"]


def test_a_recipe_outside_the_allowed_roots_is_not_read(client, tmp_path):
    client, cache = client
    recipe = tmp_path / "elsewhere" / "survey.yaml"
    params = {"recipe": str(recipe), "step": "file_mvbs"}
    assert client.get("/api/resolve", params=params).status_code == 403
    inside = {**params, "recipe": str(cache / "survey.yaml"),
              "config": str(tmp_path / "elsewhere" / "aa-recipe.config.yaml")}
    assert client.get("/api/resolve", params=inside).status_code == 403


def test_a_request_with_no_step_is_a_bad_request(client):
    client, cache = client
    answer = client.get("/api/resolve", params={"cache": str(cache)})
    assert answer.status_code == 400
    assert answer.json()["detail"] == "name a step"
    assert resolve(client, cache, var="nothing").status_code == 400


def test_open_answers_for_a_dataset_path(client):
    client, cache = client
    [store] = list((cache / "file_mvbs").glob("b0*/run1/zarr/ds_MVBS.zarr"))
    answer = client.get("/api/open", params={"path": str(store)})
    assert answer.status_code == 200
    [instance] = answer.json()["instances"]
    assert client.get(f"/mount/{instance['mount']}/Sv/.zarray").status_code == 200
    missing = client.get("/api/open", params={"path": str(cache / "nothing")})
    assert missing.status_code == 404


def test_a_host_allows_roots_as_sessions_open(cache):
    """Mounted under a prefix, with nothing readable until a root is added."""
    mounts = serve.Mounts([])
    app = FastAPI()
    app.include_router(build_router(mounts), prefix="/echogram")
    client = TestClient(app)
    params = {"cache": str(cache), "step": "file_mvbs"}
    assert client.get("/echogram/api/resolve", params=params).status_code == 403
    mounts.allow([str(cache)])
    found = client.get("/echogram/api/resolve", params=params).json()
    mount = found["instances"][0]["mount"]
    assert client.get(f"/echogram/mount/{mount}/Sv/.zarray").status_code == 200


class FailingSource:
    """A store whose reads raise, as an object store does when a token lapses."""

    def read(self, key):
        raise RuntimeError("token expired\nsecond line")


def test_a_read_that_raises_is_a_500_with_the_reason(cache):
    mounts = serve.Mounts()
    mount = mounts.add(str(cache / "anything"))
    mounts.sources[mount] = FailingSource()
    app = FastAPI()
    app.include_router(build_router(mounts))
    answer = TestClient(app).get(f"/mount/{mount}/Sv/0.0.0")
    assert answer.status_code == 500
    assert answer.json()["detail"] == "RuntimeError: token expired second line"


def test_a_deleted_dataset_is_a_500_with_the_reason(client):
    """The dataset is opened on the first chunk, which is where it fails."""
    client, cache = client
    found = resolve(client, cache).json()
    instance = found["instances"][0]
    shutil.rmtree(instance["store"])
    answer = client.get(f"/mount/{instance['mount']}/Sv/.zarray")
    assert answer.status_code == 500
    assert answer.json()["detail"]
    assert "\n" not in answer.json()["detail"]


def test_the_app_serves_a_store_and_an_app(tmp_path):
    store = tmp_path / "store.zarr"
    pyramid.build_pyramid(fixtures.synthetic(n_pings=8, n_samples=6), store)
    app = tmp_path / "app"
    (app / "assets").mkdir(parents=True)
    (app / "index.html").write_text("<title>viewer</title>", encoding="utf-8")
    (app / "assets" / "main.js").write_text("export {}", encoding="utf-8")
    client = TestClient(create_app(store=store, app_root=app))
    assert b"multiscales" in client.get("/store/zarr.json").content
    assert client.get("/store/0/Sv/c/9/9/9").status_code == 404
    assert client.get("/store/..%2F..%2Fsecret").status_code == 404
    assert b"viewer" in client.get("/").content
    script = client.get("/assets/main.js")
    assert script.headers["content-type"].startswith("text/javascript")
    assert client.get("/nothing.html").status_code == 404
