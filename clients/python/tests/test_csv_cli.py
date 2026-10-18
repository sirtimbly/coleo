import io
import json
import sys

import httpx
import pytest

from coleo_inbox.api import Api
from coleo_inbox.cli import run


class CsvProtocol:
    def __init__(self, module):
        self.module = module
        self.calls = []
        self.csv = 'id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n'
        self.csv += 'one,Unicode 🐙,pending,1,notes,Unicode 🐙,pending,1,notes\n'
        self.result = dict(schemaVersion=1, kind="module.csv.import", module=module,
                           totalRows=1, changed=1, unchanged=0, missing=[], invalid=[], conflicts=[],
                           changes=[dict(id="one", fields=["notes"])])

    def api(self):
        def handle(request):
            self.calls.append(request)
            if request.method == "GET":
                assert request.url.path == f"/api/{self.module}/csv/export"
                return httpx.Response(200, json=dict(schemaVersion=1, kind="module.csv.export",
                                                    module=self.module, csv=self.csv))
            assert request.url.path == f"/api/{self.module}/csv/import"
            return httpx.Response(200, json=self.result)
        return Api("http://fixture", transport=httpx.MockTransport(handle))


@pytest.mark.parametrize("module", ["tasks", "bugs"])
async def test_csv_export_import_json_rich_and_partial_results(tmp_path, module):
    protocol = CsvProtocol(module)
    path = tmp_path / "list.csv"
    output = io.StringIO()
    assert await run([module, "csv-export", str(path), "-f", "pending", "--json"],
                     api=protocol.api(), stdout=output) == 0
    assert path.read_text() == protocol.csv
    assert dict(protocol.calls[0].url.params) == {"filter": "pending"}
    assert json.loads(output.getvalue())["path"] == str(path)
    path.write_text(protocol.csv.replace("notes", "edited%0Anotes", 1), encoding="utf-8-sig")
    output = io.StringIO()
    assert await run([module, "csv-import", str(path)], api=protocol.api(), stdout=output) == 0
    assert "changed" in output.getvalue() and "notes" in output.getvalue()
    sent = json.loads(protocol.calls[-1].content)["csv"]
    assert "edited%0Anotes" in sent and not sent.startswith("\ufeff")
    protocol.result["conflicts"] = ["one: notes changed since export"]
    assert await run([module, "csv-import", str(path), "--json"], api=protocol.api(), stdout=io.StringIO()) == 2
    protocol.result["invalid"] = ["Bad row"]
    assert await run([module, "csv-import", str(path), "--json"], api=protocol.api(), stdout=io.StringIO()) == 1


@pytest.mark.parametrize("arguments", [["csv-export"], ["csv-import"], ["csv-edit", "extra.csv"],
    ["csv-import", "one.csv", "--filter", "all"], ["csv-export", "one.csv", "--status", "pending"],
    ["list", "--filter", "pending"]])
async def test_invalid_csv_arguments_do_not_request(arguments):
    protocol = CsvProtocol("tasks")
    assert await run(["tasks", *arguments, "--json"], api=protocol.api(), stdout=io.StringIO()) == 1
    assert protocol.calls == []


async def test_editor_precedence_success_cleanup_and_failure(tmp_path, monkeypatch):
    script = tmp_path / "test editor.py"
    script.write_text("import pathlib,sys\np=pathlib.Path(sys.argv[1])\np.write_text(p.read_text().replace('notes','edited',1))\n")
    monkeypatch.setenv("COLEO_CSV_EDITOR", f'"{sys.executable}" "{script}"')
    monkeypatch.setenv("COLEO_EDITOR", "nonexistent-editor")
    protocol = CsvProtocol("tasks")
    assert await run(["tasks", "csv-edit", "--json"], api=protocol.api(), stdout=io.StringIO()) == 0
    assert "edited" in json.loads(protocol.calls[-1].content)["csv"]
    script.write_text("import sys\nsys.exit(7)\n")
    protocol.calls.clear()
    assert await run(["tasks", "csv-edit", "--json"], api=protocol.api(), stdout=io.StringIO()) == 1
    assert [r.method for r in protocol.calls] == ["GET"]


async def test_discussions_read_post_reply_and_validation(monkeypatch):
    monkeypatch.setattr("coleo_inbox.discussion_cli.author", lambda: ("person@example.com", "Person"))
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.raw_path.split(b"?")[0] == b"/api/tasks/task%2Fone/discussions"
        if request.method == "POST":
            assert json.loads(request.content) == dict(content="A comment", parentId="parent",
                authorType="human", authorId="person@example.com", authorName="Person", client="cli")
            return httpx.Response(200, json={"comment": {"id": "new-comment"}})
        assert dict(request.url.params) == {"limit": "20", "offset": "0"}
        return httpx.Response(200, json={"discussions": [{"id": "comment", "content": "**Important** 🐙",
                                                        "authorName": "Person"}], "totalCount": 1})
    def api():
        return Api("http://fixture", transport=httpx.MockTransport(handle))
    output = io.StringIO()
    assert await run(["tasks", "discussions", "task/one"], api=api(), stdout=output) == 0
    assert "Important" in output.getvalue()
    output = io.StringIO()
    assert await run(["tasks", "discuss", "task/one", "A comment", "-r", "parent", "--json"],
                     api=api(), stdout=output) == 0
    assert json.loads(output.getvalue())["comment"]["id"] == "new-comment"
    for args in (["discuss", "one"], ["discussions", "one", "--limit", "0"],
                 ["list", "one", "extra"], ["discussions", "one", "--reply-to", "parent"]):
        assert await run(["tasks", *args, "--json"], api=api(), stdout=io.StringIO()) == 1
    assert len(calls) == 2
