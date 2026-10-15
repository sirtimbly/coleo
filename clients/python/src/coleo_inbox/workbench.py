"""Persistent document host. Textual owns tabs, focus, modal input and lifecycle."""
import asyncio
from copy import deepcopy
from functools import partial
from uuid import uuid4

from textual import on, work
from textual.app import App, ComposeResult, SystemCommand
from textual.containers import Horizontal
from textual.widgets import Button, ContentSwitcher, Footer, Static, Tab, Tabs

from .app import InboxPane
from .module_app import ModulePane, ModulePicker
from .modules import MODULES
from .module_catalog import ModuleCatalog
from .catalog_dialog import CatalogPathDialog
from .options import parse
from .presentation import clean


class WorkbenchApp(App):
    TITLE = "Coleo Workbench"
    CSS_PATH = "workbench.tcss"
    BINDINGS = [("ctrl+q", "quit", "Quit"), ("ctrl+c", "quit", "Quit"),
                ("ctrl+o", "modules", "Open module"), ("ctrl+w", "close_document", "Close tab"),
                ("ctrl+pageup", "previous_document", "Previous tab"),
                ("ctrl+pagedown", "next_document", "Next tab")]

    def __init__(self, api, module="inbox", *, inbox_view=None, inbox_options=None, live=True, catalog=None):
        super().__init__()
        self.api = api
        self.catalog = catalog if catalog is not None else ModuleCatalog()
        self.initial_module = module
        self.initial_recipe = self.catalog.modules.get(module)
        self.inbox_view = inbox_view
        self.inbox_options = inbox_options
        self.live = live
        self.documents = {}
        self.document_focus = {}
        self.open_lock = asyncio.Lock()

    def compose(self) -> ComposeResult:
        with Horizontal(id="document-bar"):
            yield Tabs(id="documents")
            yield Button("+", id="new-module", variant="primary", compact=True,
                         tooltip="Open a module · Ctrl+O")
            yield Button("×", id="close-document", compact=True, tooltip="Close active tab · Ctrl+W")
        yield Static("", id="workspace-message", markup=False)
        yield ContentSwitcher(id="document-content")
        yield Footer()

    async def on_mount(self):
        await self.open_document(self.initial_module)

    @property
    def active_pane(self):
        return self.query_one("#document-content", ContentSwitcher).visible_content

    def action_modules(self):
        self.push_screen(ModulePicker(self.catalog.modules, self.catalog.path), self.open_module)

    def catalog_message(self, text):
        message = self.query_one("#workspace-message", Static)
        message.update(clean(text))
        message.display = True

    def action_reload_catalog(self):
        try:
            self.catalog.reload()
            self.catalog_message(f"Reloaded {len(self.catalog.modules)} modules from {self.catalog.path}")
        except (OSError, ValueError) as exc:
            self.catalog_message(f"Catalog reload failed; keeping previous catalog: {exc}")

    def action_choose_catalog(self):
        self.push_screen(CatalogPathDialog(self.catalog.path), self.choose_catalog)

    def choose_catalog(self, path):
        if path is None:
            return
        try:
            self.catalog.choose(path)
            self.catalog_message(f"Using catalog {self.catalog.path}")
        except (OSError, ValueError) as exc:
            self.catalog_message(f"Could not choose catalog; keeping previous catalog: {exc}")

    @on(Button.Pressed, "#new-module")
    def launcher_clicked(self):
        self.action_modules()

    def open_module(self, module):
        if isinstance(module, dict):
            if module.get("catalogAction") == "catalog-reload":
                self.action_reload_catalog()
            elif module.get("catalogAction") == "catalog-choose":
                self.action_choose_catalog()
        elif module in self.catalog.modules:
            self.open_module_worker(module)

    @work(group="document-open")
    async def open_module_worker(self, module):
        await self.open_document(module)

    async def open_document(self, module):
        async with self.open_lock:
            message = self.query_one("#workspace-message", Static)
            recipe = self.catalog.modules.get(module)
            if recipe is None:
                self.catalog_message(f"Module {module} is not in {self.catalog.path}. Use + to choose a module.")
                return
            message.update(f"Opening {recipe.title}…")
            message.display = True
            try:
                identifier = "document-" + uuid4().hex
                if recipe.renderer == "messaging":
                    reuse_initial = module == self.initial_module and recipe == self.initial_recipe and self.inbox_view is not None
                    view = self.inbox_view if reuse_initial else await self.api.view(recipe.namedView)
                    options = deepcopy(self.inbox_options) if reuse_initial and self.inbox_options else parse([], view)
                    if not (reuse_initial and self.inbox_options):
                        recipe.apply(options, view)
                    pane = InboxPane(self.api, view, options, live=self.live, id=identifier)
                else:
                    pane = ModulePane(self.api, recipe.renderer, module_title=recipe.title, live=self.live, id=identifier)
                pane.module_recipe = recipe
                switcher = self.query_one("#document-content", ContentSwitcher)
                await switcher.mount(pane)
                count = sum(value == module for value in self.documents.values()) + 1
                title = recipe.title + (f" · {count}" if count > 1 else "")
                self.documents[identifier] = module
                await self.query_one("#documents", Tabs).add_tab(Tab(title, id=identifier))
                self.query_one("#documents", Tabs).active = identifier
                switcher.current = identifier
                self.call_after_refresh(self.focus_document)
                message.display = False
            except Exception as exc:
                message.update(f"Could not open {recipe.title}: {clean(exc)} · Use + to retry")

    @on(Tabs.TabActivated, "#documents")
    def document_selected(self, event):
        switcher = self.query_one("#document-content", ContentSwitcher)
        switcher.current = event.tab.id
        self.call_after_refresh(self.focus_document)

    def focus_document(self):
        pane = self.active_pane
        if pane is None:
            return
        previous = self.document_focus.get(pane.id)
        if previous is not None and previous.is_mounted and previous.display and previous.can_focus:
            previous.focus()
            return
        if isinstance(pane, InboxPane):
            pane.query_one("#grid" if pane.session.options.presentation == "grid" else "#cards").focus()
        elif MODULES[pane.module].statuses:
            pane.query_one("#module-grid").focus()
        else:
            pane.query_one("#module-refresh").focus()

    def on_descendant_focus(self, event):
        for ancestor in event.widget.ancestors:
            if ancestor.id in self.documents:
                self.document_focus[ancestor.id] = event.widget
                break

    @on(Button.Pressed, "#close-document")
    async def close_clicked(self):
        await self.action_close_document()

    async def action_close_document(self):
        tabs = self.query_one("#documents", Tabs)
        identifier = tabs.active
        if identifier not in self.documents:
            return
        switcher = self.query_one("#document-content", ContentSwitcher)
        pane = switcher.query_one(f"#{identifier}")
        pane.ready = False
        # Tab removal selects its neighbor; leave that pane mounted and intact.
        await tabs.remove_tab(identifier)
        switcher.current = tabs.active or None
        await pane.remove()
        self.documents.pop(identifier)
        self.document_focus.pop(identifier, None)
        if not self.documents:
            message = self.query_one("#workspace-message", Static)
            message.update("No open modules. Use + or Ctrl+O to open one.")
            message.display = True
            self.query_one("#new-module").focus()

    def action_previous_document(self):
        self.query_one("#documents", Tabs).action_previous_tab()

    def action_next_document(self):
        self.query_one("#documents", Tabs).action_next_tab()

    def get_system_commands(self, screen):
        yield from super().get_system_commands(screen)
        for module in self.catalog.modules.values():
            yield SystemCommand(f"Open {module.title}", module.description, partial(self.open_module, module.id))
        yield SystemCommand("Close active tab", "Keep other documents open", self.action_close_document)
        yield SystemCommand("Reload module catalog", str(self.catalog.path), self.action_reload_catalog)
        yield SystemCommand("Choose module catalog", "Remember a JSON file to read at startup", self.action_choose_catalog)
