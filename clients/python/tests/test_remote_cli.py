import asyncio
import io
import json

import httpx
import pytest

from coleo_inbox.api import Api
from coleo_inbox.remote_cli import run_remote


async def invoke(args, handler):
    output = io.StringIO()
    api = Api("http://fixture", transport=httpx.MockTransport(handler))
    try:
        code = await run_remote(args, api, output)
    finally:
        await api.close()
    return code, output.getvalue()


@pytest.mark.parametrize("args", [
    ["arms", "prompt", "a", " "], ["arms", "kill"], ["arms", "kill", "a", "--all"],
    ["arms", "spawn", "--harness", "manual"], ["arms", "watch", "a", "--interval", "0"],
    ["activity", "search", "query", "--min-score", "nan"],
    ["activity", "transcript", "--since", "yesterday"],
    ["activity", "transcript", "--since", "2026-02-02T00:00:00Z", "--until", "2026-01-01T00:00:00Z"],
    ["activity", "list", "--pages", "2"], ["agents", "show"], ["agents", "list", "a"],
    ["status", "extra"], ["arms", "logs", "a"],
])
async def test_validation_before_http(args):
    def handle(request):
        pytest.fail(f"Unexpected HTTP request: {request}")
    with pytest.raises(ValueError):
        await invoke(args, handle)


@pytest.mark.parametrize("family", ["arms", "activity", "agents", "status"])
async def test_offline_help(family):
    code, text = await invoke([family, "--help"], lambda request: pytest.fail("HTTP during help"))
    assert code == 0 and "usage:" in text


@pytest.mark.parametrize("args,path,method,body", [
    (["arm", "status", "a/b ?"], "/api/arms/a%2Fb%20%3F", "GET", None),
    (["agents", "show", "a/b ?"], "/api/agents/a%2Fb%20%3F", "GET", None),
    (["agents", "arms", "a/b ?"], "/api/agents/a%2Fb%20%3F/arms", "GET", None),
    (["arms", "kill", "a/b ?"], "/api/arms/a%2Fb%20%3F/kill", "POST", {}),
    (["arms", "recover", "a/b ?"], "/api/arms/a%2Fb%20%3F/recover", "POST", {}),
    (["arms", "prompt", "a/b ?", "hello", "--interrupt"], "/api/arms/a%2Fb%20%3F/prompt", "POST",
     {"prompt": "hello", "interrupt": True}),
    (["status"], "/api/status", "GET", None),
])
async def test_encoded_routes_and_mutations(args, path, method, body):
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.raw_path.decode() == path
        assert request.method == method
        if body is not None:
            assert json.loads(request.content) == body
        return httpx.Response(200, json={"ok": True})
    code, text = await invoke([*args, "--json"], handle)
    assert code == 0 and json.loads(text)["schemaVersion"] == 1
    assert len(calls) == 1


async def test_mutation_failure_is_not_retried():
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(500, json={"error": "runtime timeout"})
    with pytest.raises(ValueError, match="runtime timeout"):
        await invoke(["arms", "kill", "a"], handle)
    assert len(calls) == 1


async def test_spawn_fields_and_partial_failure():
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"arms": []})
        body = json.loads(request.content)
        assert body["workdir"] == "/remote/project"
        assert body["provider"] == "openai" and body["model"] == "model"
        assert body["template"] == "worker" and body["harness"] == "opencode-api"
        if request.url.path.endswith("/spawn"):
            assert body["initialPrompt"] == "do work"
            assert body["agentId"] == "host/1" and body["allowLocalFallback"] is False
            return httpx.Response(503, json={"error": "host offline"})
        assert body["name"] == "a/b"
        return httpx.Response(201, json={"arm": {"id": "a/b"}})
    code, text = await invoke(["arms", "spawn", "--name", "a/b", "--workdir", "/remote/project",
                               "--provider", "openai", "--model", "model", "--template", "worker",
                               "--harness", "opencode-api", "--prompt", "do work", "--agent", "host/1", "--json"], handle)
    result = json.loads(text)
    assert code == 2 and result["created"] and result["stage"] == "spawn"
    assert result["armId"] == "a/b" and "host offline" in result["error"]
    assert len(calls) == 3 and calls[-1].url.raw_path == b"/api/arms/a%2Fb/spawn"


async def test_spawn_existing_does_not_create_or_expand_local_defaults():
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"arms": [{"id": "a", "status": "stopped"}]})
        assert request.url.path == "/api/arms/a/spawn"
        assert json.loads(request.content) == {"name": "a", "recover": True}
        return httpx.Response(200, json={"spawned": True})
    assert (await invoke(["arms", "spawn", "--name", "a", "--recover", "--json"], handle))[0] == 0
    assert len(calls) == 2


async def test_cleanup_reports_partial_and_rechecks_stopped():
    deletes = []
    def handle(request):
        if request.url.path == "/api/arms":
            assert request.url.params["includeAll"] == "true"
            return httpx.Response(200, json={"arms": [{"id": x, "status": "stopped"} for x in ("a", "b", "c")]})
        if request.method == "GET":
            return httpx.Response(200, json={"arm": {"status": "busy" if request.url.path.endswith("/b") else "stopped"}})
        assert request.method == "DELETE"
        deletes.append(request.url.path)
        return httpx.Response(500, json={"error": "delete failed"}) if request.url.path.endswith("/c") else httpx.Response(200, json={"deleted": True})
    code, text = await invoke(["arms", "cleanup", "--json"], handle)
    assert code == 2 and deletes == ["/api/arms/a", "/api/arms/c"]
    assert [row["ok"] for row in json.loads(text)["results"]] == [True, False, False]


async def test_list_hides_stopped_and_rich_does_not_interpret_markup():
    def handle(request):
        return httpx.Response(200, json={"arms": [{"id": "[red]worker[/red]", "status": "busy"},
                                                 {"id": "stopped-arm", "status": "stopped"}]})
    code, text = await invoke(["arms", "list", "--color", "never"], handle)
    assert code == 0 and "[red]worker[/red]" in text and "stopped-arm" not in text
    _, text = await invoke(["arms", "list", "--all", "--json"], handle)
    assert len(json.loads(text)["arms"]) == 2


def event(second, text="hello"):
    return {"timestamp": f"2026-01-01T00:00:{second:02d}Z", "armId": "a", "action": "message", "text": text}


async def test_activity_cursor_pagination_and_dedup():
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.params["producer"] == "brain"
        if len(calls) == 1:
            return httpx.Response(200, json={"activity": [{**event(2), "sequence": 2}],
                                            "pagination": {"hasMore": True, "nextCursor": 2}})
        assert request.url.params["beforeSequence"] == "2"
        return httpx.Response(200, json={"activity": [{**event(1), "sequence": 1}, {**event(2), "sequence": 2}],
                                        "pagination": {"hasMore": False}})
    code, text = await invoke(["activity", "list", "--producer", "brain", "--pages", "3", "--json"], handle)
    assert code == 0 and [row["sequence"] for row in json.loads(text)["activity"]] == [1, 2]
    assert len(calls) == 2


async def test_transcript_poll_overlap_stable_order_and_filter(monkeypatch):
    async def sleep(_):
        pass
    monkeypatch.setattr("coleo_inbox.remote_common.asyncio.sleep", sleep)
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.params["armId"] == "a/b"
        if len(calls) == 1:
            assert request.url.params["afterSequence"] == "0"
            rows = [event(2), event(1)]
        else:
            assert "afterSequence" not in request.url.params
            assert request.url.params["since"] == event(2)["timestamp"]
            rows = [event(2), event(3)]
        return httpx.Response(200, json={"transcript": rows, "pagination": {"hasMore": False}})
    code, text = await invoke(["arms", "tail", "a/b", "--filter", "message", "--polls", "2", "--json"], handle)
    assert code == 0
    assert [json.loads(line)["record"]["timestamp"] for line in text.splitlines()] == [event(i)["timestamp"] for i in (1, 2, 3)]


async def test_tail_saturation_is_explicit(monkeypatch):
    async def sleep(_):
        pass
    monkeypatch.setattr("coleo_inbox.remote_common.asyncio.sleep", sleep)
    def handle(request):
        return httpx.Response(200, json={"transcript": [event(1)], "pagination": {"hasMore": True}})
    code, text = await invoke(["activity", "tail", "--polls", "3", "--json"], handle)
    assert code == 2 and json.loads(text.splitlines()[-1])["kind"] == "stream.gap"


async def test_stream_cancellation_propagates_without_retry():
    calls = []
    ready = asyncio.Event()
    def handle(request):
        calls.append(request)
        ready.set()
        return httpx.Response(200, json={"transcript": [], "pagination": {"hasMore": False}})
    task = asyncio.create_task(invoke(["activity", "tail", "--json"], handle))
    await ready.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(calls) == 1


async def test_watch_updates_session_and_history_zero(monkeypatch):
    async def sleep(_):
        pass
    monkeypatch.setattr("coleo_inbox.remote_common.asyncio.sleep", sleep)
    calls = []
    def handle(request):
        calls.append(request)
        index = len(calls)
        message = {"info": {"id": "m", "role": "assistant"},
                   "parts": [{"type": "text", "text": "old" if index == 1 else "updated"},
                             {"type": "tool", "name": "read"}]}
        return httpx.Response(200, json={"messages": [message], "sessionId": "new" if index == 4 else "old"})
    code, text = await invoke(["arms", "watch", "a", "--history", "0", "--no-tools", "--polls", "4", "--json"], handle)
    lines = [json.loads(line) for line in text.splitlines()]
    assert code == 0 and len(lines) == 2
    assert [row["sessionId"] for row in lines] == ["old", "new"]
    assert lines[0]["record"]["parts"] == [{"type": "text", "text": "updated"}]


async def test_search_multi_arm_filters_and_score_merge():
    calls = []
    def handle(request):
        body = json.loads(request.content)
        calls.append(body)
        assert body["types"] == ["arm_transcript"]
        assert body["filters"]["host"] == "remote"
        arm = body["filters"]["arm_id"]
        return httpx.Response(200, json={"results": [{"id": arm, "score": 0.8 if arm == "b" else 0.5}],
                                        "semanticUsed": True, "took": 1})
    code, text = await invoke(["activity", "search", "query", "--arm", "a,b", "--host", "remote", "--count", "1", "--json"], handle)
    assert code == 0 and json.loads(text)["results"][0]["id"] == "b" and len(calls) == 2


async def test_messages_api_error_is_not_empty_success():
    with pytest.raises(ValueError, match="not running"):
        await invoke(["arms", "messages", "a"], lambda request: httpx.Response(200, json={"messages": [], "error": "not running"}))


async def test_create_failure_never_spawns_or_retries():
    calls = []
    def handle(request):
        calls.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"arms": []})
        assert request.url.path == "/api/arms"
        return httpx.Response(409, json={"error": "name already registered"})
    with pytest.raises(ValueError, match="already registered"):
        await invoke(["arms", "spawn", "--name", "a"], handle)
    assert len(calls) == 2


async def test_active_arm_spawn_rejected_before_write():
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"arms": [{"id": "a", "status": "busy"}]})
    with pytest.raises(ValueError, match="already exists"):
        await invoke(["arms", "spawn", "--name", "a"], handle)
    assert len(calls) == 1


async def test_remove_encodes_id_and_uses_delete():
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.raw_path == b"/api/arms/a%2Fb"
        if request.method == "GET":
            return httpx.Response(200, json={"arm": {"status": "stopped"}})
        assert request.method == "DELETE"
        return httpx.Response(200, json={"deleted": True})
    code, text = await invoke(["arms", "remove", "a/b", "--json"], handle)
    assert code == 0 and json.loads(text)["deleted"] and len(calls) == 2


async def test_repeated_cursor_fails_instead_of_looping():
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"activity": [], "pagination": {"hasMore": True, "nextCursor": 4}})
    with pytest.raises(ValueError, match="repeated"):
        await invoke(["activity", "list", "--producer", "brain", "--pages", "100"], handle)
    assert len(calls) == 2


async def test_message_window_gap_is_partial(monkeypatch):
    async def sleep(_):
        pass
    monkeypatch.setattr("coleo_inbox.remote_common.asyncio.sleep", sleep)
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"messages": [{"info": {"id": str(len(calls)), "role": "user"}, "parts": []}],
                                        "sessionId": "same", "truncated": True})
    code, text = await invoke(["arms", "watch", "a", "--polls", "4", "--json"], handle)
    assert code == 2 and len(calls) == 2
    assert json.loads(text.splitlines()[-1])["kind"] == "stream.gap"


async def test_transcript_filter_mapping():
    def handle(request):
        assert request.url.path == "/api/activity/transcript"
        params = request.url.params
        assert params["armId"] == "a,b" and params["host"] == "host" and params["project"] == "project"
        assert params["since"] == "2026-01-01T00:00:00Z" and params["until"] == "2026-02-01T00:00:00Z"
        assert params["limit"] == "99" and params["scanLimit"] == "5000"
        return httpx.Response(200, json={"transcript": [event(1)], "pagination": {"hasMore": True}})
    code, text = await invoke(["activity", "transcript", "--arm", "a,b", "--host", "host", "--project", "project",
                               "--since", "2026-01-01T00:00:00Z", "--until", "2026-02-01T00:00:00Z",
                               "--count", "99", "--json"], handle)
    assert code == 0 and json.loads(text)["pagination"]["hasMore"]


async def test_names_are_offline_and_unique():
    code, text = await invoke(["arms", "names", "--count", "100", "--stats", "--json"],
                              lambda request: pytest.fail("Name suggestions must not access runtime state"))
    result = json.loads(text)
    assert code == 0 and len(result["names"]) == len(set(result["names"])) == 100
    assert result["stats"]["prefixes"] == 56


async def test_sequence_tail_preserves_identical_events_and_stream_order(monkeypatch):
    async def sleep(_):
        pass
    monkeypatch.setattr("coleo_inbox.remote_common.asyncio.sleep", sleep)
    calls = []
    def handle(request):
        calls.append(request)
        cursor = int(request.url.params["afterSequence"])
        assert cursor == len(calls) - 1
        # Equal content/time must not be signature-deduped, and late timestamps
        # must not be skipped. The cursor is a stream position, not event time.
        stamp = 2 if cursor < 2 else 1
        assert request.url.params["since"] == "2026-01-01T00:00:00Z"
        return httpx.Response(200, json={"transcript": [{**event(stamp), "sequence": cursor + 1}],
                                        "pagination": {"cursorMode": "sequence-v1", "nextCursor": cursor + 1,
                                                       "highWatermark": 3, "hasMore": cursor < 2, "gap": None}})
    code, text = await invoke(["activity", "tail", "--polls", "3", "--since", "2026-01-01T00:00:00Z", "--json"], handle)
    rows = [json.loads(line)["record"] for line in text.splitlines()]
    assert code == 0 and [row["sequence"] for row in rows] == [1, 2, 3]
    assert [row["timestamp"] for row in rows] == [event(i)["timestamp"] for i in (2, 2, 1)]


async def test_sequence_tail_continues_empty_filtered_scan_pages(monkeypatch):
    async def sleep(_):
        pass
    monkeypatch.setattr("coleo_inbox.remote_common.asyncio.sleep", sleep)
    calls = []
    def handle(request):
        calls.append(request)
        cursor = int(request.url.params["afterSequence"])
        assert cursor == (len(calls) - 1) * 2
        rows = [] if cursor == 0 else [{**event(1), "sequence": 4}]
        return httpx.Response(200, json={"transcript": rows,
                                        "pagination": {"cursorMode": "sequence-v1", "nextCursor": cursor + 2,
                                                       "highWatermark": 4, "hasMore": cursor == 0}})
    code, text = await invoke(["activity", "tail", "--polls", "2", "--json"], handle)
    assert code == 0 and len(text.splitlines()) == 1 and json.loads(text)["record"]["sequence"] == 4


@pytest.mark.parametrize("gap", ["retention", "missing-sequences", "cursor-ahead-of-stream"])
async def test_sequence_tail_gap_is_explicit_partial(gap):
    def handle(request):
        return httpx.Response(200, json={"transcript": [], "pagination": {
            "cursorMode": "sequence-v1", "nextCursor": 0, "highWatermark": 2, "gap": gap,
        }})
    code, text = await invoke(["activity", "tail", "--once", "--json"], handle)
    assert code == 2 and json.loads(text)["kind"] == "stream.gap"
    assert json.loads(text)["pagination"]["gap"] == gap


@pytest.mark.parametrize("pagination,rows", [
    ({"nextCursor": 0, "hasMore": True}, []),
    ({"nextCursor": "1"}, []),
    ({"nextCursor": 4}, []),
    ({"nextCursor": 2}, [{**event(1), "sequence": 2}, {**event(1), "sequence": 1}]),
    ({"nextCursor": 2}, [{**event(1), "sequence": 1}, {**event(1), "sequence": 1}]),
])
async def test_sequence_tail_rejects_invalid_cursor_contract(pagination, rows):
    def handle(request):
        return httpx.Response(200, json={"transcript": rows, "pagination": {
            "cursorMode": "sequence-v1", "highWatermark": 3, **pagination,
        }})
    with pytest.raises(ValueError, match="sequence"):
        await invoke(["activity", "tail", "--once", "--json"], handle)


async def test_sequence_tail_does_not_silently_downgrade_after_cursor_support(monkeypatch):
    async def sleep(_):
        pass
    monkeypatch.setattr("coleo_inbox.remote_common.asyncio.sleep", sleep)
    calls = []
    def handle(request):
        calls.append(request)
        pagination = {"cursorMode": "sequence-v1", "nextCursor": 0, "highWatermark": 0} if len(calls) == 1 else {}
        return httpx.Response(200, json={"transcript": [], "pagination": pagination})
    with pytest.raises(ValueError, match="stopped providing"):
        await invoke(["activity", "tail", "--polls", "2", "--json"], handle)
