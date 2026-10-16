import io
import json
from pathlib import Path

import pytest
from textual.widgets import Input, OptionList, Static, Tabs

from coleo_inbox.catalog_dialog import CatalogPathDialog
from coleo_inbox.cli import run
from coleo_inbox.module_catalog import ModuleCatalog, config_directory, decode_catalog
from coleo_inbox.workbench import WorkbenchApp
from test_modules import DomainProtocol


def write_catalog(path, identifier="work", renderer="tasks", title="Project work", **extra):
    path.write_text(json.dumps({"schemaVersion": 1, "modules": [dict(
        id=identifier, title=title, description="Project module", symbol="checklist", renderer=renderer, **extra)]}))
    return path


def test_seed_once_reload_authoritative_and_retain_on_failure(tmp_path):
    catalog = ModuleCatalog()
    assert catalog.path == config_directory() / "modules.json"
    assert set(catalog.modules) == {"inbox", "tasks", "bugs", "brain", "dashboard"}
    write_catalog(catalog.path)
    assert "inbox" in catalog.modules  # No file watcher.
    catalog.reload()
    assert list(catalog.modules) == ["work"]
    assert ModuleCatalog().modules == catalog.modules  # No re-merge of starter entries.
    catalog.path.write_text("broken")
    with pytest.raises(ValueError, match="Could not read"):
        catalog.reload()
    assert list(catalog.modules) == ["work"]
    write_catalog(catalog.path, title="Repaired")
    catalog.reload()
    assert catalog.modules["work"].title == "Repaired"


def test_choose_remembers_original_path_and_never_copies_or_overwrites(tmp_path):
    catalog = ModuleCatalog()
    original = catalog.path.read_text()
    chosen = write_catalog(tmp_path / "chosen.json")
    catalog.choose(chosen)
    assert catalog.path == chosen
    assert (config_directory() / "modules.json").read_text() == original
    write_catalog(chosen, title="Edited in place")
    assert ModuleCatalog().modules["work"].title == "Edited in place"
    malformed = tmp_path / "bad.json"
    malformed.write_text("{}")
    with pytest.raises(ValueError):
        catalog.choose(malformed)
    assert ModuleCatalog().path == chosen
    absent = tmp_path / "missing.json"
    with pytest.raises(ValueError, match="Could not read"):
        ModuleCatalog(absent)
    assert not absent.exists()


@pytest.mark.parametrize("change", [dict(renderer="unknown"), dict(id="modules"), dict(renderer="messaging"),
                                  dict(facet="invalid"), dict(title=42)])
def test_catalog_rejects_unlaunchable_recipes(tmp_path, change):
    path = write_catalog(tmp_path / "modules.json")
    data = json.loads(path.read_text())
    data["modules"][0].update(change)
    with pytest.raises(ValueError):
        decode_catalog(json.dumps(data))


def test_catalog_accepts_macos_starter_schema():
    source = Path(__file__).resolve().parents[2] / "macos/Sources/ColeoInboxMac/Resources/modules.json"
    modules = decode_catalog(source.read_text())
    assert modules["inbox"].namedView == "inbox-triage"
    assert modules["tasks"].renderer == "tasks"


async def test_cli_reads_catalog_each_invocation_and_dispatches_alias(tmp_path):
    protocol = DomainProtocol()
    path = write_catalog(tmp_path / "modules.json")
    output = io.StringIO()
    assert await run(["--catalog", str(path), "modules", "--json"], protocol.api(), output) == 0
    assert [m["id"] for m in json.loads(output.getvalue())["modules"]] == ["work"]
    output = io.StringIO()
    assert await run(["work", "--limit", "1", "--json", "--catalog", str(path)], protocol.api(), output) == 0
    assert protocol.calls[-1][1] == "/api/tasks"
    assert json.loads(output.getvalue())["moduleId"] == "work"
    write_catalog(path, identifier="reports", renderer="bugs")
    output = io.StringIO()
    assert await run(["modules", "reload", "--catalog", str(path), "--json"], protocol.api(), output) == 0
    assert [m["id"] for m in json.loads(output.getvalue())["modules"]] == ["reports"]
    assert await run(["modules", "choose", str(path)], protocol.api(), io.StringIO()) == 0
    assert ModuleCatalog().path == path
    output = io.StringIO()
    assert await run(["modules", "path"], protocol.api(), output) == 0
    assert output.getvalue().strip() == str(path)


async def test_messaging_recipe_defaults_allow_explicit_cli_overrides(tmp_path, protocol):
    path = write_catalog(tmp_path / "modules.json", identifier="project-mail", renderer="messaging",
                         namedView="inbox-triage", facet="messages", presentation="cards")
    output = io.StringIO()
    assert await run(["project-mail", "--catalog", str(path), "--json"], protocol.api(), output) == 0
    result = json.loads(output.getvalue())
    assert result["query"]["facet"] == "messages"
    assert result["presentation"]["id"] == "cards"
    output = io.StringIO()
    assert await run(["project-mail", "--facet", "all", "--presentation", "grid", "--catalog", str(path), "--json"], protocol.api(), output) == 0
    assert json.loads(output.getvalue())["query"]["facet"] == "all"


async def test_tui_reload_changes_launcher_without_mutating_open_documents(tmp_path):
    path = write_catalog(tmp_path / "modules.json")
    api = DomainProtocol().api()
    app = WorkbenchApp(api, "work", catalog=ModuleCatalog(path), live=False)
    async with app.run_test(size=(140, 42)) as pilot:
        await pilot.pause()
        first = app.active_pane
        assert first.module == "tasks"
        assert first.module_recipe.title == "Project work"
        write_catalog(path, identifier="reports", renderer="bugs", title="Bug reports")
        await pilot.press("ctrl+o")
        await pilot.pause()
        await pilot.click("#catalog-reload")
        await pilot.pause()
        assert list(app.catalog.modules) == ["reports"]
        assert first.is_mounted and first.module_recipe.title == "Project work"
        await pilot.press("ctrl+o")
        await pilot.pause()
        options = app.screen.query_one("#module-options", OptionList)
        assert options.option_count == 1 and options.get_option_at_index(0).id == "reports"
        await pilot.press("enter")
        await pilot.pause()
        assert app.active_pane.module == "bugs" and len(app.documents) == 2
        path.write_text("invalid")
        app.action_reload_catalog()
        assert list(app.catalog.modules) == ["reports"]
        assert "keeping previous" in str(app.query_one("#workspace-message", Static).content)
        app.query_one(Tabs).active = first.id
        await pilot.pause()
        assert app.active_pane is first
        first.action_refresh()
        await pilot.pause()
        assert first.snapshot["module"] == "tasks"
    await api.close()


async def test_tui_choose_catalog_persists_and_palette_exposes_reload(tmp_path):
    api = DomainProtocol().api()
    app = WorkbenchApp(api, "tasks", live=False)
    path = write_catalog(tmp_path / "chosen.json")
    async with app.run_test(size=(120, 42)) as pilot:
        await pilot.pause()
        await pilot.press("ctrl+o")
        await pilot.pause()
        await pilot.click("#catalog-choose")
        await pilot.pause()
        assert isinstance(app.screen, CatalogPathDialog)
        app.screen.query_one(Input).value = str(path)
        await pilot.press("enter")
        await pilot.pause()
        assert app.catalog.path == path
        assert ModuleCatalog().path == path
        titles = [command.title for command in app.get_system_commands(app.screen)]
        assert "Reload module catalog" in titles and "Open Project work" in titles
    await api.close()


async def test_reloaded_inbox_recipe_applies_to_new_tabs_not_cached_options(tmp_path, protocol):
    from coleo_inbox.options import parse

    path = write_catalog(tmp_path / "modules.json", identifier="inbox", renderer="messaging",
                         namedView="inbox-triage", facet="attention")
    api = protocol.api()
    app = WorkbenchApp(api, catalog=ModuleCatalog(path), inbox_view=protocol.view,
                       inbox_options=parse([], protocol.view), live=False)
    async with app.run_test(size=(140, 42)) as pilot:
        await pilot.pause()
        first = app.active_pane
        write_catalog(path, identifier="inbox", renderer="messaging", title="Mail",
                      namedView="inbox-triage", facet="messages", presentation="cards")
        app.action_reload_catalog()
        await app.open_document("inbox")
        await pilot.pause()
        assert app.active_pane.session.options.query["facet"] == "messages"
        assert app.active_pane.session.options.presentation == "cards"
        assert first.session.options.query["facet"] == "attention"
    await api.close()
