import io
import json
from pathlib import Path

import httpx
import pytest

from coleo_inbox.api import Api, ApiError
from coleo_inbox.cli import run
from coleo_inbox.connections import Connections, connection_arguments, validate_url
from coleo_inbox.module_catalog import ModuleCatalog, decode_catalog


@pytest.mark.parametrize("flags,env,expected,sources", [
    ({}, {}, ("http://saved", "saved-key", "one"), ("saved", "saved", "saved")),
    ({}, {"COLEO_API_URL": "http://env", "COLEO_API_KEY": "env-key"}, ("http://env", "env-key", "one"), ("saved", "environment", "environment")),
    ({"server": "http://flag"}, {"COLEO_API_URL": "http://env"}, ("http://flag", "saved-key", "one"), ("saved", "flag", "saved")),
    ({}, {"COLEO_CONNECTION": "two"}, ("http://second", "second-key", "two"), ("environment", "saved", "saved")),
    ({"connection": "one"}, {"COLEO_CONNECTION": "two", "COLEO_API_KEY": ""}, ("http://saved", "", "one"), ("flag", "saved", "environment")),
])
def test_precedence(flags, env, expected, sources):
    store = Connections()
    store.save("two", "http://second", "second-key")
    store.save("one", "http://saved", "saved-key")
    value = store.resolve(**flags, environ=env)
    assert (value.url, value.key, value.name) == expected
    assert tuple(value.sources.values()) == sources
    assert "key" not in repr(value)


def test_defaults_unknown_and_independent_catalog():
    store = Connections()
    assert store.resolve(environ={}).url == "http://127.0.0.1:8080"
    for flags in ({"connection": "missing"}, {"environ": {"COLEO_CONNECTION": "missing"}}):
        with pytest.raises(ValueError, match="Unknown connection"):
            store.resolve(**flags)
    store.save("one", "http://saved", "secret")
    catalog = ModuleCatalog()
    catalog.choose(catalog.path)
    store.use("one")
    assert ModuleCatalog().path == catalog.path
    assert Connections().resolve(environ={}).key == "secret"
    assert store.path.stat().st_mode & 0o777 == 0o600
    assert "secret" not in json.dumps(store.public())


def test_atomic_failure_and_invalid_storage(monkeypatch):
    store = Connections()
    store.save("one", "http://saved", "secret")
    original = store.path.read_bytes()
    def fail(*args):
        raise OSError("interrupted")
    monkeypatch.setattr(Path, "replace", fail)
    with pytest.raises(OSError):
        store.save("two", "http://second", "new")
    assert store.path.read_bytes() == original
    assert list(store.path.parent.iterdir()) == [store.path]
    store.path.write_text('{"connections":"secret"}')
    with pytest.raises(ValueError, match="repair or move") as exc:
        Connections()
    assert "secret" not in str(exc.value)


@pytest.mark.parametrize("url", ["ftp://host", "https://user:secret@host", "https://host?api_key=secret", "https://host#secret", "http://host:bad", "", "http://"])
def test_invalid_urls_redacted(url):
    with pytest.raises(ValueError) as exc:
        validate_url(url)
    assert "secret" not in str(exc.value)


def test_flags_and_reserved_commands():
    assert connection_arguments(["tasks", "--connection=prod", "--server", "http://host", "--profile", "view"])[0] == ["tasks", "--profile", "view"]
    catalog = ModuleCatalog()
    data = json.loads(catalog.path.read_text())
    for name in ("connect", "connections", "use", "doctor", "arms", "agents", "activity", "status", "mail", "discoveries", "config", "status-reports"):
        data["modules"][0]["id"] = name
        with pytest.raises(ValueError, match="reserved"):
            decode_catalog(json.dumps(data))


async def test_connect_failure_save_only_use_and_doctor(monkeypatch):
    store = Connections()
    store.save("original", "http://original", "secret")
    before = store.path.read_bytes()
    calls = []
    def reject(request):
        calls.append(request.url.path)
        return httpx.Response(401, text="<html>secret</html>")
    out = io.StringIO()
    assert await run(["connect", "http://fixture", "--name", "new", "--json"], Api("http://fixture", transport=httpx.MockTransport(reject)), out) == 1
    assert calls == ["/api/status"]
    assert store.path.read_bytes() == before
    assert "secret" not in out.getvalue()
    monkeypatch.setenv("COLEO_API_KEY", "saved-secret")
    assert await run(["connect", "http://fixture", "--name", "new", "--save-only", "--json"], stdout=io.StringIO()) == 0
    assert Connections().data["active"] == "new"
    assert await run(["use", "original"], stdout=io.StringIO()) == 0
    out = io.StringIO()
    assert await run(["doctor", "--json"], Api("http://fixture", transport=httpx.MockTransport(reject)), out) == 2
    report = json.loads(out.getvalue())
    assert report["checks"][0]["category"] == "authentication"
    assert "saved-secret" not in out.getvalue()


@pytest.mark.parametrize("args", [["--help"], ["--version"], ["tasks", "--help"], ["inbox", "--help"], ["tui", "--help"], ["connections", "--help"]])
async def test_offline_help_version_malformed_catalog(args):
    store = Connections()
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text("broken")
    (store.path.parent / "python-client.json").write_text("broken")
    (store.path.parent / "modules.json").write_text("broken")
    out = io.StringIO()
    assert await run(args, stdout=out, stderr=io.StringIO()) == 0
    assert out.getvalue()


async def test_methods_and_object_contract():
    calls = []
    def handle(request):
        calls.append((request.method, request.headers["X-API-Key"], dict(request.url.params)))
        return httpx.Response(200, json={"ok": True})
    api = Api("http://fixture", "secret", httpx.MockTransport(handle))
    try:
        assert await api.request("/api/test", None, {"a": "b"}) == {"ok": True}
        await api.request("/api/test", {})
        await api.request("/api/test", {}, method="PATCH")
        await api.request("/api/test", method="DELETE")
    finally:
        await api.close()
    assert [c[0] for c in calls] == ["GET", "POST", "PATCH", "DELETE"]
    assert calls[0][1:] == ("secret", {"a": "b"})


@pytest.mark.parametrize("status,category", [(401, "authentication"), (403, "authentication"), (404, "unsupported-capability"), (405, "unsupported-capability"), (500, "request"), (200, "invalid-response")])
async def test_http_categories(status, category):
    api = Api("http://fixture", "secret", httpx.MockTransport(lambda _: httpx.Response(status, text="secret")))
    try:
        with pytest.raises(ApiError) as exc:
            await api.request("/api/test")
        assert exc.value.category == category
        assert exc.value.status == status
        assert "secret" not in str(exc.value)
    finally:
        await api.close()


@pytest.mark.parametrize("error,category", [(httpx.ReadTimeout("secret"), "timeout"), (httpx.ConnectError("secret"), "unreachable"), (httpx.ConnectError("SSL certificate secret"), "tls")])
async def test_network_categories(error, category):
    def fail(_):
        raise error
    api = Api("http://fixture", "secret", httpx.MockTransport(fail))
    try:
        with pytest.raises(ApiError) as exc:
            await api.request("/api/test")
        assert exc.value.category == category
        assert "secret" not in str(exc.value)
    finally:
        await api.close()


async def test_doctor_metadata_redaction_and_no_auth_claim():
    store = Connections()
    store.save("one", "http://fixture", "secret")
    out = io.StringIO()
    api = Api("http://fixture", "secret", httpx.MockTransport(lambda _: httpx.Response(200, json={
        "version": "1.0", "projectName": "secret project", "apiKey": "secret", "capabilities": ["untrusted"]})))
    assert await run(["doctor", "--json"], api, out) == 0
    report = json.loads(out.getvalue())
    assert "secret" not in out.getvalue()
    assert report["checks"][0]["status"] == "accepted-mode-unknown"
    assert report["checks"][1]["capabilities"] == "unknown"


async def test_same_resolved_connection_for_tui_and_one_shot(monkeypatch):
    import coleo_inbox.cli as cli
    store = Connections()
    store.save("one", "http://saved", "saved-key")
    created, tui = [], []
    def make_api(url, key):
        created.append((url, key))
        return Api(url, key, httpx.MockTransport(lambda _: httpx.Response(200, json={"views": []})))
    async def workbench(api, *args, **kwargs):
        tui.append((api.url, api.key))
    monkeypatch.setattr(cli, "Api", make_api)
    monkeypatch.setattr(cli, "load_workbench", lambda: workbench)
    monkeypatch.setenv("COLEO_API_KEY", "env-key")
    for command in ("tui", "views"):
        assert await run(["--connection", "one", "--server", "http://override", command], stdout=io.StringIO()) == 0
    assert created == [("http://override", "env-key")] * 2
    assert tui == [created[0]]


def test_named_view_host_collisions(protocol):
    from copy import deepcopy
    from coleo_inbox.options import parse
    for name in ("--server", "--connection", "--version"):
        view = deepcopy(protocol.view)
        binding = next(b for b in view["interactions"]["bindings"] if b["available"] and b["operation"] != "collection.help")
        binding["cli"] = {"flag": name}
        with pytest.raises(ValueError, match="Conflicting flag"):
            parse([], view)
    for name in ("connect", "arms", "mail", "status-reports"):
        view = deepcopy(protocol.view)
        binding = next(b for b in view["interactions"]["bindings"] if b["available"])
        binding["cli"] = {"subcommand": name}
        with pytest.raises(ValueError, match="Conflicting command"):
            parse([], view)


async def test_connect_success_stdin_and_malformed_doctor(monkeypatch):
    calls = []
    def handle(request):
        calls.append((request.url.path, request.headers["X-API-Key"]))
        return httpx.Response(200, json={"version": "fixture"})
    import coleo_inbox.connection_cli as commands
    monkeypatch.setattr(commands, "Api", lambda url, key: Api(url, key, httpx.MockTransport(handle)))
    monkeypatch.setattr(commands.sys, "stdin", io.StringIO("stdin-secret\n"))
    monkeypatch.setenv("COLEO_API_KEY", "env-secret")
    out = io.StringIO()
    assert await run(["connect", "http://fixture", "--name", "new", "--key-stdin", "--json"], stdout=out) == 0
    assert calls == [("/api/status", "stdin-secret")]
    assert Connections().data["connections"]["new"]["key"] == "stdin-secret"
    assert "secret" not in out.getvalue()
    Connections().path.write_text("malformed-secret")
    out = io.StringIO()
    assert await run(["doctor", "--json"], stdout=out) == 2
    assert json.loads(out.getvalue())["checks"][0]["category"] == "invalid-configuration"
    assert "malformed-secret" not in out.getvalue()
