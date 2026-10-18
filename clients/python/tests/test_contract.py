import asyncio
import io
import json
from copy import deepcopy

import httpx
import pytest
from rich.console import Console

from coleo_inbox.api import Api
from coleo_inbox.cli import run
from coleo_inbox.contracts import compact, hierarchy, normalize, reference
from coleo_inbox.options import parse
from coleo_inbox.presentation import render
from coleo_inbox.presentation import age, source_label
from coleo_inbox.selection import Selection, execute, targets
from coleo_inbox.session import Session
from coleo_inbox.snapshot import load
from conftest import fixture


def test_query_canonicalization(protocol):
    q = normalize({"search": "  HELLO 日本語 ", "filters": [
        {"field": "kind", "operator": "in", "value": ["status", "brain", "status"]},
        {"field": "timestamp", "operator": "after", "value": "2026-10-09T13:00:00+01:00"}]})
    assert q["search"] == "hello 日本語"
    assert q["filters"][0]["value"] == ["brain", "status"]
    assert q["filters"][1]["value"] == "2026-10-09T12:00:00.000Z"
    assert compact(normalize(protocol.view["definition"]["query"])) == protocol.view["queryIdentity"]


@pytest.mark.parametrize("expansion", ["all", "roots", "collapsed"])
async def test_snapshot_exact_typescript_parity(protocol, expansion):
    api = protocol.api()
    snapshot = await load(api, protocol.view, parse(["--expand", expansion, "--metadata", "overview"], protocol.view))
    assert snapshot == fixture(f"expected-{expansion}")
    await api.close()


@pytest.mark.parametrize("args", [["--limit", "201"], ["--search", "a", "-s", "b"], ["--mailbox", "inbox", "--facet", "brain"], ["--brain-category", "tasks", "--mailbox", "sent"], ["--pages", "0"], ["--branch"], ["--json=yes"], ["wat"], ["show"], ["mark-read"], ["--unknown"], ["--width", "19"]])
def test_invalid_options(protocol, args):
    with pytest.raises(ValueError):
        parse(args, protocol.view)


def test_definition_aliases_inheritance(protocol):
    view = deepcopy(protocol.view)
    view["definition"]["query"]["filters"] = [{"field": "unread", "operator": "equals", "value": True}]
    binding = next(b for b in view["interactions"]["bindings"] if b["id"] == "search")
    binding["cli"] = {"flag": "--find", "alias": "-f"}
    o = parse(["-f", "ABC", "--mailbox", "sent", "--profile", "other"], view)
    assert o.query["facet"] == "messages" and o.query["mailbox"] == "sent"
    assert o.query["filters"] and o.query["profileId"] == "other"
    assert o.query["search"] == "abc"


async def test_cli_snapshots_and_independent_show(protocol):
    out = io.StringIO()
    assert await run(["--pages", "2", "--tree", "--metadata", "overview", "--json"], protocol.api(), out) == 0
    result = json.loads(out.getvalue())
    assert result["kind"] == "inbox.snapshot"
    assert result["traversal"] == dict(loadedPages=2, requestedPages=2, nextCursor=None, retryCursor=None, exhausted=True)
    assert len(result["items"]) == 2 and len(result["rows"]) > 2
    assert result["metadata"][0]["scope"] == "query"
    protocol.calls.clear()
    out = io.StringIO()
    assert await run(["show", reference(result["items"][0]["id"]), "--search", "no-match", "--cursor", "unrelated", "--json"], protocol.api(), out) == 0
    assert json.loads(out.getvalue())["kind"] == "inbox.detail"
    assert not any(c[1] == "/api/workbench/inbox" for c in protocol.calls)


async def test_partial_exit_and_no_write(protocol):
    protocol.partial = True
    out = io.StringIO()
    assert await run(["--json"], protocol.api(), out) == 2
    assert json.loads(out.getvalue())["traversal"]["nextCursor"] is None
    assert await run(["mark-read", "thread:" + protocol.thread["id"], "--json"], protocol.api(), io.StringIO()) == 1
    assert not any(c[0] == "POST" for c in protocol.calls)


async def test_exact_branch_revision_and_skip(protocol):
    api = protocol.api()
    snapshot = await load(api, protocol.view, parse([], protocol.view))
    rows, _ = hierarchy(protocol.thread)
    member = next(n["id"] for n, _ in rows if n["selectable"])
    selected = targets(snapshot, [reference(member)], True)
    result = await execute(api, selected)
    assert len(result["selectedMemberIds"]) == 3
    assert len(result["skippedMemberIds"]) == 1
    post = next(c for c in protocol.calls if c[0] == "POST")
    assert post[3] == {"mailbox": "inbox", "revision": "fixture-revision-1", "memberIds": result["selectedMemberIds"], "action": "read"}
    protocol.stale = True
    failed = await execute(api, selected)
    assert "Thread changed" in failed["error"] and not failed["completedItemIds"]
    await api.close()


async def test_selection_freezes_new_replies_and_revisions(protocol):
    api = protocol.api()
    snapshot = await load(api, protocol.view, parse([], protocol.view))
    selection = Selection()
    selection.toggle(snapshot, snapshot["items"][0]["id"], True)
    original = set(selection.entries)
    changed = deepcopy(snapshot)
    thread = changed["items"][0]["thread"]
    node = deepcopy(next(n for n in thread["hierarchy"]["nodes"] if n["selectable"]))
    node["id"] = "new-reply"
    thread["hierarchy"]["nodes"].append(node)
    thread["revision"] = "new"
    assert set(selection.entries) == original
    plan = selection.plan(changed)
    assert next(iter(plan["threads"].values()))["revision"] == "fixture-revision-1"
    assert "new-reply" not in next(iter(plan["threads"].values()))["memberIds"]
    await api.close()


@pytest.mark.parametrize("mode", ["grid", "cards", "timeline"])
@pytest.mark.parametrize("width", [20, 45, 100])
async def test_rich_width_unicode(protocol, mode, width):
    api = protocol.api()
    o = parse(["--presentation", mode, "--tree"], protocol.view)
    snapshot = await load(api, protocol.view, o)
    out = io.StringIO()
    console = Console(file=out, width=width, color_system=None)
    console.print(render(snapshot, width))
    assert "\x1b" not in out.getvalue()
    from rich.cells import cell_len
    assert all(cell_len(line) <= width for line in out.getvalue().splitlines())
    await api.close()


async def test_obsolete_refresh_and_retained_failure(protocol):
    api = protocol.api()
    session = Session(api, protocol.view, parse([], protocol.view))
    original = api.page
    started, release = asyncio.Event(), asyncio.Event()
    async def delayed(q, cursor=None):
        started.set()
        await release.wait()
        return await original(q, cursor)
    api.page = delayed
    task = asyncio.create_task(session.refresh())
    await started.wait()
    session.query(search="new")
    release.set()
    await task
    assert session.snapshot is None
    api.page = original
    await session.refresh()
    async def broken(*args):
        raise ValueError("offline")
    api.page = broken
    await session.refresh()
    assert not session.snapshot["complete"] and session.snapshot["items"]
    assert "Retained" in session.snapshot["diagnostics"][0]
    await api.close()


async def test_wrong_identity_rejected(protocol):
    def handler(request):
        response = protocol.handle(request)
        data = response.json()
        if request.url.path == "/api/workbench/inbox":
            data["queryId"] = "wrong"
        return httpx.Response(200, json=data)
    api = Api("http://fixture", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError, match="another query"):
        await api.page(normalize({}))
    await api.close()


async def test_partial_action_reports_completed_without_retry(protocol):
    def handler(request):
        if request.url.path == "/api/workbench/attention/bulk":
            return httpx.Response(503, json={"error": "Attention store unavailable"})
        return protocol.handle(request)
    api = Api("http://fixture", transport=httpx.MockTransport(handler))
    snapshot = await load(api, protocol.view, parse(["--pages", "2"], protocol.view))
    plan = targets(snapshot, [i["id"] for i in snapshot["items"]])
    result = await execute(api, plan)
    assert result["completedItemIds"] == [snapshot["items"][0]["id"]]
    assert len(result["completedMessageIds"]) == 2
    assert result["error"] == "Attention store unavailable"
    assert sum(c[0] == "POST" for c in protocol.calls) == 1
    await api.close()


async def test_all_targets_validated_before_write(protocol):
    api = protocol.api()
    snapshot = await load(api, protocol.view, parse([], protocol.view))
    with pytest.raises(ValueError, match="not loaded"):
        targets(snapshot, [snapshot["items"][0]["id"], "nonexistent"])
    assert not any(c[0] == "POST" for c in protocol.calls)
    await api.close()


@pytest.mark.parametrize("mode", ["grid", "cards", "timeline"])
async def test_compact_text_retains_full_wire_cursor_and_time(protocol, mode):
    api = protocol.api()
    snapshot = await load(api, protocol.view, parse(["--presentation", mode, "--metadata", "overview"], protocol.view))
    cursor = "eyJzY2hlbWFWZXJzaW9u" * 100
    snapshot["traversal"]["nextCursor"] = cursor
    snapshot["rows"][0]["values"]["source"] = "Inbox · 5 messages"
    before = deepcopy(snapshot)
    output = io.StringIO()
    Console(file=output, width=100, color_system=None).print(render(snapshot, 100))
    text = output.getvalue()
    assert "cursor in --json" in text
    assert "eyJzY2hlbWFWZXJzaW9u" not in text
    assert snapshot["items"][0]["timestamp"] not in text
    assert "Query: 2 total · 2 unread · 0 need action" in text
    assert "Sources: records fresh" in text
    if mode != "timeline":
        assert "Inbox (5)" in text
    assert snapshot == before  # display policy must not rewrite the wire envelope
    await api.close()


def test_short_age_and_source_labels():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    assert age("2026-10-09T11:55:00Z", now) == "5m"
    assert age("2026-10-09T10:00:00Z", now) == "2h"
    assert age("2026-10-01T12:00:00Z", now) == "8d"
    assert age("2026-10-10T12:00:00Z", now) == "in 1d"
    assert age("2025-10-01T12:00:00Z", now) == "2025-10-01"
    assert age("invalid", now) == "unknown"
    assert source_label("Inbox · 5 messages") == "Inbox (5)"
    assert source_label("Sent · 1 message") == "Sent (1)"
    assert source_label("Arm A") == "Arm A"


async def test_unknown_counts_and_partial_source_visible(protocol):
    protocol.partial = True
    api = protocol.api()
    snapshot = await load(api, protocol.view, parse(["--facet", "messages"], protocol.view))
    output = io.StringIO()
    Console(file=output, width=100, color_system=None).print(render(snapshot, 100))
    text = output.getvalue()
    assert "unknown total" in text and "unknown unread" in text
    assert "Sources: mail unavailable/partial" in text
    assert "PARTIAL" in text
    await api.close()
