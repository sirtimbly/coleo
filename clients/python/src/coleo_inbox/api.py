import os
import re
from urllib.parse import quote

import httpx

from .contracts import compact, hierarchy, normalize, reference
from .connections import validate_url


class ApiError(ValueError):
    def __init__(self, category, message, status=None, *, legacy_message=False):
        super().__init__(message if legacy_message else f"{category}: {message}")
        self.category, self.status = category, status


def encoded(value):
    return quote(value, safe="")


class Api:
    def __init__(self, url=None, key=None, transport=None):
        self.url = validate_url(url if url is not None else os.getenv("COLEO_API_URL", "http://127.0.0.1:8080"))
        self.key = key if key is not None else os.getenv("COLEO_API_KEY", "")
        self.client = httpx.AsyncClient(base_url=self.url, timeout=15, transport=transport,
                                       headers={"Authorization": f"Bearer {self.key}", "X-API-Key": self.key} if self.key else {})

    async def close(self):
        await self.client.aclose()

    async def request(self, path, body=None, params=None, *, method=None):
        try:
            r = await self.client.request(method or ("GET" if body is None else "POST"), path, json=body, params=params)
        except httpx.TimeoutException as exc:
            raise ApiError("timeout", "Server did not respond in time; run coleo-client doctor") from exc
        except httpx.HTTPError as exc:
            category = "tls" if any(word in str(exc).lower() for word in ("ssl", "certificate", "tls")) else "unreachable"
            raise ApiError(category, "Cannot reach server; check --server / COLEO_API_URL and run coleo-client doctor") from exc
        if r.is_error:
            category = "authentication" if r.status_code in (401, 403) else "unsupported-capability" if r.status_code in (404, 405, 501) else "request"
            remedy = "check COLEO_API_KEY" if category == "authentication" else "check server version and requested resource" if category == "unsupported-capability" else "check request and server logs"
            # Preserve existing domain error text while redacting credentials.
            if category == "request":
                try:
                    error = r.json().get("error")
                except (ValueError, AttributeError):
                    error = None
                if isinstance(error, str) and error:
                    if self.key:
                        error = error.replace(self.key, "[redacted]")
                    error = re.sub(r"(?i)(https?://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", error)
                    error = re.sub(r"(?i)(api[_-]?key|token|password|authorization)([\s:=]+)[^\s,;]+", r"\1\2[redacted]", error)
                    raise ApiError(category, error, r.status_code, legacy_message=True)
            raise ApiError(category, f"HTTP {r.status_code}; {remedy}", r.status_code)
        try:
            value = r.json()
        except ValueError as exc:
            raise ApiError("invalid-response", "Server returned non-JSON data; check --server and proxy configuration", r.status_code) from exc
        if not isinstance(value, dict):
            raise ApiError("invalid-response", "Expected API object envelope", r.status_code)
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
