import os
from urllib.parse import quote

import httpx

from .contracts import compact, hierarchy, normalize, reference


def encoded(value):
    return quote(value, safe="")


class Api:
    def __init__(self, url=None, key=None, transport=None):
        self.url = (url or os.getenv("COLEO_API_URL", "http://127.0.0.1:8080")).rstrip("/")
        self.key = key if key is not None else os.getenv("COLEO_API_KEY", "")
        self.client = httpx.AsyncClient(base_url=self.url, timeout=15, transport=transport,
                                       headers={"Authorization": f"Bearer {self.key}", "X-API-Key": self.key} if self.key else {})

    async def close(self):
        await self.client.aclose()

    async def request(self, path, body=None, params=None):
        try:
            r = await self.client.request("GET" if body is None else "POST", path, json=body, params=params)
            value = r.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ValueError(f"Inbox API request failed: {type(exc).__name__}; check COLEO_API_URL") from exc
        if r.is_error:
            raise ValueError(value.get("error", f"HTTP {r.status_code}") if isinstance(value, dict) else f"HTTP {r.status_code}")
        if not isinstance(value, dict):
            raise ValueError("Expected API object envelope")
        return value

    async def view(self, identifier, client="cli"):
        v = await self.request(f"/api/workbench/named-views/{encoded(identifier)}", params={"client": client})
        if v.get("schemaVersion") != 1 or v.get("client") != client or v["definition"]["resource"] != "messaging" or v["definition"]["id"] != identifier:
            raise ValueError("Incompatible named view")
        if v["queryIdentity"] != compact(normalize(v["definition"]["query"])):
            raise ValueError("Incompatible named query identity")
        return v

    async def page(self, query, cursor=None):
        params = {"query": compact(query)}
        if cursor:
            params["cursor"] = cursor
        p = await self.request("/api/workbench/inbox", params=params)
        if p.get("schemaVersion") != 1 or p.get("queryId") != compact(normalize(query)) or p["queryId"] != compact(normalize(p["query"])) or p["cursor"] != cursor:
            raise ValueError("Messaging response belongs to another query/page")
        for item in p["items"]:
            if item["representation"] == "thread" and not item.get("thread"):
                raise ValueError("Thread missing context")
            if item.get("thread"):
                hierarchy(item["thread"])
        return p

    async def inspect(self, ref, profile):
        target = await self.request(f"/api/workbench/inbox/references/{encoded(ref)}", params={"profileId": profile})
        if target.get("schemaVersion") != 1 or ref not in (target["id"], reference(target["id"])):
            raise ValueError("Reference lookup returned another resource")
        d = target["detail"]
        if d["kind"] in ("thread", "message"):
            path = f"/api/mail/threads/{encoded(d['threadId'])}"
            if d["kind"] == "message":
                path += f"/messages/{encoded(d['messageId'])}"
            detail = await self.request(path, params={"mailbox": d["mailbox"]})
        elif d["kind"] in ("event", "activity"):
            detail = await self.request(f"/api/workbench/inbox/events/{encoded(target['id'])}", params={"sequence": d["sequence"]} if d.get("sequence") else None)
        elif target["id"].startswith("status:"):
            detail = await self.request(f"/api/status-reports/{encoded(target['id'][7:])}")
        else:
            detail = await self.request(f"/api/workbench/inbox/records/{encoded(target['id'])}", params={"profileId": profile})
        return target, detail
