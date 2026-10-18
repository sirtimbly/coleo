import asyncio
import io
import json
from copy import deepcopy

import httpx
import pytest
from textual.widgets import DataTable, Input, Markdown, OptionList, Static

from coleo_inbox.api import Api
from coleo_inbox.detail_document import DetailDocument
from coleo_inbox.cli import run
from coleo_inbox.module_app import ModuleApp, ModulePicker
from coleo_inbox.modules import collection, inspect_record


def test_named_views_cannot_shadow_domain_commands(protocol):
    from coleo_inbox.options import parse

    view = deepcopy(protocol.view)
    command = next(b for b in view["interactions"]["bindings"] if (b.get("cli") or {}).get("subcommand"))
    command["cli"]["subcommand"] = "tasks"
    with pytest.raises(ValueError, match="Conflicting command"):
        parse([], view)


class DomainProtocol:
    def __init__(self):
        self.calls = []
        self.fail = set()
        self.task_status = "pending"
        self.brain_status = "stopped"

    def handle(self, request):
        path = request.url.path
        query = dict(request.url.params)
        self.calls.append((request.method, path, query))
        if path in self.fail:
            return httpx.Response(503, json={"error": "Temporarily unavailable"})
        if path in ("/api/tasks", "/api/bugs"):
            module = path.rsplit("/", 1)[-1]
            start = int(query.get("offset", 0))
            items = [dict(id=f"{module}-{i}", subject=f"[bold]Task {i}", title=f"Bug {i}",
                          status=self.task_status if module == "tasks" else "open", priority="high")
                     for i in range(start, min(101, start + int(query.get("limit", 100))))]
            data = {module: items, "pagination": {"total": 101}}
        elif path.endswith("/stats"):
            data = {"total": 101, "byStatus": {"pending": 101}, "active": 1, "unresolved": 2}
        elif path == "/api/brain/status":
            data = {"brain": {"status": self.brain_status, "activeArmsCount": 2,
                              "plan": {"status": "healthy", "detail": "Ready"}}}
        elif path in ("/api/brain/start", "/api/brain/stop"):
            assert request.method == "POST" and json.loads(request.content) == {}
            self.brain_status = "running" if path.endswith("start") else "stopped"
            data = {"status": self.brain_status}
        elif path.startswith("/api/tasks/") or path.startswith("/api/bugs/"):
            module, identifier = path.split("/", 3)[2:]
            data = {"task" if module == "tasks" else "bug": dict(
                id=identifier, title="Full details", status=self.task_status,
                description="Full description with Unicode 🐙", resolution="Resolved all symptoms")}
        else:
            return httpx.Response(404, json={"error": path})
        return httpx.Response(200, json=data)

    def api(self):
        return Api("http://fixture", transport=httpx.MockTransport(self.handle))


async def test_domain_cli_paging_details_actions_and_partial_dashboard():
    protocol = DomainProtocol()
    output = io.StringIO()
    assert await run(["tasks", "--search", "urgent work", "--status", "blocked", "--offset", "100", "--json"],
                     api=protocol.api(), stdout=output) == 0
    result = json.loads(output.getvalue())
    assert result["items"][0]["id"] == "tasks-100" and result["nextOffset"] is None
    assert protocol.calls[-1][2] == {"limit": "100", "offset": "100", "search": "urgent work", "status": "blocked"}
    output = io.StringIO()
    assert await run(["bugs", "show", "bug/with:unicode-🐙", "--json"], api=protocol.api(), stdout=output) == 0
    assert json.loads(output.getvalue())["item"]["id"] == "bug/with:unicode-🐙"
    assert await run(["brain", "start", "--json"], api=protocol.api(), stdout=io.StringIO()) == 0
    assert protocol.brain_status == "running"
    protocol.fail.add("/api/bugs/stats")
    output = io.StringIO()
    assert await run(["dashboard", "--json"], api=protocol.api(), stdout=output) == 2
    result = json.loads(output.getvalue())
    assert set(result["sources"]) == {"brain", "tasks"}
    assert result["errors"] == {"bugs": "Temporarily unavailable"}


@pytest.mark.parametrize("args", [["tasks", "show"], ["bugs", "--status", "bad"], ["tasks", "--offset", "-1"],
                                 ["brain", "erase"], ["tasks", "show", "one", "--search", "two"]])
async def test_bad_domain_arguments_do_not_send_requests(args):
    protocol = DomainProtocol()
    output = io.StringIO()
    assert await run([*args, "--json"], api=protocol.api(), stdout=output) == 1
    assert json.loads(output.getvalue())["kind"] == "module.error"
    assert not protocol.calls


async def test_registry_and_domain_help_work_offline():
    protocol = DomainProtocol()
    output = io.StringIO()
    assert await run(["modules", "--json"], api=protocol.api(), stdout=output) == 0
    assert {m["id"] for m in json.loads(output.getvalue())["modules"]} == {"inbox", "tasks", "bugs", "brain", "dashboard"}
    assert await run(["tasks", "--help"], api=protocol.api(), stdout=io.StringIO()) == 0
    assert not protocol.calls


async def test_contracts_reject_duplicate_ids_and_wrong_detail():
    async def response(request):
        return httpx.Response(200, json={"tasks": [{"id": "same"}, {"id": "same"}],
                                        "pagination": {"total": 2}, "task": {"id": "other"}})
    api = Api("http://fixture", transport=httpx.MockTransport(response))
    with pytest.raises(ValueError, match="Repeated"):
        await collection(api, "tasks")
    with pytest.raises(ValueError, match="another resource"):
        await inspect_record(api, "tasks", "one")
    await api.close()


async def test_textual_collections_search_paging_detail_and_module_picker():
    protocol = DomainProtocol()
    api = protocol.api()
    app = ModuleApp(api, "tasks", live=False)
    async with app.run_test(size=(140, 40)) as pilot:
        await pilot.pause()
        assert app.query_one(DataTable).row_count == 100
        filters = app.query_one("#module-filter", OptionList)
        filters.highlighted = filters.get_option_index("blocked")
        filters.action_select()
        await pilot.pause()
        app.query_one("#module-search", Input).value = "applied"
        app.query_one("#module-search").focus()
        await pilot.press("enter")
        await pilot.pause()
        app.query_one("#module-search", Input).value = "draft"
        await pilot.click("#module-next")
        await pilot.pause()
        assert app.snapshot["query"] == dict(search="applied", status="blocked", limit=100, offset=100)
        assert app.query_one(DataTable).row_count == 1
        app.query_one(DataTable).focus()
        await pilot.press("enter")
        await pilot.pause()
        assert app.selected == "tasks-100"
        assert "Full description" in app.query_one("#module-detail", DetailDocument).payload["description"]
        protocol.task_status = "completed"
        app.action_refresh()
        await pilot.pause()
        assert app.query_one("#module-detail", DetailDocument).payload["status"] == "completed"
        await pilot.resize_terminal(70, 30)
        assert app.has_class("narrow")
        assert app.has_class("detail-open")
        await pilot.press("escape")
        assert not app.has_class("detail-open")
        protocol.fail.add("/api/tasks")
        app.action_refresh()
        await pilot.pause()
        assert app.query_one(DataTable).row_count == 1
        assert "previous snapshot" in str(app.query_one("#module-status", Static).content)
        await pilot.press("ctrl+o")
        await pilot.pause()
        assert isinstance(app.screen, ModulePicker)
        app.screen.query_one("#module-picker-search", Input).value = "bugs"
        await pilot.press("enter")
        await pilot.pause()
        assert app.module == "bugs" and app.selected is None and app.page_offset == 0
        assert app.snapshot["query"]["status"] == "all"
    await api.close()


async def test_textual_brain_controls_and_partial_overview():
    protocol = DomainProtocol()
    api = protocol.api()
    app = ModuleApp(api, "brain", live=False)
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        await pilot.click("#brain-start")
        await pilot.pause()
        assert protocol.brain_status == "running"
        assert "running" in str(app.query_one("#module-facts", Static).content)
        protocol.fail.add("/api/bugs/stats")
        app.switch_module("dashboard")
        await pilot.pause()
        assert set(app.snapshot["sources"]) == {"brain", "tasks"}
        assert "Unavailable" in str(app.query_one("#module-facts", Static).content)
        assert not app.query_one("#module-body").display
    await api.close()


async def test_old_detail_cannot_overwrite_a_new_module():
    gate = asyncio.Event()
    started = asyncio.Event()
    protocol = DomainProtocol()

    async def handle(request):
        if request.url.path == "/api/tasks/tasks-0":
            started.set()
            await gate.wait()
        return protocol.handle(request)

    api = Api("http://fixture", transport=httpx.MockTransport(handle))
    app = ModuleApp(api, "tasks", live=False)
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        app.selected = "tasks-0"
        app.load_detail("tasks-0", app.generation)
        await asyncio.wait_for(started.wait(), 2)
        app.switch_module("bugs")
        await pilot.pause()
        gate.set()
        await pilot.pause()
        assert app.module == "bugs"
        assert app.query_one("#module-detail", DetailDocument).payload is None
    await api.close()


async def test_inbox_module_picker_preserves_existing_help_and_navigation(protocol):
    from coleo_inbox.app import InboxApp
    from coleo_inbox.options import parse

    api = protocol.api()
    app = InboxApp(api, protocol.view, parse([], protocol.view), live=False)
    async with app.run_test(size=(140, 40)) as pilot:
        await pilot.click("#modules")
        await pilot.pause()
        assert isinstance(app.screen, ModulePicker)
        await pilot.press("escape")
        await pilot.pause()
        assert app.query_one(DataTable).row_count > 0
    await api.close()
