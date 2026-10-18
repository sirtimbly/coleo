"""Shared production-route conformance; mutations require explicit fixture opt-in."""
import os

import pytest

from coleo_inbox.api import Api
from coleo_inbox.app import InboxApp
from coleo_inbox.contracts import reference
from coleo_inbox.options import parse
from coleo_inbox.snapshot import load
from coleo_inbox.session import Session
from textual.widgets import Button, OptionList, Select, Tree

pytestmark = pytest.mark.skipif(not os.getenv("COLEO_TEST_API_URL"), reason="Set COLEO_TEST_API_URL for shared service conformance")


async def test_shared_http_and_headless_tui():
    api = Api(os.environ["COLEO_TEST_API_URL"])
    try:
        view = await api.view("inbox-triage")
        options = parse(["--facet", "messages", "--limit", "5", "--pages", "2", "--tree"], view)
        snapshot = await load(api, view, options)
        assert snapshot["items"], "Seed the shared fixture service before this test"
        target, detail = await api.inspect(reference(snapshot["items"][0]["id"]), options.query["profileId"])
        assert target["id"] == snapshot["items"][0]["id"]
        assert detail
        app = InboxApp(api, view, options)
        async with app.run_test(size=(120, 38)) as pilot:
            for _ in range(100):
                await pilot.pause(.05)
                if app.session.snapshot and app.session.connection == "live / authenticated":
                    break
            assert app.session.snapshot
            assert app.session.connection == "live / authenticated"
            await pilot.press("enter")
            await pilot.resize_terminal(70, 30)
            await pilot.press("escape", "f1", "escape")
    finally:
        await api.close()


@pytest.mark.skipif(os.getenv("COLEO_TEST_FIXTURE_WRITES") != "1", reason="Mutations require an owned disposable fixture server")
async def test_actual_tui_controls_without_keyboard_and_frozen_revision():
    api = Api(os.environ["COLEO_TEST_API_URL"])
    writes, responses = [], []
    request = api.request

    async def tracked(path, body=None, params=None):
        if path.endswith("/actions"):
            writes.append(body)
        result = await request(path, body, params)
        if path.endswith("/actions"):
            responses.append(result)
        return result

    api.request = tracked
    statuses = []

    async def response_status(response):
        if response.request.url.path.endswith("/actions"):
            statuses.append(response.status_code)

    api.client.event_hooks["response"] = [response_status]
    try:
        # This endpoint exists only in the isolated fixture service. It is also
        # the first write: an accidental live-API URL fails before mail actions.
        await api.request("/__test/control", {"action": "reset"})
        cli_view = await api.view("inbox-triage")
        actual_tui = await api.view("inbox-triage", "tui")
        for operation in ("inbox.facet", "inbox.mailbox", "inbox.brain-category", "collection.sort", "collection.presentation", "inbox.mark-read"):
            interaction = next(b for b in actual_tui["interactions"]["bindings"] if b["operation"] == operation)
            assert interaction["available"] is False
            assert interaction["keyboard"] == []
            assert "keyboard binding" in interaction["diagnostic"]

        app = InboxApp(api, cli_view, parse(["--facet", "messages"], cli_view), live=False)
        async with app.run_test(size=(150, 42)) as pilot:
            await pilot.pause()
            assert app.tui_view == actual_tui  # no patched availability fixture

            async def choose(identifier, value):
                if identifier == "facet":
                    facets = app.query_one("#facet", OptionList)
                    facets.highlighted = facets.get_option_index(value)
                    facets.action_select()
                else:
                    app.query_one(f"#{identifier}", Select).value = value
                await pilot.pause()

            await choose("facet", "brain")
            assert app.session.options.query["facet"] == "brain"
            await choose("category", "tasks")
            assert app.session.options.query["brainCategory"] == "tasks"
            await choose("mailbox", "sent")
            assert app.session.options.query["facet"] == "messages"
            assert app.session.options.query["mailbox"] == "sent"
            await choose("sort", "asc")
            assert app.session.options.query["sort"]["direction"] == "asc"
            await choose("presentation", "cards")
            assert app.query_one(Tree).display
            await choose("presentation", "grid")
            await choose("mailbox", "inbox")
            await app.session.refresh()
            await pilot.pause()

            def review():
                return next(i for i in app.session.snapshot["items"] if any(
                    n["id"] == "message:<review-api@example.test>" for n in i.get("thread", {}).get("hierarchy", {}).get("nodes", [])))

            item = review()
            app.focus_id = item["id"]
            app.update_view()
            await pilot.pause()
            await pilot.click("#branch")
            await pilot.pause()
            selected = set(app.session.selection.entries)
            old_revision = item["thread"]["revision"]
            assert selected
            assert not app.query_one("#read", Button).disabled

            change = await api.request("/__test/control", {"action": "add-reply"})
            assert change["previousRevision"] == old_revision
            await app.session.refresh()
            await pilot.pause()
            assert review()["thread"]["revision"] != old_revision
            assert set(app.session.selection.entries) == selected
            await pilot.click("#read")
            await pilot.pause()
            assert statuses == [409]
            assert writes[0]["revision"] == old_revision
            assert set(writes[0]["memberIds"]) == selected
            assert writes[0]["action"] == "read"
            assert not responses  # rejected, never retried or upgraded

            await app.session.refresh()
            item = review()
            app.focus_id = item["id"]
            app.update_view()
            await pilot.pause()
            await pilot.click("#branch")
            await pilot.pause()
            current_members = set(app.session.selection.entries)
            assert current_members > selected  # only explicit reselection adds reply
            await pilot.click("#read")
            await pilot.pause()
            assert statuses == [409, 200]
            assert writes[1]["revision"] == item["thread"]["revision"]
            assert set(writes[1]["memberIds"]) == current_members
            assert responses[0]["skippedMemberIds"]  # sent-only context remains explicit
            assert change["messageId"] in responses[0]["completedMessageIds"]
            assert not app.session.selection.entries
            await app.session.refresh()
            assert all(loc["seen"] for n in review()["thread"]["hierarchy"]["nodes"]
                       for loc in n["data"]["locations"] if loc["mailbox"] == "inbox")
    finally:
        try:
            await api.request("/__test/control", {"action": "reset"})
        finally:
            await api.close()


@pytest.mark.skipif(os.getenv("COLEO_TEST_FIXTURE_WRITES") != "1", reason="Mutations require an owned disposable fixture server")
async def test_incoming_read_invalidates_shared_thread_revision():
    api = Api(os.environ["COLEO_TEST_API_URL"])
    try:
        await api.request("/__test/control", {"action": "reset"})
        view = await api.view("inbox-triage")
        session = Session(api, view, parse(["--facet", "messages"], view))
        await session.refresh()
        member = "message:<review-api@example.test>"
        item = next(i for i in session.snapshot["items"] if any(
            n["id"] == member for n in i.get("thread", {}).get("hierarchy", {}).get("nodes", [])))
        session.selection.toggle(session.snapshot, item["id"], True)
        original_members = set(session.selection.entries)
        thread = item["thread"]
        from coleo_inbox.api import encoded
        incoming = await api.request(f"/api/mail/threads/{encoded(thread['id'])}/actions", {
            "mailbox": thread["mailbox"], "revision": thread["revision"], "memberIds": [member], "action": "read"})
        assert incoming["completedMessageIds"]
        await session.refresh()
        refreshed = next(i for i in session.snapshot["items"] if i["id"] == item["id"])
        assert refreshed["thread"]["revision"] != thread["revision"]
        assert set(session.selection.entries) == original_members  # membership unchanged
        plan = session.selection.plan(session.snapshot)
        assert plan["threads"][item["id"]]["revision"] == thread["revision"]
        result = await session.mark_read()
        assert "Thread changed" in result["error"]
        assert result["completedMessageIds"] == []
        assert result["completedItemIds"] == []
    finally:
        try:
            await api.request("/__test/control", {"action": "reset"})
        finally:
            await api.close()
