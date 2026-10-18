import io
import json

import pytest
import httpx

from coleo_inbox.api import Api
from coleo_inbox.communication_cli import run_communication


class FixtureApi:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def request(self, path, body=None, params=None, *, method=None):
        self.calls.append((path, body, params, method or ("POST" if body is not None else "GET")))
        assert self.responses, f"Unexpected request: {self.calls[-1]}"
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def page(key, items, total=None):
    return {key: items, "pagination": {"limit": 100, "offset": 0, "total": len(items) if total is None else total}}


async def invoke(args, responses=()):
    api, output = FixtureApi(responses), io.StringIO()
    code = await run_communication([*args, "--json"], api, output)
    return code, json.loads(output.getvalue()), api.calls


async def test_mail_send_legacy_defaults_and_custom_subject():
    _, _, calls = await invoke(["mail", "send", "hello"], [{"message": {"id": "sent"}}])
    assert calls == [("/api/mail/send", {"from": "human@local", "to": "brain@coleo.local",
        "subject": "New task: hello...", "body": "hello", "headers": {}}, None, "POST")]
    _, _, calls = await invoke(["mail", "send", "hello", "-s", "Subject"], [{"message": {}}])
    assert calls[0][1]["subject"] == "Subject"


async def test_mail_read_complete_lookup_encoded_id_and_partial_mark_failure():
    old = {"id": "old", "date": "2026-01-01T00:00:00Z"}
    newest = {"id": "new /?#", "date": "2026-10-01T00:00:00Z", "flags": {"seen": False},
              "body": "full body\n" * 100, "subject": "A message"}
    code, result, calls = await invoke(["mail", "read"], [page("messages", [old], 2),
        page("messages", [newest], 2), {"message": newest}, ValueError("write failed")])
    assert calls[1][2]["offset"] == 1
    assert calls[2][0] == "/api/mail/inbox/new%20%2F%3F%23"
    assert calls[3] == ("/api/mail/folders/inbox/messages/new%20%2F%3F%23/flags",
                        {"flags": {"seen": True}}, None, "PATCH")
    assert code == 2 and result["message"]["body"] == newest["body"]
    assert result["errors"][0]["operation"] == "mark-read"
    assert len(calls) == 4


async def test_mail_prefix_ambiguity_checks_later_pages_before_write():
    api = FixtureApi([page("messages", [{"id": "abc1"}], 2), page("messages", [{"id": "abc2"}], 2)])
    with pytest.raises(ValueError, match="Ambiguous"):
        await run_communication(["mail", "read", "abc"], api, io.StringIO())
    assert len(api.calls) == 2 and all(call[3] == "GET" for call in api.calls)


async def test_read_exact_id_preferred_and_seen_does_not_write():
    message = {"id": "abc", "flags": {"seen": True}, "body": "body"}
    _, result, calls = await invoke(["mail", "read", "abc"], [
        page("messages", [message, {"id": "abcdef"}]), {"message": message}])
    assert len(calls) == 2 and result["message"] == message


async def test_inbox_all_is_still_bounded_and_order_is_preserved():
    messages = [{"id": "new"}, {"id": "cur"}]
    _, result, calls = await invoke(["mail", "inbox", "--all", "-n", "2"], [page("messages", messages, 5)])
    assert result["messages"] == messages
    assert len(calls) == 1 and calls[0][2]["limit"] == 2


def discovery(identifier, **kwargs):
    return {"id": identifier, "title": "Test failure", "status": "open", "details": "complete details" * 100,
            "phase": "implementation", "updatedAt": "2026-01-01", "metadata": {}, **kwargs}


async def test_discovery_phase_filter_after_complete_pagination():
    a, b = discovery("a"), discovery("b", phase="verification")
    _, result, calls = await invoke(["discoveries", "list", "-p", "verification", "-l", "1"],
        [page("discoveries", [a], 2), page("discoveries", [b], 2)])
    assert result["discoveries"] == [b] and len(calls) == 2
    assert calls[0][2]["status"] == "open"


async def test_history_sorts_updates_and_preserves_reasons():
    older = discovery("a", status="dismissed", metadata={"resolution_reason": "duplicate"})
    newer = discovery("b", status="resolved", updatedAt="2026-10-01")
    _, result, _ = await invoke(["discoveries", "history"], [page("discoveries", [older, newer])])
    assert result["discoveries"] == [newer, older]


async def test_discovery_resolve_reason_and_encoded_exact_id():
    record = discovery("a/b")
    _, result, calls = await invoke(["discoveries", "resolve", "a/b", "-r", "dismissed", "--reason", "duplicate"],
        [page("discoveries", [record]), {"discovery": record}, {"success": True}])
    assert calls[-1] == ("/api/discoveries/a%2Fb", {"status": "dismissed", "reason": "duplicate",
                                                               "resolvedBy": "cli"}, None, "PATCH")
    assert result["status"] == "dismissed"


async def test_discovery_old_server_never_silently_drops_reason():
    record = discovery("a")
    del record["metadata"]
    api = FixtureApi([page("discoveries", [record]), {"discovery": record}])
    with pytest.raises(ValueError, match="metadata support"):
        await run_communication(["discoveries", "resolve", "test"], api, io.StringIO())
    assert len(api.calls) == 2


async def test_discovery_ambiguous_title_no_mutation():
    api = FixtureApi([page("discoveries", [discovery("a"), discovery("b")])])
    with pytest.raises(ValueError, match="Ambiguous"):
        await run_communication(["discoveries", "resolve", "test"], api, io.StringIO())
    assert len(api.calls) == 1


async def test_config_import_validates_and_redacts(tmp_path):
    file = tmp_path / "config.toml"
    file.write_text('[arm]\nname = "worker"\nharness = "opencode-api"\n')
    _, result, calls = await invoke(["config", "arms", "import", "worker config", str(file)],
        [{"filename": "worker config.toml", "raw": "SECRET", "config": {"apiKey": "SECRET"}}])
    assert calls[0][0] == "/api/config/arms/worker%20config" and calls[0][3] == "PUT"
    assert "SECRET" not in json.dumps(result)
    file.write_text("invalid toml")
    api = FixtureApi([])
    with pytest.raises(ValueError, match="Cannot import"):
        await run_communication(["config", "arms", "import", "worker", str(file)], api, io.StringIO())
    assert not api.calls


async def test_config_delete_is_explicit_and_never_retried():
    api = FixtureApi([ValueError("delete failed")])
    with pytest.raises(ValueError, match="delete failed"):
        await run_communication(["config", "arms", "delete", "worker"], api, io.StringIO())
    assert api.calls == [("/api/config/arms/worker", None, None, "DELETE")]


async def test_status_reports_filters_and_detail():
    _, _, calls = await invoke(["status-reports", "list", "--task-id", "t", "--arm-id", "a",
                               "--status", "blocked", "--since", "2026-01-01", "--offset", "3"],
                              [page("reports", [], 3)])
    assert calls[0][2] == {"taskId": "t", "armId": "a", "status": "blocked", "since": "2026-01-01",
                           "limit": 20, "offset": 3}
    _, result, calls = await invoke(["status-reports", "show", "r/a"], [{"report": {"id": "r/a", "issues": ["full"]}}])
    assert calls[0][0] == "/api/status-reports/r%2Fa" and result["report"]["issues"] == ["full"]


@pytest.mark.parametrize("args", [["mail", "send", ""], ["mail", "inbox", "-n", "0"],
    ["discoveries", "resolve", "test", "-r", "wrong"], ["discoveries", "resolve", "test", "--reason", " "],
    ["config", "arms", "delete", "../outside"], ["status-reports", "list", "--offset", "-1"],
    ["mail", "read", "--count", "2"]])
async def test_invalid_arguments_never_request(args):
    api = FixtureApi([])
    with pytest.raises(ValueError):
        await run_communication(args, api, io.StringIO())
    assert not api.calls


@pytest.mark.parametrize("args", [["mail", "read"], ["mail", "send"], ["discoveries", "resolve"],
    ["config", "arms", "import"], ["status-reports", "backfill"]])
async def test_help_is_offline_with_required_arguments(args):
    output = io.StringIO()
    assert await run_communication([*args, "--help"], None, output) == 0
    assert "usage:" in output.getvalue()


@pytest.mark.parametrize("args", [["discoveries", "summarize"], ["status-reports", "backfill"],
    ["discoveries", "summarize", "--task", "example", "-v"],
    ["status-reports", "backfill", "--project", "/absent", "--dry-run"]])
async def test_operator_disposition_is_offline(args):
    with pytest.raises(ValueError, match="Retained operator diagnostic"):
        await run_communication(args, None, io.StringIO())


async def test_rich_full_body_no_markup_interpretation():
    output = io.StringIO()
    message = {"id": "a", "flags": {"seen": True}, "body": "[red]literal[/red]\n" + "long " * 300}
    api = FixtureApi([page("messages", [message]), {"message": message}])
    assert await run_communication(["mail", "read", "a", "--color", "never"], api, output) == 0
    assert message["body"].rstrip() in output.getvalue()


async def test_incomplete_pagination_aborts_before_mutation():
    api = FixtureApi([page("messages", [{"id": "a"}], 2), page("messages", [], 2)])
    with pytest.raises(ValueError, match="Incomplete pagination"):
        await run_communication(["mail", "read", "a"], api, io.StringIO())
    assert all(call[3] == "GET" for call in api.calls)


async def test_real_transport_patch_and_non_json_failure_are_partial():
    requests = []
    message = {"id": "mail:1", "flags": {"seen": False}, "body": "complete body"}

    def handle(request):
        requests.append(request)
        if request.method == "PATCH":
            assert json.loads(request.content) == {"flags": {"seen": True}}
            return httpx.Response(503, text="upstream unavailable")
        if request.url.path == "/api/mail/inbox":
            return httpx.Response(200, json=page("messages", [message]))
        return httpx.Response(200, json={"message": message})

    api = Api("http://fixture", transport=httpx.MockTransport(handle))
    try:
        output = io.StringIO()
        assert await run_communication(["mail", "read", "mail:1", "--json"], api, output) == 2
        assert json.loads(output.getvalue())["message"]["body"] == "complete body"
        assert len(requests) == 3
        assert requests[-1].url.raw_path == b"/api/mail/folders/inbox/messages/mail%3A1/flags"
    finally:
        await api.close()


async def test_real_transport_config_delete():
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"deleted": True, "filename": "worker.toml"})

    api = Api("http://fixture", transport=httpx.MockTransport(handle))
    try:
        assert await run_communication(["config", "arms", "delete", "worker"], api, io.StringIO()) == 0
        assert len(requests) == 1 and requests[0].method == "DELETE"
    finally:
        await api.close()
