import asyncio
import io
import signal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from coleo_inbox.cli import run
from coleo_inbox.connections import Connections
from coleo_inbox import web_cli


@pytest.mark.parametrize("exported_key", [None, "exported-key"])
async def test_selected_connection_passed_to_installed_host(monkeypatch, exported_key):
    monkeypatch.delenv("COLEO_API_KEY", raising=False)
    if exported_key:
        monkeypatch.setenv("COLEO_API_KEY", exported_key)
    Connections().save("prod", "https://selected.example/prefix", "private-key")
    Connections().save("other", "http://other", "other-key")
    monkeypatch.setattr(web_cli.shutil, "which", lambda name: "/installed/bin/coleo-web" if name == "coleo-web" else None)
    process = SimpleNamespace(wait=AsyncMock(return_value=0))
    launch = AsyncMock(return_value=process)
    monkeypatch.setattr(web_cli.asyncio, "create_subprocess_exec", launch)
    assert await run(["--connection", "prod", "web", "--host", "localhost", "--port", "3456"]) == 0
    args, kwargs = launch.call_args
    assert args == ("/installed/bin/coleo-web", "--host", "localhost", "--port", "3456")
    assert kwargs["env"]["COLEO_API_URL"] == "https://selected.example/prefix"
    assert kwargs["env"]["COLEO_API_KEY"] == (exported_key or "private-key")
    assert "private-key" not in repr(args)


async def test_missing_host_and_offline_help(monkeypatch):
    monkeypatch.setattr(web_cli.shutil, "which", lambda name: None)
    error = io.StringIO()
    assert await run(["web"], stderr=error) == 1
    assert "coleo-install install web" in error.getvalue()
    path = Connections().path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("broken")
    output = io.StringIO()
    assert await run(["--connection", "missing", "web", "--help"], stdout=output) == 0
    assert "--port" in output.getvalue()


@pytest.mark.parametrize("args", [["--port", "0"], ["--port", "65536"], ["--port", "x"], ["--host"], ["--bad"]])
async def test_invalid_options_do_not_spawn(monkeypatch, args):
    launch = AsyncMock()
    monkeypatch.setattr(web_cli.asyncio, "create_subprocess_exec", launch)
    assert await run(["web", *args], stderr=io.StringIO()) == 1
    launch.assert_not_called()


async def test_override_and_cancellation(monkeypatch):
    monkeypatch.setenv("COLEO_WEB_EXECUTABLE", "/developer/custom-host")
    monkeypatch.setattr(web_cli.shutil, "which", lambda name: name)
    started = asyncio.Event()
    stopped = asyncio.Event()
    class Process:
        returncode = None
        async def wait(self):
            started.set()
            await stopped.wait()
            self.returncode = -signal.SIGINT
            return self.returncode
        def send_signal(self, value):
            assert value == signal.SIGINT
            stopped.set()
    launch = AsyncMock(return_value=Process())
    monkeypatch.setattr(web_cli.asyncio, "create_subprocess_exec", launch)
    task = asyncio.create_task(run(["web"]))
    await started.wait()
    task.cancel()
    assert await task == 130
    assert launch.call_args.args[0] == "/developer/custom-host"
