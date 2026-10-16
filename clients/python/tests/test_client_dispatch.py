import io
import json

import pytest

from coleo_inbox.cli import run


@pytest.mark.parametrize("command", [
    "arm", "arms", "agents", "activity", "status", "mail", "discoveries", "config", "status-reports",
])
async def test_host_dispatch_help_is_offline_without_valid_configuration(command, tmp_path, monkeypatch):
    monkeypatch.setenv("COLEO_CONFIG_DIR", str(tmp_path))
    (tmp_path / "connections.json").write_text("broken configuration")
    (tmp_path / "python-client.json").write_text("broken catalog selection")
    output, error = io.StringIO(), io.StringIO()
    assert await run([command, "--help"], stdout=output, stderr=error) == 0
    assert output.getvalue()
    assert error.getvalue() == ""


async def test_host_dispatch_preserves_json_errors_for_communication_commands(tmp_path, monkeypatch):
    monkeypatch.setenv("COLEO_CONFIG_DIR", str(tmp_path))
    output, error = io.StringIO(), io.StringIO()
    assert await run(["mail", "no-such-operation", "--json"], stdout=output, stderr=error) == 1
    assert json.loads(output.getvalue())["kind"] == "module.error"
    assert error.getvalue() == ""
