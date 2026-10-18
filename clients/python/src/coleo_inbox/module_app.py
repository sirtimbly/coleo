"""Native Textual domain screens; APIs and renderers are shared with the CLI."""
from rich.text import Text
from textual import events, on, work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.message_pump import MessagePump
from textual.widgets import Button, DataTable, Footer, Input, OptionList, Static
from textual.widgets.option_list import Option

from .modules import (MODULES, brain_action, collection, inspect_record, overview,
                      overview_text, record_owner, record_title)
from .presentation import clean
from .workspace_widgets import ColumnDivider, WorkspaceColumns
from .detail_document import DetailDocument


class ModulePicker(ModalScreen):
    BINDINGS = [("escape", "dismiss", "Cancel")]
    DEFAULT_CSS = """
    ModulePicker { align: center middle; }
    #module-picker { width: 60; max-width: 95%; height: auto; padding: 1 2; border: solid $accent; background: $surface; }
    #module-picker OptionList { height: 12; border: none; }
    #module-picker Horizontal { height: 3; }
    #module-picker Button { width: 1fr; }
    """

    def __init__(self, modules=None, catalog_path=None):
        super().__init__()
        self.modules = modules if modules is not None else MODULES
        self.catalog_path = catalog_path

    def compose(self):
        with Vertical(id="module-picker"):
            yield Static("Open a module", markup=False)
            yield Input(placeholder="Find a module", id="module-picker-search")
            yield OptionList(*(Option(Text(f"{m.title}\n{m.description}"), id=m.id) for m in self.modules.values()), id="module-options")
            if self.catalog_path is not None:
                yield Static(str(self.catalog_path), markup=False)
                with Horizontal():
                    yield Button("Reload catalog", id="catalog-reload")
                    yield Button("Choose catalog…", id="catalog-choose")

    @on(Button.Pressed, "#catalog-reload, #catalog-choose")
    def catalog_action(self, event):
        self.dismiss({"catalogAction": event.button.id})

    @on(Input.Changed, "#module-picker-search")
    def filter_options(self, event):
        options = self.query_one(OptionList)
        options.clear_options()
        options.add_options(Option(Text(f"{m.title}\n{m.description}"), id=m.id) for m in self.modules.values()
                            if event.value.casefold() in f"{m.title} {m.description}".casefold())
        options.highlighted = 0 if options.option_count else None

    @on(Input.Submitted, "#module-picker-search")
    def submit_search(self):
        options = self.query_one(OptionList)
        if options.highlighted is not None:
            self.dismiss(options.get_option_at_index(options.highlighted).id)

    @on(OptionList.OptionSelected, "#module-options")
    def choose(self, event):
        self.dismiss(event.option.id)


class ModuleSurface(MessagePump):
    embedded = False
    TITLE = "Coleo Workbench · Python / Textual"
    CSS = """
    #module-controls, #module-actions { height: 3; overflow-x: auto; overflow-y: hidden; background: $surface; }
    #module-controls Input { width: 2fr; min-width: 20; }
    #module-controls Select { width: 1fr; min-width: 18; }
    #module-actions Button { min-width: 8; width: auto; }
    #module-heading { height: 1; padding: 0 1; text-style: bold; color: $text-muted; }
    #module-status { height: auto; max-height: 5; padding: 0 1; }
    #module-body { height: 1fr; }
    #module-grid { height: 1fr; }
    #module-detail-pane { height: 1fr; padding: 0 1; }
    #module-sidebar { padding: 1 0; }
    #module-sidebar Static { height: 1; padding: 0 1; color: $text-muted; }
    #module-filter { border: none; padding: 0; height: 1fr; }
    #module-overview { height: 1fr; padding: 1 2; }
    """
    BINDINGS = [("ctrl+q", "quit", "Quit"), ("ctrl+c", "quit", "Quit"),
                ("ctrl+o", "modules", "Modules"), ("ctrl+r", "refresh", "Refresh"),
                ("ctrl+l", "next", "Next page"), ("escape", "back", "Back")]

    def __init__(self, api, module="tasks", live=True, module_title=None, **kwargs):
        super().__init__(**kwargs)
        self.api, self.module, self.live_enabled = api, module, live
        self.module_title = module_title or MODULES[module].title
        self.search, self.status, self.page_offset = "", "all", 0
        self.snapshot = None
        self.error = ""
        self.generation = 0
        self.selected = None
        self.is_loading = False
        self.acting = False
        self.ready = False

    def compose(self) -> ComposeResult:
        with Horizontal(id="module-actions"):
            if not self.embedded:
                yield Button("Modules", id="modules")
            yield Button("Sidebar", id="module-sidebar-toggle")
            yield Button("Refresh", id="module-refresh")
            yield Button("Previous", id="module-previous")
            yield Button("Next", id="module-next")
            yield Button("Start Brain", id="brain-start")
            yield Button("Stop Brain", id="brain-stop")
        with Horizontal(id="module-controls"):
            yield Input(placeholder="Search · Enter to apply", id="module-search")
        yield Static(self.module_title, id="module-heading", markup=False)
        with WorkspaceColumns(id="module-body"):
            with Vertical(id="module-sidebar", classes="workspace-sidebar"):
                yield Static("Status", markup=False)
                yield OptionList(Option("All statuses", id="all"), id="module-filter")
            yield ColumnDivider("sidebar", classes="sidebar-divider")
            yield DataTable(id="module-grid", cursor_type="row", classes="workspace-collection")
            yield ColumnDivider("collection", classes="detail-divider")
            with Vertical(id="module-detail-pane", classes="workspace-detail"):
                yield DetailDocument(id="module-detail")
        with VerticalScroll(id="module-overview"):
            yield Static("", id="module-facts", markup=False)
        yield Static("Loading…", id="module-status", markup=False)

    def on_mount(self):
        self.ready = True
        self.configure()
        self.action_refresh()
        if self.live_enabled:
            self.set_interval(15, self.poll)

    def on_resize(self, event: events.Resize):
        self.set_class(event.size.width < 100, "narrow")
        if self.ready:
            self.call_after_refresh(self.render_snapshot)

    def configure(self):
        is_collection = bool(MODULES[self.module].statuses)
        self.query_one("#module-heading", Static).update(self.module_title)
        for selector in ("#module-body", "#module-controls", "#module-previous", "#module-next", "#module-sidebar-toggle"):
            self.query_one(selector).display = is_collection
        self.query_one("#module-overview").display = not is_collection
        for selector in ("#brain-start", "#brain-stop"):
            self.query_one(selector).display = self.module == "brain"
        select = self.query_one("#module-filter", OptionList)
        select.clear_options()
        select.add_options([Option("All statuses", id="all"), *(Option(s.replace("_", " ").title(), id=s) for s in MODULES[self.module].statuses)])
        select.highlighted = 0
        self.query_one("#module-search", Input).value = ""
        if is_collection:
            self.query_one("#module-grid").focus()
        else:
            self.query_one("#module-refresh").focus()

    def action_modules(self):
        if self.embedded:
            self.app.action_modules()
        else:
            self.app.push_screen(ModulePicker(), self.switch_module)

    def switch_module(self, module):
        if self.embedded:
            if module:
                self.app.open_module(module)
            return
        if module is None or module == self.module:
            return
        if module == "inbox":
            self.app.exit("inbox")
            return
        self.module = module
        self.module_title = MODULES[module].title
        self.search, self.status = "", "all"
        self.configure()
        self.reset()

    def reset(self):
        self.generation += 1
        self.page_offset = 0
        self.snapshot = None
        self.selected = None
        self.error = ""
        self.remove_class("detail-open")
        self.query_one(WorkspaceColumns).remove_class("inspecting")
        self.query_one("#module-detail", DetailDocument).update("Select a row and press Enter to inspect it.")
        self.action_refresh()

    @on(Input.Submitted, "#module-search")
    def apply_search(self, event):
        self.search = event.value
        self.reset()

    @on(OptionList.OptionSelected, "#module-filter")
    def apply_status(self, event):
        if self.ready and event.option.id != self.status:
            self.status = event.option.id
            self.reset()
        event.stop()

    @on(Button.Pressed)
    def button_pressed(self, event):
        actions = {"modules": self.action_modules, "module-refresh": self.action_refresh,
                   "module-next": self.action_next, "module-previous": self.action_previous,
                   "module-sidebar-toggle": self.query_one(WorkspaceColumns).toggle_sidebar}
        if event.button.id in actions:
            actions[event.button.id]()
        elif event.button.id in ("brain-start", "brain-stop"):
            self.control_brain(event.button.id.removeprefix("brain-"))

    def poll(self):
        if not self.is_loading and not self.acting:
            self.action_refresh()

    def action_refresh(self):
        self.generation += 1
        self.is_loading = True
        self.render_snapshot()
        self.refresh_data(self.generation, self.module, self.search, self.status, self.page_offset)

    @work(exclusive=True, group="module-refresh")
    async def refresh_data(self, version, module, search, status, offset):
        try:
            result = (await collection(self.api, module, search=search, status=status, offset=offset)
                      if MODULES[module].statuses else await overview(self.api, module))
            if version != self.generation:
                return
            self.snapshot, self.error = result, ""
            if self.selected:
                if any(r["id"] == self.selected for r in result.get("items", [])):
                    self.load_detail(self.selected, version)
                else:
                    self.selected = None
                    self.query_one("#module-detail", DetailDocument).update("Select a row and press Enter to inspect it.")
                    self.remove_class("detail-open")
                    self.query_one(WorkspaceColumns).remove_class("inspecting")
        except Exception as exc:
            if version == self.generation:
                self.error = str(exc)
        finally:
            if version == self.generation:
                self.is_loading = False
                self.render_snapshot()

    def render_snapshot(self):
        if not self.ready:
            return
        table = self.query_one("#module-grid", DataTable)
        cursor = table.cursor_row
        table.clear(columns=True)
        pane_width = table.size.width or 64
        # Long subjects must not push status/priority out of the initial viewport.
        # Owner and full ID remain reachable with native horizontal scrolling.
        table.add_column("Title", width=max(12, pane_width - 30))
        table.add_column("Status", width=14)
        table.add_column("Priority", width=8)
        table.add_column("Assigned to", width=18)
        table.add_column("ID", width=28)
        if self.snapshot and "items" in self.snapshot:
            for record in self.snapshot["items"]:
                table.add_row(*(Text(clean(v)) for v in (record_title(record), record.get("status", "Unknown"),
                              record.get("priority", "—"), record_owner(record), record["id"])), key=record["id"])
            if table.row_count:
                table.move_cursor(row=min(cursor, table.row_count - 1))
        if self.snapshot and "sources" in self.snapshot:
            self.query_one("#module-facts", Static).update(overview_text(self.snapshot))
        elif not MODULES[self.module].statuses:
            self.query_one("#module-facts", Static).update("Loading…" if self.is_loading else "No summary available")
        status = "Loading…" if self.is_loading else "Refresh every 15s" if self.live_enabled else "Snapshot"
        if self.snapshot and "items" in self.snapshot:
            status += f" · {len(self.snapshot['items'])} shown / {self.snapshot['total']} total · offset {self.page_offset}"
            if not self.snapshot["items"]:
                status += " · No matching records"
        if self.error:
            status += "\n" + self.error + (" · showing previous snapshot" if self.snapshot else "")
        if self.snapshot and self.snapshot.get("errors"):
            status += " · PARTIAL: some sources unavailable"
        self.query_one("#module-status", Static).update(clean(status))
        self.query_one("#module-next", Button).disabled = self.is_loading or not self.snapshot or self.snapshot.get("nextOffset") is None
        self.query_one("#module-previous", Button).disabled = self.is_loading or self.page_offset == 0
        brain = (self.snapshot or {}).get("sources", {}).get("brain", {}).get("brain", {})
        unhealthy = self.acting or self.is_loading or bool(self.error) or not brain or bool((self.snapshot or {}).get("errors"))
        self.query_one("#brain-start", Button).disabled = unhealthy or brain.get("status") == "running"
        self.query_one("#brain-stop", Button).disabled = unhealthy or brain.get("status") not in ("running", "paused")

    def change_page(self, offset):
        self.page_offset = offset
        self.snapshot = None
        self.selected = None
        self.query_one("#module-detail", DetailDocument).update("Select a row and press Enter to inspect it.")
        self.remove_class("detail-open")
        self.query_one(WorkspaceColumns).remove_class("inspecting")
        self.action_refresh()

    def action_next(self):
        if not self.is_loading and self.snapshot and self.snapshot.get("nextOffset") is not None:
            self.change_page(self.snapshot["nextOffset"])

    def action_previous(self):
        if not self.is_loading and self.page_offset:
            self.change_page(max(0, self.page_offset - 100))

    @on(DataTable.RowSelected, "#module-grid")
    def inspect_row(self, event):
        self.selected = event.row_key.value
        self.query_one("#module-detail", DetailDocument).update("Loading detail…")
        self.add_class("detail-open")
        self.query_one(WorkspaceColumns).add_class("inspecting")
        self.load_detail(self.selected, self.generation)

    @work(exclusive=True, group="module-detail")
    async def load_detail(self, identifier, version):
        try:
            result = await inspect_record(self.api, self.module, identifier)
            if version == self.generation and identifier == self.selected:
                self.query_one("#module-detail", DetailDocument).show_detail(result["item"])
        except Exception as exc:
            if version == self.generation and identifier == self.selected:
                self.query_one("#module-detail", DetailDocument).update("Detail unavailable: " + clean(exc))

    @work(group="brain-action", exclusive=False)
    async def control_brain(self, action):
        if self.acting or self.module != "brain":
            return
        self.acting = True
        version = self.generation
        self.render_snapshot()
        try:
            await brain_action(self.api, action)
            if self.module == "brain":
                self.action_refresh()
        except Exception as exc:
            if version == self.generation:
                self.error = str(exc)
        finally:
            self.acting = False
            self.render_snapshot()

    def action_back(self):
        self.remove_class("detail-open")
        self.query_one(WorkspaceColumns).remove_class("inspecting")
        if MODULES[self.module].statuses:
            self.query_one("#module-grid").focus()


class ModulePane(ModuleSurface, Vertical):
    embedded = True
    DEFAULT_CSS = ModuleSurface.CSS
    BINDINGS = ModuleSurface.BINDINGS


class ModuleApp(ModuleSurface, App):
    """Standalone host for focused domain tests."""
    BINDINGS = ModuleSurface.BINDINGS
    CSS = ModuleSurface.CSS
    def compose(self):
        yield from super().compose()
        yield Footer()


async def run_workbench(api, module="inbox", inbox_view=None, inbox_options=None, catalog=None):
    from .workbench import WorkbenchApp
    await WorkbenchApp(api, module, inbox_view=inbox_view, inbox_options=inbox_options, catalog=catalog).run_async()
