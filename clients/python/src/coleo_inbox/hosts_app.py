"""Native host and harness controls inside the Textual workbench."""
from rich.text import Text
from textual import on, work
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, DataTable, Input, Label, Static

from .api import encoded
from .presentation import clean


class FleetForm(ModalScreen):
    BINDINGS = [("escape", "cancel", "Cancel")]
    DEFAULT_CSS = """
    FleetForm { align: center middle; }
    #fleet-dialog { width: 70; max-width: 95%; height: auto; max-height: 95%; padding: 1 2; border: solid $accent; background: $surface; }
    #fleet-dialog Label { margin-top: 1; }
    #fleet-dialog Input { width: 1fr; }
    #fleet-dialog Horizontal { height: 3; margin-top: 1; }
    """

    def __init__(self, title, fields=(), warning=""):
        super().__init__()
        self.heading, self.fields, self.warning = title, fields, warning

    def compose(self):
        with VerticalScroll(id="fleet-dialog"):
            yield Static(self.heading, markup=False)
            if self.warning:
                yield Static(self.warning, markup=False)
            for key, label, value in self.fields:
                yield Label(label)
                yield Input(value=str(value or ""), id="field-" + key)
            with Horizontal():
                yield Button("Confirm" if not self.fields else "Save", id="fleet-save", variant="primary")
                yield Button("Cancel", id="fleet-cancel")

    @on(Button.Pressed, "#fleet-cancel")
    def action_cancel(self):
        self.dismiss(None)

    @on(Button.Pressed, "#fleet-save")
    def save(self):
        self.dismiss({key: self.query_one("#field-" + key, Input).value for key, _, _ in self.fields})


class HostsPane(Vertical):
    DEFAULT_CSS = """
    #fleet-tabs, #fleet-actions { height: 3; overflow-x: auto; overflow-y: hidden; }
    #fleet-tabs Button, #fleet-actions Button { width: auto; min-width: 9; }
    #fleet-heading { height: auto; padding: 1; }
    #fleet-grid { height: 1fr; }
    #fleet-info { height: auto; max-height: 8; padding: 0 1; }
    #fleet-status { height: auto; max-height: 5; padding: 0 1; }
    """

    def __init__(self, api, live=True, **kwargs):
        super().__init__(**kwargs)
        self.api, self.live = api, live
        self.section = "hosts"
        self.rows = []
        self.services = None
        self.busy = False
        self.generation = 0

    def compose(self):
        with Horizontal(id="fleet-tabs"):
            yield Button("Hosts", id="fleet-hosts")
            yield Button("Harnesses", id="fleet-harnesses")
            yield Button("Services", id="fleet-services")
            yield Button("Refresh", id="fleet-refresh")
        yield Static("Hosts & harnesses", id="fleet-heading", markup=False)
        with Horizontal(id="fleet-actions"):
            for action, label in (("create", "Create"), ("edit", "Edit / Register"), ("start", "Start"),
                                  ("pause", "Pause"), ("resume", "Resume"), ("stop", "Stop"),
                                  ("delete", "Delete"), ("configure", "Edit connections"), ("restart", "Apply / Restart API")):
                yield Button(label, id="fleet-" + action)
        yield DataTable(id="fleet-grid", cursor_type="row")
        yield Static("", id="fleet-info", markup=False)
        yield Static("Loading…", id="fleet-status", markup=False)

    def on_mount(self):
        self.refresh_data()
        if self.live:
            self.set_interval(15, self.poll)

    def poll(self):
        if not self.busy:
            self.refresh_data()

    def selected(self):
        table = self.query_one("#fleet-grid", DataTable)
        return self.rows[table.cursor_row] if self.rows and table.cursor_row < len(self.rows) else None

    def render_rows(self):
        table = self.query_one("#fleet-grid", DataTable)
        cursor = table.cursor_row
        table.clear(columns=True)
        if self.section == "services":
            table.add_columns("Setting", "Active", "Saved for restart")
            if self.services:
                for key, value in self.services["active"].items():
                    table.add_row(Text(key), Text(clean(value)), Text(clean(self.services["saved"].get(key) or "Uses active setting")))
        else:
            table.add_columns("Name", "Hostname / Host", "Status", "Roles / Harness", "ID")
            for row in self.rows:
                values = (row.get("name", ""), row.get("hostname", row.get("host") or row.get("agentId") or "Unassigned"),
                          row.get("status", "unknown"), ", ".join(row["roles"]) if "roles" in row else row.get("harness", ""), row["id"])
                table.add_row(*(Text(clean(value)) for value in values), key=row["id"])
        if table.row_count:
            table.move_cursor(row=min(cursor, table.row_count - 1))
        for action in ("create", "edit", "start", "pause", "resume", "stop", "delete", "configure", "restart"):
            button = self.query_one("#fleet-" + action, Button)
            button.display = (action in ("configure", "restart") if self.section == "services" else
                              action in ("create", "edit", "delete") if self.section == "hosts" else action not in ("configure", "restart"))
            button.disabled = self.busy or (action == "restart" and not (self.services or {}).get("restartAvailable"))
        self.show_info()

    def show_info(self):
        if self.section == "services":
            info = (self.services or {}).get("explanation", "")
            if self.services and not self.services.get("restartAvailable"):
                info += " API is externally managed; restart through deployment controls."
            if self.services and self.services.get("restartLog"):
                info += "\nLast restart: " + self.services["restartLog"][-1000:]
        else:
            row = self.selected() or {}
            info = (row.get("notes", "") + "\n" + ", ".join(row.get("capabilities", []))) if self.section == "hosts" else f"Provider: {row.get('provider', '')} · Model: {row.get('model', '')}"
        self.query_one("#fleet-info", Static).update(clean(info))

    @on(DataTable.RowHighlighted, "#fleet-grid")
    def row_highlighted(self):
        self.show_info()

    @work(exclusive=True, group="fleet-load")
    async def refresh_data(self):
        self.generation += 1
        version, section = self.generation, self.section
        try:
            result = await self.api.request("/api/hosts/services" if section == "services" else "/api/hosts" if section == "hosts" else "/api/arms", params={"includeAll": "true"} if section == "harnesses" else None)
            if version != self.generation or section != self.section:
                return
            if section == "services":
                self.services, self.rows = result, []
            else:
                self.rows = result["hosts" if section == "hosts" else "arms"]
            self.render_rows()
            message = "Snapshot refreshed · " + str(len(self.rows)) + " records"
            if section == "hosts" and not result.get("discoveryAvailable"):
                message += " · Arm Host discovery unavailable"
            self.query_one("#fleet-status", Static).update(message)
        except Exception as exc:
            self.query_one("#fleet-status", Static).update("Refresh failed: " + clean(exc))

    @on(Button.Pressed)
    def button_pressed(self, event):
        action = (event.button.id or "").removeprefix("fleet-")
        if self.busy:
            return
        if action in ("hosts", "harnesses", "services"):
            self.section, self.rows, self.services = action, [], None
            self.render_rows()
            self.refresh_data()
        elif action == "refresh":
            self.refresh_data()
        elif action in ("create", "edit", "configure"):
            row = self.selected() if action == "edit" else None
            if action == "edit" and not row:
                return
            section = self.section
            if section == "hosts":
                fields = [("name", "Name", (row or {}).get("name", "")),
                          ("hostname", "Hostname or IP", (row or {}).get("hostname", "")),
                          ("roles", "Roles, comma separated: arm, api, nats, database", ",".join((row or {}).get("roles", ["arm"]))),
                          ("agentId", "Arm Host ID (optional)", (row or {}).get("agentId", "")),
                          ("notes", "Notes", (row or {}).get("notes", ""))]
            elif section == "harnesses":
                fields = [(key, label, (row or {}).get(key, "")) for key, label in
                          (("name", "Name"), ("provider", "Provider (optional)"), ("model", "Model (optional)"))]
                if not row:
                    fields += [("workdir", "Working directory on host (optional)", ""), ("agentId", "Arm Host ID (optional, automatic if blank)", "")]
            else:
                if not self.services:
                    return
                fields = [(key, label, self.services["saved"].get(key) or self.services["active"][key]) for key, label in
                          (("host", "API bind host"), ("port", "API port"), ("natsUrl", "NATS server URL"), ("dbPath", "Existing SQLite database path on API host"))]
            self.app.push_screen(FleetForm("Edit connections" if section == "services" else "Edit" if row else "Create", fields,
                                          "Harness model edits apply on next start." if section == "harnesses" else ""),
                                 lambda values: self.save_record(section, row, values) if values is not None else None)
        elif action == "restart":
            self.app.push_screen(FleetForm("Apply settings and restart API?", warning="Stop all harnesses first. Clients disconnect; reconnect to the new API address."),
                                 lambda answer: self.perform("/api/hosts/services/restart", {}) if answer is not None else None)
        else:
            row = self.selected()
            if not row:
                return
            if self.section == "hosts":
                if row.get("source") != "registered":
                    self.query_one("#fleet-status", Static).update("Discovered hosts cannot be deleted. Register to manage inventory; use deployment controls to stop services.")
                    return
                path, body, method = "/api/hosts/" + encoded(row["id"]), None, "DELETE"
            else:
                path = "/api/arms/" + encoded(row["id"])
                if action == "delete" and row.get("status") != "stopped":
                    self.query_one("#fleet-status", Static).update("Stop this harness before deleting it.")
                    return
                path += "" if action == "delete" else "/" + {"start": "spawn", "stop": "kill"}.get(action, action)
                body, method = (None, "DELETE") if action == "delete" else ({}, "POST")
            if action in ("stop", "delete"):
                self.app.push_screen(FleetForm(f"{action.title()} {clean(row.get('name', row['id']))}?",
                                              warning="Host deletion removes inventory only." if self.section == "hosts" else "Stopping interrupts current work; deletion removes the stopped record."),
                                     lambda answer: self.perform(path, body, method) if answer is not None else None)
            else:
                self.perform(path, body, method)

    @work(exclusive=False, group="fleet-save")
    async def save_record(self, section, row, values):
        if self.busy:
            return
        self.busy = True
        self.render_rows()
        try:
            if section == "hosts":
                values["roles"] = [r.strip() for r in values["roles"].split(",")]
                values["agentId"] = values["agentId"] or None
                identifier = row["id"] if row and row.get("source") == "registered" else None
                await self.api.request("/api/hosts" + ("/" + encoded(identifier) if identifier else ""), values, method="PATCH" if identifier else "POST")
            elif section == "services":
                await self.api.request("/api/hosts/services", values, method="PATCH")
            elif row:
                await self.api.request("/api/arms/" + encoded(row["id"]), {k: v for k, v in values.items() if v}, method="PATCH")
            else:
                agent = values.pop("agentId", "")
                values = {k: v for k, v in values.items() if v}
                await self.api.request("/api/arms", {**values, "harness": "opencode-api"})
                try:
                    await self.api.request("/api/arms/" + encoded(values["name"]) + "/spawn", {"agentId": agent, "preferAgent": True, "allowLocalFallback": False} if agent else {})
                except Exception as exc:
                    raise ValueError(f"Harness record created but start failed: {exc}. Refresh, then select it and Start to retry.") from exc
            self.query_one("#fleet-status", Static).update("Saved. Service settings require Apply / Restart API.")
            self.refresh_data()
        except Exception as exc:
            self.query_one("#fleet-status", Static).update("Save failed: " + clean(exc))
        finally:
            self.busy = False
            self.render_rows()

    @work(exclusive=False, group="fleet-action")
    async def perform(self, path, body, method=None):
        if self.busy:
            return
        self.busy = True
        self.render_rows()
        try:
            result = await self.api.request(path, body, method=method)
            self.query_one("#fleet-status", Static).update(clean(result.get("message", "Action completed")))
            if not result.get("accepted"):
                self.refresh_data()
        except Exception as exc:
            self.query_one("#fleet-status", Static).update("Action failed: " + clean(exc))
        finally:
            self.busy = False
            self.render_rows()
