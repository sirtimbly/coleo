import io
import json

import httpx
import pytest

from coleo_inbox.api import Api
from coleo_inbox.cli import run


@pytest.mark.parametrize("operation", ["sync", "reparse", "unclaim"])
async def test_maintenance_json_rich_partial_and_single_request(operation):
    calls = []
    result = dict(schemaVersion=1, kind="module.maintenance", module="tasks", operation=operation,
                  workspace="/server/project", added=2, updated=1, deleted=0, unclaimed=3, skipped=0,
                  files=[dict(path="/server/project/.project/plan.md", tasks=2, phases=1, skipped=False)], errors=[])
    def handle(request):
        calls.append(request)
        assert request.method == "POST" and request.url.path == f"/api/tasks/maintenance/{operation}"
        assert json.loads(request.content) == {}
        return httpx.Response(200, json=result)
    def api():
        return Api("http://fixture", transport=httpx.MockTransport(handle))
    output = io.StringIO()
    assert await run(["tasks", operation, "--json"], api=api(), stdout=output) == 0
    assert json.loads(output.getvalue()) == result
    output = io.StringIO()
    assert await run(["tasks", operation, "-v"], api=api(), stdout=output) == 0
    assert "plan.md" in output.getvalue()
    result["errors"] = ["Could not parse plan"]
    assert await run(["tasks", operation, "--json"], api=api(), stdout=io.StringIO()) == 2
    assert len(calls) == 3


@pytest.mark.parametrize("args", [["sync", "extra"], ["reparse", "--limit", "100"],
    ["unclaim", "--status", "pending"], ["sync", "--reply-to", "comment"], ["list", "-v"]])
async def test_bad_maintenance_arguments_send_no_requests(args):
    def handle(request):
        pytest.fail("Invalid command sent an HTTP request")
    api = Api("http://fixture", transport=httpx.MockTransport(handle))
    assert await run(["tasks", *args, "--json"], api=api, stdout=io.StringIO()) == 1
