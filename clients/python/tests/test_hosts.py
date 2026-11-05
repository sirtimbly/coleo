import io
import json

import httpx
import pytest
from textual.widgets import Input, DataTable, Static

from coleo_inbox.api import Api
from coleo_inbox.cli import run
from coleo_inbox.workbench import WorkbenchApp
from coleo_inbox.hosts_app import HostsPane
from coleo_inbox.remote_cli import run_remote


class FleetProtocol:
    def __init__(self):
        self.calls = []
        self.hosts = [dict(id="host-one", name="Reef", hostname="reef.local", roles=["arm"],
                           agentId="reef-one", source="registered", status="connected", notes="", capabilities=["opencode-api"])]
        self.arms = [dict(id="arm-one", name="Octavia", status="stopped", harness="opencode-api", provider="openai", model="test")]
        self.settings = dict(host="127.0.0.1", port="8080", natsUrl="nats://localhost:4222", dbPath="/tmp/coleo.db")
        self.saved = {}

    def api(self):
        return Api("http://fixture", transport=httpx.MockTransport(self.handle))

    def handle(self, request):
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else None
        self.calls.append((method, request.url.raw_path.decode(), body))
        if path == "/api/hosts/services/restart":
            return httpx.Response(202, json={"accepted": True, "message": "Reconnect after restart"})
        if path == "/api/hosts/services":
            if method == "PATCH":
                self.saved.update(body)
            return httpx.Response(200, json=dict(active=self.settings, saved=self.saved, restartAvailable=True,
                                                explanation="Settings activate on restart", restartLog=None))
        if path == "/api/hosts":
            if method == "POST":
                self.hosts.append(dict(id="new-host", source="registered", status="unknown", **body))
                return httpx.Response(201, json={"host": self.hosts[-1]})
            return httpx.Response(200, json={"hosts": self.hosts, "discoveryAvailable": True})
        if path.startswith("/api/hosts/"):
            return httpx.Response(200, json={"deleted": True} if method == "DELETE" else {"host": self.hosts[0]})
        if path == "/api/arms":
            return httpx.Response(200, json={"arms": self.arms})
        if path.startswith("/api/arms/"):
            return httpx.Response(200, json={"arm": self.arms[0]})
        return httpx.Response(404, json={"error": path})


@pytest.mark.parametrize("args,path,method,body", [
    (["hosts", "create", "--name", "Broker", "--hostname", "nats.local", "--roles", "nats,api"], "/api/hosts", "POST", {"name": "Broker", "hostname": "nats.local", "roles": ["nats", "api"]}),
    (["hosts", "edit", "a/b ?", "--notes", "Updated"], "/api/hosts/a%2Fb%20%3F", "PATCH", {"notes": "Updated"}),
    (["hosts", "delete", "host-one"], "/api/hosts/host-one", "DELETE", None),
    (["services", "configure", "--nats-url", "nats://broker:4222", "--port", "9090"], "/api/hosts/services", "PATCH", {"natsUrl": "nats://broker:4222", "port": "9090"}),
    (["services", "restart", "--yes"], "/api/hosts/services/restart", "POST", {}),
    (["harnesses", "edit", "arm-one", "--model", "new-model"], "/api/arms/arm-one", "PATCH", {"model": "new-model"}),
    (["harnesses", "pause", "arm-one"], "/api/arms/arm-one/pause", "POST", {}),
    (["harnesses", "stop", "arm-one"], "/api/arms/arm-one/kill", "POST", {}),
    (["harnesses", "start", "a/b ?"], "/api/arms/a%2Fb%20%3F/spawn", "POST", {}),
])
async def test_cli_routes_and_fields(args, path, method, body):
    protocol = FleetProtocol()
    api = protocol.api()
    try:
        output = io.StringIO()
        assert await run([*args, "--json"], api, output) == 0
        assert protocol.calls[-1] == (method, path, body)
    finally:
        await api.close()


async def test_cli_starts_a_stopped_harness_without_a_previous_host_association():
    calls = []
    def handle(request):
        calls.append((request.method, request.url.path, json.loads(request.content)))
        if request.method == "POST" and request.url.path == "/api/arms/remote-arm/kill":
            return httpx.Response(200, json={"killed": True})
        if request.method == "POST" and request.url.path == "/api/arms/remote-arm/spawn":
            return httpx.Response(200, json={"spawned": True, "agentId": "new-remote-host"})
        return httpx.Response(503, json={"error": "No previous host association for recovery"})

    api = Api("http://fixture", transport=httpx.MockTransport(handle))
    try:
        for operation in ("stop", "start"):
            output = io.StringIO()
            assert await run_remote(["harnesses", operation, "remote-arm", "--json"], api, output) == 0
        assert json.loads(output.getvalue())["spawned"] is True
        assert calls == [("POST", "/api/arms/remote-arm/kill", {}),
                         ("POST", "/api/arms/remote-arm/spawn", {})]
    finally:
        await api.close()


async def test_offline_help_and_restart_requires_explicit_flag():
    protocol = FleetProtocol()
    api = protocol.api()
    try:
        for family in ("hosts", "harnesses", "services"):
            assert await run_remote([family, "--help"], api, io.StringIO()) == 0
        with pytest.raises(ValueError, match="--yes"):
            await run_remote(["services", "restart"], api, io.StringIO())
        assert not protocol.calls
    finally:
        await api.close()


async def test_tui_inventory_form_harness_controls_and_service_settings(tmp_path):
    protocol = FleetProtocol()
    api = protocol.api()
    app = WorkbenchApp(api, "hosts", live=False)
    try:
        async with app.run_test(size=(120, 42)) as pilot:
            await pilot.pause()
            pane = app.query_one(HostsPane)
            assert pane.query_one(DataTable).row_count == 1
            await pilot.click("#fleet-create")
            await pilot.pause()
            for key, value in (("name", "Broker"), ("hostname", "nats.local"), ("roles", "nats,api")):
                app.screen.query_one("#field-" + key, Input).value = value
            await pilot.click("#fleet-save")
            await pilot.pause()
            assert protocol.hosts[-1]["roles"] == ["nats", "api"]
            await pilot.click("#fleet-harnesses")
            await pilot.pause()
            await pilot.click("#fleet-start")
            await pilot.pause()
            assert any(path == "/api/arms/arm-one/spawn" for _, path, _ in protocol.calls)
            await pilot.click("#fleet-services")
            await pilot.pause()
            await pilot.click("#fleet-configure")
            await pilot.pause()
            app.screen.query_one("#field-port", Input).value = "9090"
            await pilot.click("#fleet-save")
            await pilot.pause()
            assert protocol.saved["port"] == "9090"
            await pilot.click("#fleet-restart")
            await pilot.pause()
            assert not any(path.endswith("/restart") for _, path, _ in protocol.calls)
            await pilot.click("#fleet-save")
            await pilot.pause()
            assert protocol.calls[-1][1] == "/api/hosts/services/restart"
            app.save_screenshot(str(tmp_path / "hosts-tui.svg"))
    finally:
        await api.close()
