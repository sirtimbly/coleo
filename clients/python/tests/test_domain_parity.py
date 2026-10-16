"""Legacy domain cutover checks using owned HTTP fixtures only."""
import io
import json

import httpx
import pytest

from coleo_inbox.api import Api
from coleo_inbox.cli import run


@pytest.mark.parametrize("args,limit,status", [
    (["tasks", "list"], "20", None),
    (["tasks"], "100", None),
    (["tasks", "list", "-s", "claimed", "-n", "7"], "7", "claimed"),
    (["tasks", "--status", "pending", "list"], "20", "pending"),
    (["bugs", "list", "-s", "open"], "100", "open"),
])
async def test_list_legacy_alias_and_defaults(args, limit, status):
    calls = []
    def handle(request):
        calls.append(request)
        assert request.method == "GET"
        expected = {"limit": limit, "offset": "0"}
        if args[0] == "tasks" and "list" in args:
            expected["sort"] = "created-desc"
        if status:
            expected["status"] = status
        assert dict(request.url.params) == expected
        return httpx.Response(200, json={args[0]: [{"id": "one", "subject": "First"}],
                                         "pagination": {"total": 200}})
    output = io.StringIO()
    assert await run([*args, "--json"], api=Api("http://owned-fixture", transport=httpx.MockTransport(handle)),
                     stdout=output) == 0
    result = json.loads(output.getvalue())
    assert result["nextOffset"] == 1
    assert result["query"].get("sort") == ("created-desc" if args[0] == "tasks" and "list" in args else None)
    assert len(calls) == 1


@pytest.mark.parametrize("action,state", [("start", "running"), ("stop", "stopped"),
                                          ("pause", "paused"), ("resume", "running")])
async def test_brain_controls_one_api_write(action, state):
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.path == f"/api/brain/{action}"
        assert request.method == "POST" and json.loads(request.content) == {}
        return httpx.Response(200, json={"status": state})
    output = io.StringIO()
    assert await run(["brain", action, "--json"],
                     api=Api("http://owned-fixture", transport=httpx.MockTransport(handle)), stdout=output) == 0
    assert json.loads(output.getvalue())["result"]["status"] == state
    assert len(calls) == 1


@pytest.mark.parametrize("action", ["start", "stop", "pause", "resume"])
async def test_brain_failure_never_retries(action):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(503, json={"error": "Control failed"})
    output = io.StringIO()
    assert await run(["brain", action, "--json"],
                     api=Api("http://owned-fixture", transport=httpx.MockTransport(handle)), stdout=output) == 1
    assert "Control failed" in json.loads(output.getvalue())["error"]
    assert len(calls) == 1


async def test_brain_status_rich_and_offline_scope_help():
    calls = []
    def handle(request):
        calls.append(request)
        assert request.method == "GET" and request.url.path == "/api/brain/status"
        return httpx.Response(200, json={"brain": {"status": "running", "pollIntervalMs": 45678}})
    def api():
        return Api("http://owned-fixture", transport=httpx.MockTransport(handle))
    output = io.StringIO()
    assert await run(["brain", "status", "--color", "never"], api=api(), stdout=output) == 0
    assert "Poll interval (ms): 45678" in output.getvalue()
    output = io.StringIO()
    assert await run(["brain", "--help"], api=api(), stdout=output) == 0
    assert "coleo-server brain" in output.getvalue() and "selected API server" in output.getvalue()
    assert len(calls) == 1


@pytest.mark.parametrize("args", [["brain", "run"], ["brain", "restart"], ["brain", "logs"],
    ["brain", "prompt:task"], ["brain", "start", "--self-modify"],
    ["brain", "stop", "--force"], ["tasks", "list", "-n", "0"]])
async def test_local_brain_options_and_invalid_lists_do_not_send_requests(args):
    def handle(request):
        pytest.fail("Invalid or local-only operation sent a request")
    output = io.StringIO()
    assert await run([*args, "--json"], api=Api("http://owned-fixture", transport=httpx.MockTransport(handle)),
                     stdout=output) == 1
    assert json.loads(output.getvalue())["kind"] == "module.error"


async def test_inbox_legacy_views_and_validate_cutover(protocol, tmp_path):
    output = io.StringIO()
    assert await run(["views", "--json"], api=protocol.api(), stdout=output) == 0
    assert json.loads(output.getvalue())["views"] == ["inbox-triage"]
    path = tmp_path / "view.json"
    path.write_text(json.dumps(protocol.view["definition"]))
    output = io.StringIO()
    assert await run(["validate", str(path), "--json"], api=protocol.api(), stdout=output) == 0
    assert json.loads(output.getvalue())["definition"]["id"] == "inbox-triage"
    assert len(protocol.calls) == 1
