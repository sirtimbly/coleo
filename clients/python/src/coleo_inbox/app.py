"""Textual owns terminal lifecycle, widgets, focus, scrolling and responsive layout."""
import asyncio

from rich.text import Text
from textual import events, on
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, DataTable, Footer, Input, Markdown, Select, Static, Tree

from .contracts import hierarchy, reference
from .presentation import age, clean, detail_markdown, source_label, state
from .session import Session
from .snapshot import metadata_values


class Help(ModalScreen):
    BINDINGS = [("escape", "dismiss", "Close")]

    def __init__(self, text):
        super().__init__()
        self.text = text

    def compose(self):
        with Vertical(id="help-dialog"):
            yield Markdown(self.text)
            yield Button("Close", id="close-help")

    @on(Button.Pressed)
    def close_help(self):
        self.dismiss()


class InboxApp(App):
    TITLE = "Coleo Inbox · Python / Textual"
    CSS = """
    #controls, #actions { height: 3; overflow-x: auto; overflow-y: hidden; }
    #controls Select { min-width: 12; }
    #controls Input { min-width: 20; }
    #controls Input { width: 2fr; }
    #controls Select { width: 1fr; }
    #actions Button { min-width: 8; width: auto; }
    #presentation { width: 20; }
    #status { height: auto; max-height: 4; padding: 0 1; }
    #metadata-panel { height: auto; max-height: 9; overflow-y: auto; padding: 0 1; border: solid $accent; }
    #body { height: 1fr; }
    #collection { width: 1fr; }
    #grid, #cards { height: 1fr; }
    #detail { width: 1fr; border-left: solid $accent; padding: 0 1; overflow-y: auto; }
    .narrow #detail { width: 100%; }
    .narrow.detail-open #collection { display: none; }
    .narrow #detail { display: none; }
    .narrow.detail-open #detail { display: block; }
    #help-dialog { margin: 2 4; padding: 1 2; background: $surface; border: solid $accent; overflow-y: auto; }
    """
    BINDINGS = [("ctrl+c", "quit", "Quit"), ("ctrl+q", "quit", "Quit"),
                ("escape", "back", "Back"), ("f1", "help", "Help"),
                ("ctrl+b", "branch", "Select branch"), ("ctrl+r", "read", "Mark read"),
                ("ctrl+l", "more", "Load more")]

    def __init__(self, api, view, options, live=True):
        super().__init__()
        self.session = Session(api, view, options, self.update_view)
        self.live_enabled = live
        self.folded = set()
        self.initialized_threads = set()
        self.focus_id = None
        self.visible_ids = []
        self.detail_generation = 0
        self.detail_task = None
        self.tui_view = None
        self.rendering = False
        self.ready = False
        self.metadata_visible = bool(options.metadata)

    def compose(self) -> ComposeResult:
        # TUI interaction.available describes keyboard delivery, not toolbar
        # eligibility. In the canonical view, facet/mailbox/sort/presentation
        # and mark-read have no TUI keys but remain supported native controls.
        q = self.session.options.query
        with Horizontal(id="controls"):
            yield Input(q["search"], placeholder="Search · Enter to apply", id="search")
            yield Select([(f, f) for f in ("attention", "messages", "brain", "arms", "history", "all")], value=q["facet"], allow_blank=False, id="facet")
            yield Select([(f, f) for f in ("inbox", "sent", "archive")], value=q["mailbox"], allow_blank=False, id="mailbox")
            yield Select([(f, f) for f in ("all", "operations", "tasks", "arms", "decisions", "planning", "alerts")], value=q["brainCategory"], allow_blank=False, id="category")
            yield Select([(f, f) for f in ("desc", "asc")], value=q["sort"]["direction"], allow_blank=False, id="sort")
        with Horizontal(id="actions"):
            yield Button("Refresh", id="refresh")
            yield Button("More", id="more")
            yield Button("Read", id="read")
            yield Button("Branch", id="branch")
            yield Button("Clear", id="clear")
            yield Select([(r["label"], r["id"]) for r in self.session.view["definition"]["presentation"]["renderers"]], value=self.session.options.presentation, allow_blank=False, id="presentation")
            yield Button("?", id="help")
            yield Button("Metadata [m]", id="metadata")
        yield Static("Loading…", id="status", markup=False)
        yield Static("", id="metadata-panel", markup=False)
        with Horizontal(id="body"):
            with Vertical(id="collection"):
                yield DataTable(id="grid", cursor_type="row")
                yield Tree("Inbox", id="cards")
            yield Markdown("# Inbox\n\nSelect a row and press Enter to inspect full content.", id="detail")
        yield Footer()

    async def on_mount(self):
        self.ready = True
        try:
            self.tui_view = await self.session.api.view(self.session.view["definition"]["id"], "tui")
        except Exception as exc:
            self.session.error = f"Keyboard definition unavailable: {exc}; host controls remain available"
        self.update_view()
        self.query_one("#grid").focus()
        if self.live_enabled:
            self.session.start()
        else:
            await self.session.refresh()

    async def on_unmount(self):
        await self.session.close()
        if self.detail_task:
            self.detail_task.cancel()
            await asyncio.gather(self.detail_task, return_exceptions=True)

    def on_resize(self, event: events.Resize):
        self.set_class(event.size.width < 100, "narrow")
        if self.ready:
            self.update_view()

    def update_view(self):
        if not self.ready:
            return
        self.rendering = True
        snapshot = self.session.snapshot
        mode = self.session.options.presentation
        with self.prevent(Select.Changed):
            q = self.session.options.query
            for identifier, value in (("facet", q["facet"]), ("mailbox", q["mailbox"]), ("category", q["brainCategory"]), ("sort", q["sort"]["direction"])):
                self.query_one(f"#{identifier}", Select).value = value
        table = self.query_one("#grid", DataTable)
        tree = self.query_one("#cards", Tree)
        table.display = mode == "grid"
        tree.display = mode != "grid"
        self.query_one("#more", Button).disabled = not snapshot or not snapshot["traversal"]["nextCursor"]
        self.query_one("#read", Button).disabled = not snapshot or not snapshot["complete"] or not self.session.selection.entries or "inbox.mark-read" not in self.session.view["definition"]["commands"]
        status = f"{self.session.connection} · {len(self.session.selection.entries)} selected · {mode}"
        if snapshot:
            status += f" · {len(snapshot['items'])} loaded · " + ("complete window" if snapshot["complete"] else "PARTIAL / retained; actions disabled")
            status += "\n" + " · ".join(snapshot["diagnostics"])
        if mode == "timeline":
            status += " · TUI timeline fallback: timestamp-ordered native tree"
        if self.session.error:
            status += "\n" + self.session.error
        self.query_one("#status", Static).update(clean(status))
        self.update_metadata()
        pane_width = max(20, self.size.width if self.size.width < 100 else self.size.width // 2)
        table.clear(columns=True)
        table.add_column("Ref", width=9)
        table.add_column("Subject", width=max(8, pane_width - (46 if pane_width >= 95 else 23)))
        table.add_column("State", width=6)
        if pane_width >= 95:
            table.add_column("Source", width=9)
            table.add_column("Age", width=10)
        tree.clear()
        tree.root.expand()
        self.visible_ids = []
        focused_tree_node = None
        if snapshot:
            for item in snapshot["items"]:
                if item.get("thread") and item["id"] not in self.initialized_threads:
                    self.initialized_threads.add(item["id"])
                    expansion = self.session.options.expansion
                    if expansion == "collapsed":
                        self.folded.add(item["id"])
                    elif expansion == "roots":
                        self.folded.update(item["thread"]["hierarchy"]["rootIds"])
                entries = [(item["id"], None, 0, item)]
                if item.get("thread"):
                    rows, _ = hierarchy(item["thread"])
                    entries += [(n["id"], n["parentId"] or item["id"], depth + 1, n["data"]) for n, depth in rows if n["id"] != item["id"]]
                native_nodes = {}
                hidden = set()
                for identifier, parent, depth, data in entries:
                    selected = "✓ " if identifier in self.session.selection.entries else "  "
                    title = clean(data.get("title", ""))
                    label = f"{selected}{reference(identifier)} {title} · {state(data)}"
                    if mode == "cards":
                        label += "\n" + clean(data.get("summary", ""))[:240] + "\n" + source_label(data.get("source"))
                    elif mode == "timeline":
                        label = age(data.get("timestamp")) + " " + label
                    parent_node = native_nodes.get(parent, tree.root)
                    node = parent_node.add(Text(label), data=identifier, expand=identifier not in self.folded)
                    native_nodes[identifier] = node
                    if identifier == self.focus_id:
                        focused_tree_node = node
                    if parent in hidden or parent in self.folded:
                        hidden.add(identifier)
                        continue
                    self.visible_ids.append(identifier)
                    cells = [Text(reference(identifier)), Text("  " * depth + selected + title, overflow="ellipsis", no_wrap=True), Text(state(data))]
                    if pane_width >= 95:
                        cells.extend([Text(source_label(data.get("source"))), Text(age(data.get("timestamp")))])
                    table.add_row(*cells, key=identifier)
        if self.focus_id in self.visible_ids:
            table.move_cursor(row=self.visible_ids.index(self.focus_id))
        elif self.visible_ids:
            self.focus_id = self.visible_ids[0]
            table.move_cursor(row=0)
        if focused_tree_node:
            tree.select_node(focused_tree_node)
        self.rendering = False

    @on(Input.Submitted, "#search")
    def search(self, event):
        self.change_query(search=event.value)
        self.query_one("#grid" if self.session.options.presentation == "grid" else "#cards").focus()

    def update_metadata(self):
        panels = self.session.view["definition"].get("insights", {}).get("panels", [])
        button = self.query_one("#metadata", Button)
        button.disabled = not panels
        button.label = "Metadata on [m]" if self.metadata_visible else "Metadata [m]"
        button.variant = "primary" if self.metadata_visible else "default"
        widget = self.query_one("#metadata-panel", Static)
        widget.display = self.metadata_visible and bool(panels)
        if not widget.display:
            return
        snapshot = self.session.snapshot
        if not snapshot:
            widget.update("Metadata · waiting for current query")
            return
        panel = next((p for p in panels if p["id"] == self.session.options.metadata), panels[0])
        summaries = snapshot["pages"][0]["summaries"]
        values = metadata_values(snapshot["items"], summaries, panel["fields"])
        total = summaries["total"] if summaries["total"] is not None else "unknown"
        lines = [f"{panel['label']} · {panel['id']}" + (" · PARTIAL / retained" if not snapshot["complete"] else ""),
                 f"Total: {total} (query) · Loaded: {len(snapshot['items'])} (loaded-window)"]
        for m in values:
            value = age(m["value"]) if m["field"] == "timestamp" else m["value"] if m["value"] is not None else "unknown"
            lines.append(f"{m['label']}: {value} ({m['scope']})")
        source_lines = dict.fromkeys(f"{s['id']}: {s['status']} / {'complete' if s['complete'] else 'incomplete'} (source; as of {age(s['asOf'])})"
                                    for page in snapshot["pages"] for s in page["sources"])
        lines.extend(source_lines)
        widget.update(clean("\n".join(lines)))

    def action_metadata(self):
        self.metadata_visible = not self.metadata_visible
        self.update_metadata()

    def change_query(self, **changes):
        self.detail_generation += 1
        self.remove_class("detail-open")
        self.folded.clear()
        self.initialized_threads.clear()
        self.session.query(**changes)

    @on(Select.Changed)
    def select_changed(self, event):
        if not self.ready or self.rendering or event.value is Select.BLANK:
            return
        identifier = event.select.id
        if identifier == "presentation":
            self.session.options.presentation = event.value
            self.update_view()
            self.query_one("#grid" if event.value == "grid" else "#cards").focus()
        elif identifier == "sort":
            if event.value != self.session.options.query["sort"]["direction"]:
                self.change_query(sort={"field": "timestamp", "direction": event.value})
        else:
            field = {"facet": "facet", "mailbox": "mailbox", "category": "brainCategory"}.get(identifier)
            if field and event.value != self.session.options.query[field]:
                self.change_query(**{field: event.value})

    @on(DataTable.RowHighlighted)
    def highlighted(self, event):
        if not self.rendering:
            self.focus_id = str(event.row_key.value)

    @on(DataTable.RowSelected)
    def opened(self, event):
        self.focus_id = str(event.row_key.value)
        self.open_detail()

    @on(Tree.NodeHighlighted)
    def tree_highlighted(self, event):
        if not self.rendering and event.node.data:
            self.focus_id = event.node.data

    @on(Tree.NodeSelected)
    def tree_opened(self, event):
        if event.node.data:
            self.focus_id = event.node.data
            self.open_detail()

    @on(Tree.NodeCollapsed)
    def tree_collapsed(self, event):
        if not self.rendering and event.node.data:
            self.folded.add(event.node.data)

    @on(Tree.NodeExpanded)
    def tree_expanded(self, event):
        if not self.rendering and event.node.data:
            self.folded.discard(event.node.data)

    def open_detail(self):
        if not self.focus_id:
            return
        self.detail_generation += 1
        generation, identifier = self.detail_generation, self.focus_id
        if self.detail_task:
            self.detail_task.cancel()
        self.add_class("detail-open")
        self.query_one("#detail", Markdown).update("Loading full content…")
        async def fetch():
            try:
                target, detail = await self.session.api.inspect(identifier, self.session.options.query["profileId"])
                if generation == self.detail_generation:
                    text = detail_markdown(detail)
                    if target["diagnostics"]:
                        text = "\n\n".join(target["diagnostics"]) + "\n\n" + text
                    self.query_one("#detail", Markdown).update(text)
            except Exception as exc:
                if generation == self.detail_generation:
                    self.query_one("#detail", Markdown).update(f"Detail unavailable: {clean(exc)}")
        self.detail_task = asyncio.create_task(fetch())

    @on(Button.Pressed)
    async def button(self, event):
        action = event.button.id
        if action == "refresh":
            self.session.dirty.set()
        elif action == "more":
            self.action_more()
        elif action == "read":
            await self.action_read()
        elif action == "branch":
            self.action_branch()
        elif action == "clear":
            self.session.selection.entries.clear()
            self.update_view()
        elif action == "help":
            self.action_help()
        elif action == "metadata":
            self.action_metadata()

    def toggle_selection(self, branch=False):
        try:
            if self.focus_id and self.session.snapshot:
                self.session.selection.toggle(self.session.snapshot, self.focus_id, branch)
                self.update_view()
        except ValueError as exc:
            self.notify(str(exc), severity="error")

    def action_branch(self):
        self.toggle_selection(True)

    async def action_read(self):
        if "inbox.mark-read" not in self.session.view["definition"]["commands"]:
            self.notify("Read command is not declared by this view", severity="error")
            return
        try:
            result = await self.session.mark_read()
            self.notify(result.get("error", f"Read completed; skipped {len(result['skippedMemberIds'])} context members"), severity="error" if "error" in result else "information")
        except ValueError as exc:
            self.notify(str(exc), severity="error")

    def action_more(self):
        self.session.more()

    def action_back(self):
        self.remove_class("detail-open")
        self.query_one("#grid" if self.session.options.presentation == "grid" else "#cards").focus()

    def action_help(self):
        lines = ["# Inbox keys", "Tab moves through native controls. Search applies on Enter. Escape returns to the list.",
                 "Host: Ctrl+Q/Ctrl+C quit · Ctrl+B loaded branch · Ctrl+R read · Ctrl+L more · m metadata · F1 help.",
                 "## API-resolved operations"]
        for b in (self.tui_view or {}).get("interactions", {}).get("bindings", []):
            keys = ["+".join(k.get("modifiers", []) + [k["key"]]) + f" ({k['scope']})" for k in b["keyboard"]]
            if keys:
                lines.append(f"- {', '.join(keys)} — {b['label']} / `{b['operation']}`" + ("" if b["available"] else f" — {b.get('diagnostic')}"))
        lines += ["Meta/primary shortcuts depend on terminal encoding; host Ctrl bindings remain available.",
                  "Space selects a focused message; Ctrl+B selects its loaded descendants. Folding preserves selection; new replies remain unselected."]
        snapshot = self.session.snapshot
        if snapshot:
            lines.append("## Sources and query-wide counts")
            counts = snapshot["pages"][0]["summaries"]
            lines.append(" · ".join(f"{k}: {counts[k] if counts[k] is not None else 'unknown'}" for k in ("total", "unread", "requiresAction")))
            for source in snapshot["pages"][-1]["sources"]:
                lines.append(f"- {source['id']}: {source['status']}, complete={source['complete']}, as of {source['asOf'] or 'unknown'}")
            lines += [clean(d) for d in snapshot["diagnostics"]]
            if snapshot["metadata"]:
                lines.append("## Active metadata: " + str(snapshot["metadataPanelId"]))
                lines += [f"{m['label']}: {m['value'] if m['value'] is not None else 'unknown'} ({m['scope']})" for m in snapshot["metadata"]]
        self.push_screen(Help("\n\n".join(lines)))

    async def on_key(self, event: events.Key):
        if isinstance(self.focused, (Input, Select)) or isinstance(self.screen, Help):
            return
        if event.key == "m":
            self.action_metadata()
            event.stop()
            event.prevent_default()
            return
        mapping = {"ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right", "Space": "space", "Enter": "enter", "Escape": "escape"}
        scope = "tree" if isinstance(self.focused, Tree) else "item"
        for b in (self.tui_view or {}).get("interactions", {}).get("bindings", []):
            if not b["available"]:
                continue
            for k in b["keyboard"]:
                key = "+".join([{"control": "ctrl", "primary": "ctrl"}.get(m, m) for m in k.get("modifiers", [])] + [mapping.get(k["key"], k["key"])])
                if key not in (event.key, event.character) or k["scope"] not in (scope, "collection"):
                    continue
                op = b["operation"]
                # Native widgets already own arrow navigation and Enter.
                if op in ("collection.next", "collection.previous"):
                    if event.key in ("up", "down"):
                        return
                    widget = self.focused
                    if isinstance(widget, DataTable):
                        widget.move_cursor(row=max(0, min(len(self.visible_ids) - 1, widget.cursor_row + (1 if op.endswith("next") else -1))))
                    elif isinstance(widget, Tree):
                        widget.action_cursor_down() if op.endswith("next") else widget.action_cursor_up()
                elif op == "collection.open":
                    return
                elif op == "collection.search":
                    self.query_one("#search").focus()
                elif op == "collection.refresh":
                    self.session.dirty.set()
                elif op == "collection.help":
                    self.action_help()
                elif op in ("collection.select", "collection.select-branch"):
                    self.toggle_selection(op.endswith("select-branch"))
                elif op in ("collection.collapse", "collection.expand"):
                    if self.focus_id:
                        self.folded.add(self.focus_id) if op.endswith("collapse") else self.folded.discard(self.focus_id)
                        self.update_view()
                elif op == "inbox.mark-read":
                    await self.action_read()
                else:
                    self.notify(f"Operation {op} is available through the toolbar")
                event.stop()
                event.prevent_default()
                return
