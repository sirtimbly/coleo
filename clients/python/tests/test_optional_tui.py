import builtins
import io

import pytest

from coleo_inbox.cli import load_workbench, run


def block_workbench(monkeypatch, missing):
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        if name == "module_app":
            raise ModuleNotFoundError(f"No module named {missing}", name=missing)
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)


@pytest.mark.parametrize("missing", ["textual", "websockets.asyncio"])
async def test_tui_without_extra_gives_hint_before_api_access(monkeypatch, protocol, missing):
    block_workbench(monkeypatch, missing)
    api = protocol.api()

    async def unexpected(*args, **kwargs):
        pytest.fail("Missing optional TUI must be detected before requesting data")

    monkeypatch.setattr(api, "request", unexpected)
    errors = io.StringIO()
    assert await run(["tui", "tasks"], api=api, stderr=errors) == 1
    assert "TUI is optional" in errors.getvalue()
    assert ".[tui]" in errors.getvalue()


def test_unrelated_import_failure_is_not_reported_as_missing_extra(monkeypatch):
    block_workbench(monkeypatch, "internal_module")
    with pytest.raises(ModuleNotFoundError, match="internal_module"):
        load_workbench()
