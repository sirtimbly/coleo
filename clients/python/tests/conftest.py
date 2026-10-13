import json
from copy import deepcopy
from importlib.resources import files

import httpx
import pytest

from coleo_inbox.api import Api
from coleo_inbox.contracts import compact, normalize, reference, sources


def fixture(name):
    return json.loads(files("coleo_inbox").joinpath(f"fixtures/{name}.json").read_text())


class Protocol:
    def __init__(self):
        self.calls = []
        self.partial = False
        self.stale = False
        self.thread = fixture("thread")
        self.view = fixture("cli-view")

    def page(self, q, cursor=None):
        item = dict(id="thread:" + self.thread["id"], revision=self.thread["revision"], sourceId="mail", kind="brain", representation="thread",
                    title=self.thread["subject"], summary="Thread summary", timestamp=self.thread["lastMessageAt"], source="Mail", unread=True,
                    requiresAction=False, severity="info", detail=dict(kind="thread", threadId=self.thread["id"], mailbox="inbox"), thread=deepcopy(self.thread))
        record = dict(id="status:one", revision="1", sourceId="records", kind="status", representation="resource", title="Build passed", summary="Status summary",
                      timestamp="2026-10-09T11:00:00.000Z", source="Arm", unread=True, requiresAction=False, severity="success", detail=dict(kind="record", itemKey="status:one"))
        items = [record] if cursor else [item]
        return dict(schemaVersion=1, queryId=compact(q), query=q, cursor=cursor, nextCursor=None if cursor else "older",
                    items=items, sources=[dict(id=s, status="unavailable" if self.partial and s == "mail" else "fresh", revision="1", asOf="2026-10-09T12:00:00.000Z", complete=not self.partial) for s in sources(q)],
                    summaries=dict(scope="query", total=None if self.partial else 2, unread=None if self.partial else 2, requiresAction=0, complete=not self.partial))

    def handle(self, request):
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, dict(request.url.params), body))
        path = request.url.path
        if path == "/api/workbench/named-views":
            data = {"schemaVersion": 1, "views": ["inbox-triage"]}
        elif path.startswith("/api/workbench/named-views/"):
            data = fixture("tui-view") if request.url.params.get("client") == "tui" else self.view
        elif path == "/api/workbench/inbox":
            data = self.page(normalize(json.loads(request.url.params["query"])), request.url.params.get("cursor"))
        elif "/references/" in path:
            identifier = "thread:" + self.thread["id"]
            ref = path.rsplit("/", 1)[1]
            for n in self.thread["hierarchy"]["nodes"]:
                if ref in (n["id"], reference(n["id"])):
                    identifier = n["id"]
            data = dict(schemaVersion=1, id=identifier, detail=dict(kind="thread", threadId=self.thread["id"], mailbox="inbox"), complete=True, diagnostics=[])
        elif path.endswith("/actions"):
            if self.stale or body["revision"] != self.thread["revision"]:
                return httpx.Response(409, json={"error": "Thread changed; reload before acting on selected members"})
            nodes = {n["id"]: n for n in self.thread["hierarchy"]["nodes"]}
            completed, skipped = [], []
            for member in body["memberIds"]:
                inbox = [loc["messageId"] for loc in nodes[member]["data"]["locations"] if loc["mailbox"] == "inbox"]
                completed.extend(inbox)
                if not inbox:
                    skipped.append(member)
            data = dict(ok=True, completedMessageIds=completed, skippedMemberIds=skipped)
        elif path.startswith("/api/mail/threads/"):
            data = fixture("detail")
        elif path == "/api/workbench/attention/bulk":
            data = {"ok": True}
        else:
            return httpx.Response(404, json={"error": f"Unknown route {path}"})
        return httpx.Response(200, json=data)

    def api(self):
        return Api("http://fixture", key="secret", transport=httpx.MockTransport(self.handle))


@pytest.fixture
def protocol():
    return Protocol()
