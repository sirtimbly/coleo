"""Small wire boundary; preserve original envelopes and reject incompatible identity."""
import hashlib
import json
from datetime import datetime, timezone


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def reference(identifier):
    return "@" + hashlib.sha256(identifier.encode()).hexdigest()[:8]


def normalize(value):
    allowed = {"schemaVersion", "scope", "profileId", "facet", "mailbox", "brainCategory", "search", "filters", "sort", "limit"}
    if set(value) - allowed or value.get("schemaVersion", 1) != 1:
        raise ValueError("Unsupported Messaging query")
    scope = value.get("scope", "inbox")
    facet = value.get("facet", "messages" if scope == "mail" else "attention")
    mailbox = value.get("mailbox", "inbox")
    category = value.get("brainCategory", "all")
    sort = value.get("sort", {"field": "timestamp", "direction": "desc"})
    limit = value.get("limit", 100)
    if scope not in ("inbox", "mail") or facet not in ("attention", "messages", "brain", "arms", "history", "all"):
        raise ValueError("Invalid scope/facet")
    if scope == "mail" and facet != "messages":
        raise ValueError("Mail scope only supports the messages facet")
    if mailbox not in ("inbox", "sent", "archive") or category not in ("all", "operations", "tasks", "arms", "decisions", "planning", "alerts"):
        raise ValueError("Invalid mailbox/category")
    if sort.get("field") != "timestamp" or sort.get("direction") not in ("asc", "desc") or set(sort) != {"field", "direction"}:
        raise ValueError("Invalid sort")
    if type(limit) is not int or not 1 <= limit <= 200:
        raise ValueError("Limit must be 1–200")
    profile = value.get("profileId", "local").strip()
    if not profile:
        raise ValueError("Profile is required")
    filters = {}
    for f in value.get("filters", []):
        if set(f) != {"field", "operator", "value"}:
            raise ValueError("Invalid filter")
        field, op, val = f["field"], f["operator"], f["value"]
        if field == "kind" and op in ("in", "notIn"):
            if not isinstance(val, list) or set(val) - {"brain", "arm", "project", "status", "proposal", "system"}:
                raise ValueError("Invalid kind filter")
            val = sorted(set(val))
        elif field in ("unread", "requiresAction") and op == "equals" and type(val) is bool:
            pass
        elif field == "timestamp" and op in ("before", "after"):
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                raise ValueError("Timestamp needs timezone")
            val = dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        else:
            raise ValueError("Invalid filter")
        normalized = {"field": field, "operator": op, "value": val}
        filters[compact(normalized)] = normalized
    return dict(schemaVersion=1, scope=scope, profileId=profile, facet=facet,
                mailbox=mailbox if facet == "messages" else "inbox",
                brainCategory=category if facet == "brain" else "all",
                search=value.get("search", "").strip().lower(), filters=[filters[k] for k in sorted(filters)],
                sort=dict(field="timestamp", direction=sort["direction"]), limit=limit)


def hierarchy(thread):
    h = thread["hierarchy"]
    nodes = {n["id"]: n for n in h["nodes"]}
    if h["schemaVersion"] != 1 or len(nodes) != len(h["nodes"]):
        raise ValueError("Invalid hierarchy")
    children = {identifier: [] for identifier in nodes}
    for n in nodes.values():
        if n["parentId"] is not None:
            if n["parentId"] not in nodes:
                raise ValueError("Missing hierarchy parent")
            children[n["parentId"]].append(n["id"])
    visited = set()
    def walk(identifier, depth=0):
        if identifier in visited or depth > 500:
            raise ValueError("Cyclic hierarchy")
        visited.add(identifier)
        result = [(nodes[identifier], depth)]
        for child in children[identifier]:
            result.extend(walk(child, depth + 1))
        return result
    rows = []
    for root in h["rootIds"]:
        if root not in nodes or nodes[root]["parentId"] is not None:
            raise ValueError("Invalid hierarchy root")
        rows.extend(walk(root))
    if len(visited) != len(nodes):
        raise ValueError("Unreachable hierarchy nodes")
    return rows, children


def sources(query):
    return ["mail"] if query["facet"] == "messages" else (["records", "mail", "activity", "events"] if query["facet"] in ("all", "attention") else ["records", "activity", "events"])
