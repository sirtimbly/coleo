import asyncio

from textual.widgets import ContentSwitcher, Input, OptionList, Tabs

from coleo_inbox.app import InboxPane
from coleo_inbox.module_app import ModulePane, ModulePicker
from coleo_inbox.options import parse
from coleo_inbox.workbench import WorkbenchApp
from coleo_inbox.workspace_widgets import ColumnDivider, WorkspaceColumns

from test_modules import DomainProtocol


async def test_repeated_modules_keep_independent_queries_and_native_tab_state():
    api = DomainProtocol().api()
    app = WorkbenchApp(api, "tasks", live=False)
    async with app.run_test(size=(150, 42)) as pilot:
        await pilot.pause()
        first = app.active_pane
        assert isinstance(first, ModulePane)
        first.query_one("#module-search", Input).value = "first query"
        first.query_one("#module-search").focus()
        await pilot.press("enter")
        await pilot.pause()
        columns = first.query_one(WorkspaceColumns)
        assert columns.query_one(".workspace-sidebar").size.width == 18
        assert columns.query_one(".workspace-collection").size.width == 64
        assert columns.region.y > app.query_one("#document-bar").region.bottom
        columns.resize_column("collection", -8)
        await pilot.pause()
        await app.open_document("tasks")
        await pilot.pause()
        second = app.active_pane
        assert second is not first and second.search == ""
        assert second.snapshot["query"]["search"] == ""
        first_id, second_id = list(app.documents)
        app.query_one(Tabs).active = first_id
        await pilot.pause()
        assert app.active_pane is first and first.search == "first query"
        assert columns.middle_width == 56
        assert first.query_one(".workspace-collection").size.width == 56
        # Closing another document must not stop or reset this one.
        app.query_one(Tabs).active = second_id
        await pilot.pause()
        await app.action_close_document()
        await pilot.pause()
        assert app.active_pane is first
        assert len(app.documents) == 1
        first.action_refresh()
        await pilot.pause()
        assert first.snapshot["query"]["search"] == "first query"
    await api.close()


async def test_plus_searchable_picker_opens_tabs_and_close_last_keeps_launcher():
    api = DomainProtocol().api()
    app = WorkbenchApp(api, "bugs", live=False)
    async with app.run_test(size=(100, 32)) as pilot:
        await pilot.pause()
        await pilot.click("#new-module")
        await pilot.pause()
        assert isinstance(app.screen, ModulePicker)
        await pilot.press("b", "r", "a", "i", "n", "enter")
        await pilot.pause()
        assert len(app.documents) == 2
        assert app.active_pane.module == "brain"
        assert app.query_one(ContentSwitcher).visible_content is app.active_pane
        await app.action_close_document()
        await app.action_close_document()
        await pilot.pause()
        assert app.active_pane is None
        assert app.query_one("#new-module").display
        await pilot.press("ctrl+o", "t", "a", "s", "k", "s", "enter")
        await pilot.pause()
        assert app.active_pane.module == "tasks"
    await api.close()


async def test_inbox_tab_owns_sidebar_selection_widths_and_close_cancels_live_work(protocol):
    api = protocol.api()
    app = WorkbenchApp(api, inbox_view=protocol.view, inbox_options=parse([], protocol.view), live=False)
    async with app.run_test(size=(150, 42)) as pilot:
        await pilot.pause()
        first = app.active_pane
        assert isinstance(first, InboxPane)
        await pilot.press("ctrl+b")
        assert len(first.session.selection.entries) == 3
        columns = first.query_one(WorkspaceColumns)
        assert columns.sidebar_width == 18
        first.session.options.presentation = "timeline"
        first.update_view()
        await pilot.pause()
        assert columns.middle_width == 34
        await app.open_document("inbox")
        await pilot.pause()
        second = app.active_pane
        assert not second.session.selection.entries
        assert second.session.options.presentation == "grid"
        assert len(first.session.selection.entries) == 3
        app.query_one(Tabs).active = first.id
        await pilot.pause()
        divider = first.query_one(".detail-divider", ColumnDivider)
        divider.focus()
        await pilot.press("right")
        assert columns.middle_width == 36
        await pilot.resize_terminal(70, 30)
        await pilot.pause()
        assert not first.query_one(".workspace-sidebar").display
        columns.toggle_sidebar()
        await pilot.pause()
        assert first.query_one(".workspace-sidebar").display
        # Owned async work is awaited during removal, rather than leaking into a closed tab.
        sleeper = asyncio.create_task(asyncio.sleep(100))
        first.session.tasks.append(sleeper)
        await app.action_close_document()
        await pilot.pause()
        assert sleeper.cancelled()
        assert app.active_pane is second
    await api.close()
