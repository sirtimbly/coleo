from textual.widgets import Button, DataTable, Input, Select, Static, Tree

from coleo_inbox.app import Help, InboxApp
from coleo_inbox.options import parse


async def test_textual_navigation_selection_folding_detail_resize(protocol):
    api = protocol.api()
    app = InboxApp(api, protocol.view, parse([], protocol.view), live=False)
    async with app.run_test(size=(130, 40)) as pilot:
        await pilot.pause()
        table = app.query_one(DataTable)
        assert table.row_count >= 4
        await pilot.press("ctrl+b")
        await pilot.pause()
        assert len(app.session.selection.entries) == 3
        await pilot.press("left")
        await pilot.pause()
        assert table.row_count == 1
        assert len(app.session.selection.entries) == 3
        await pilot.press("right", "enter")
        await pilot.pause()
        assert app.has_class("detail-open")
        await pilot.resize_terminal(70, 30)
        await pilot.pause()
        assert app.has_class("narrow")
        assert app.query_one("#collection").styles.display == "none"
        assert app.query_one("#detail").styles.display == "block"
        await pilot.press("escape")
        await pilot.pause()
        assert not app.has_class("detail-open")
        assert app.query_one("#detail").styles.display == "none"
        await pilot.press("?")
        await pilot.pause()
        assert isinstance(app.screen, Help)
        await pilot.press("escape")
        await pilot.resize_terminal(130, 40)
        app.query_one("#presentation", Select).value = "cards"
        await pilot.pause()
        assert app.query_one(Tree).display
        assert not app.query_one(DataTable).display
        app.session.selection.entries.clear()
        app.update_view()
        tree = app.query_one(Tree)
        tree.select_node(tree.root.children[0])
        tree.focus()
        await pilot.pause()
        await pilot.press("space")
        await pilot.pause()
        assert len(app.session.selection.entries) == 3
    await api.close()


async def test_text_input_query_reset_paging_action(protocol):
    api = protocol.api()
    app = InboxApp(api, protocol.view, parse([], protocol.view), live=False)
    async with app.run_test(size=(140, 40)) as pilot:
        await pilot.pause()
        await pilot.press("ctrl+b")
        assert app.session.selection.entries
        await pilot.press("/")
        await pilot.press("r", "j", "k")
        search = app.query_one("#search", Input)
        assert search.value == "rjk"  # typing does not trigger refresh/navigation
        await pilot.press("enter")
        assert app.session.options.query["search"] == "rjk"
        assert not app.session.selection.entries
        await app.session.refresh()
        app.action_more()
        await app.session.refresh()
        assert len(app.session.snapshot["items"]) == 2
        app.focus_id = app.session.snapshot["items"][0]["id"]
        app.action_branch()
        result = await app.session.mark_read()
        assert not result.get("error")
        assert len(result["skippedMemberIds"]) == 1
    await api.close()


async def test_metadata_toggle_scopes_refresh_unknown_and_resize(protocol):
    api = protocol.api()
    app = InboxApp(api, protocol.view, parse([], protocol.view), live=False)
    async with app.run_test(size=(140, 40)) as pilot:
        await pilot.pause()
        panel = app.query_one("#metadata-panel", Static)
        assert not panel.display
        await pilot.press("m")
        await pilot.pause()
        assert panel.display
        assert "Total: 2 (query)" in panel.content
        assert "Unread: 2 (query)" in panel.content
        assert "Loaded: 1 (loaded-window)" in panel.content
        assert "Latest loaded item:" in panel.content
        assert "mail: fresh / complete (source;" in panel.content
        assert app.query_one("#metadata", Button).variant == "primary"
        await pilot.click("#metadata")
        await pilot.pause(.4)  # allow native Button's pressed-effect debounce
        assert not panel.display
        await pilot.click("#metadata")
        await pilot.pause()
        assert panel.display
        protocol.partial = True
        await app.session.refresh()
        await pilot.pause()
        assert "Unread: unknown (query)" in panel.content
        assert "Total: unknown (query)" in panel.content
        assert "mail: unavailable / incomplete (source;" in panel.content
        assert "PARTIAL" in panel.content
        await pilot.resize_terminal(65, 28)
        await pilot.pause()
        assert panel.region.width <= 65
        assert app.query_one("#controls").region.height == 3
        assert app.query_one("#actions").region.height == 3
        app.query_one("#search", Input).focus()
        await pilot.press("m")
        assert app.query_one("#search", Input).value == "m"
        assert panel.display  # ordinary text entry never toggles metadata
    await api.close()
