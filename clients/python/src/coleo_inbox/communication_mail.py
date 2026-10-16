"""API-only mail operations and complete offset collection reads."""
from datetime import datetime

from .api import encoded


async def pages(api, path, key, params=None, limit=None, offset=0):
    items = []
    identifiers = set()
    while True:
        size = min(100, limit - len(items)) if limit is not None else 100
        if size <= 0:
            return items
        response = await api.request(path, params={**(params or {}), "limit": size, "offset": offset})
        batch = response.get(key)
        pagination = response.get("pagination", {})
        total = pagination.get("total")
        if not isinstance(batch, list) or not isinstance(total, int) or total < 0:
            raise ValueError(f"Invalid pagination from {path}")
        for item in batch:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                raise ValueError(f"Invalid record from {path}")
            if item["id"] in identifiers:
                raise ValueError(f"Collection changed during pagination: {path}; run the command again")
            identifiers.add(item["id"])
        items.extend(batch)
        offset += len(batch)
        if offset >= total:
            return items
        if not batch:
            raise ValueError(f"Incomplete pagination from {path}")


def select_unique(items, reference, *, title=False):
    exact = [item for item in items if item["id"] == reference]
    matches = exact or [item for item in items if (
        reference.casefold() in item.get("title", "").casefold() if title
        else item["id"].startswith(reference))]
    if not matches:
        raise ValueError(f"No matching record: {reference}")
    if len(matches) != 1:
        raise ValueError(f"Ambiguous reference {reference!r}; use an exact ID: " +
                         ", ".join(item["id"] for item in matches))
    return matches[0]


async def mail(api, options):
    if options.operation == "send":
        # JavaScript slice counts UTF-16 units, not Python Unicode code points.
        prefix = options.message.encode("utf-16-le", errors="surrogatepass")[:100].decode(
            "utf-16-le", errors="replace")
        subject = options.subject or f"New task: {prefix}..."
        return await api.request("/api/mail/send", {
            "from": "human@local", "to": "brain@coleo.local", "subject": subject,
            "body": options.message, "headers": {},
        }, method="POST")
    messages = await pages(api, "/api/mail/inbox", "messages",
                           limit=options.count if options.operation == "inbox" else None)
    if options.operation == "inbox":
        return {"messages": messages}
    if not messages:
        if options.id:
            raise ValueError(f"No matching record: {options.id}")
        return {"message": None}
    selected = select_unique(messages, options.id) if options.id else max(
        messages, key=lambda item: datetime.fromisoformat(item["date"].replace("Z", "+00:00")))
    identifier = selected["id"]
    result = await api.request(f"/api/mail/inbox/{encoded(identifier)}")
    message = result.get("message")
    if not isinstance(message, dict) or message.get("id") != identifier:
        raise ValueError("Mail detail returned a different message")
    if not message.get("flags", {}).get("seen"):
        try:
            await api.request(f"/api/mail/folders/inbox/messages/{encoded(identifier)}/flags",
                              {"flags": {"seen": True}}, method="PATCH")
            result["markedRead"] = True
        except ValueError as exc:
            result["errors"] = [{"operation": "mark-read", "id": identifier, "error": str(exc)}]
            result["markedRead"] = False
    return result
