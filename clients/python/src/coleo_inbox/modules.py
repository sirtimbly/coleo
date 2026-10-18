"""Domain modules share API contracts across Rich snapshots and Textual screens."""
import asyncio
from dataclasses import dataclass

from rich.console import Group
from rich.table import Table
from rich.text import Text

from .api import encoded
from .presentation import clean, render_detail


@dataclass(frozen=True)
class Module:
    id: str
    title: str
    description: str
    statuses: tuple[str, ...] = ()


MODULES = {
    "inbox": Module("inbox", "Inbox", "Messages and project activity"),
    "tasks": Module("tasks", "Tasks", "Project work and assignments",
                    ("draft", "pending", "claimed", "in_progress", "completing", "completed", "failed", "blocked", "cancelled")),
    "bugs": Module("bugs", "Bugs", "Reports, priorities, and resolutions",
                   ("open", "investigating", "fixing", "verifying", "resolved", "closed")),
    "brain": Module("brain", "Brain", "Orchestrator status and controls"),
    "dashboard": Module("dashboard", "Dashboard", "Brain, task, and bug summaries"),
}
DOMAIN_MODULES = tuple(key for key in MODULES if key != "inbox")


def record_title(record):
    return record.get("subject") or record.get("title") or record["id"]


def record_owner(record):
    return (record.get("assignedArmName") or record.get("assigneeArmName") or
            record.get("assignedTo") or record.get("assigneeArmId") or "Unassigned")


def validate_record(record):
    if not isinstance(record, dict) or not isinstance(record.get("id"), str) or not record["id"]:
        raise ValueError("Resource has no valid ID")
    return record


async def collection(api, module, *, search="", status="all", limit=100, offset=0, sort=None):
    if module not in ("tasks", "bugs") or status != "all" and status not in MODULES[module].statuses:
        raise ValueError("Invalid collection or status")
    if not 1 <= limit <= 100 or offset < 0:
        raise ValueError("Limit must be 1–100 and offset must be nonnegative")
    if sort is not None and (module != "tasks" or sort != "created-desc"):
        raise ValueError("Only Tasks supports created-desc sorting")
    params = {"limit": limit, "offset": offset}
    if sort is not None:
        params["sort"] = sort
    if search:
        params["search"] = search
    if status != "all":
        params["status"] = status
    response = await api.request(f"/api/{module}", params=params)
    records = response.get(module)
    pagination = response.get("pagination")
    if not isinstance(records, list) or not isinstance(pagination, dict):
        raise ValueError(f"Invalid {module} collection response")
    total = pagination.get("total")
    if type(total) is not int or total < 0:
        raise ValueError("Invalid collection total")
    for record in records:
        validate_record(record)
    if len({r["id"] for r in records}) != len(records):
        raise ValueError("Repeated resource IDs")
    next_offset = offset + len(records)
    return dict(schemaVersion=1, kind="module.collection", module=module, items=records,
                query=dict(search=search, status=status, limit=limit, offset=offset,
                           **({"sort": sort} if sort is not None else {})),
                total=total, nextOffset=next_offset if records and next_offset < total else None)


async def inspect_record(api, module, identifier):
    if module not in ("tasks", "bugs"):
        raise ValueError("Only Tasks and Bugs have record details")
    response = await api.request(f"/api/{module}/{encoded(identifier)}")
    record = validate_record(response.get("task" if module == "tasks" else "bug"))
    if record["id"] != identifier:
        raise ValueError("Detail belongs to another resource")
    return dict(schemaVersion=1, kind="module.detail", module=module, item=record)


async def overview(api, module):
    sources = {"brain": "/api/brain/status"}
    if module == "dashboard":
        sources.update(tasks="/api/tasks/stats", bugs="/api/bugs/stats")
    elif module != "brain":
        raise ValueError("Unknown overview module")

    async def load(name, path):
        try:
            value = await api.request(path)
            if name == "brain" and not isinstance(value.get("brain"), dict):
                raise ValueError("Invalid Brain status response")
            if name != "brain" and not isinstance(value.get("byStatus"), dict):
                raise ValueError(f"Invalid {name} statistics response")
            return name, value, None
        except Exception as exc:
            return name, None, str(exc)

    results = await asyncio.gather(*(load(name, path) for name, path in sources.items()))
    return dict(schemaVersion=1, kind="module.overview", module=module,
                sources={name: value for name, value, error in results if error is None},
                errors={name: error for name, value, error in results if error is not None})


async def brain_action(api, action):
    if action not in ("start", "stop", "pause", "resume"):
        raise ValueError("Unknown Brain action")
    result = await api.request(f"/api/brain/{action}", body={})
    return dict(schemaVersion=1, kind="module.action", module="brain", action=action, result=result)


def overview_text(snapshot):
    """Plain, terminal-safe facts shared by Rich and Textual, without markup."""
    lines = []
    for source in ("brain", "tasks", "bugs"):
        data = snapshot["sources"].get(source)
        error = snapshot["errors"].get(source)
        if data is None and error is None:
            continue
        lines.append(source.title())
        if error:
            lines.append(f"  Unavailable: {error}")
        if data is None:
            lines.append("")
            continue
        if source == "brain":
            brain = data["brain"]
            for key, label in (("status", "Status"), ("activeArmsCount", "Active arms"),
                               ("pendingTasksCount", "Pending tasks"), ("completedToday", "Completed today"),
                                ("lastPollAt", "Last poll"), ("pollIntervalMs", "Poll interval (ms)")):
                lines.append(f"  {label}: {brain.get(key, 'Unknown')}")
            for key in ("plan", "modelAccess"):
                if isinstance(brain.get(key), dict):
                    lines.append(f"  {key}: " + " · ".join(str(brain[key][k]) for k in
                                 ("status", "detail", "nextStep", "message") if brain[key].get(k) is not None))
        else:
            for key in ("total", "active", "blocked", "unresolved", "recent24h"):
                if key in data:
                    lines.append(f"  {key}: {data[key]}")
            lines.append("  By status:")
            lines.extend(f"    {key}: {value}" for key, value in sorted(data["byStatus"].items()))
        lines.append("")
    return clean("\n".join(lines))


def render_module(snapshot, title=None):
    if snapshot["kind"] == "module.detail":
        return render_detail(snapshot["item"])
    if snapshot["kind"] == "module.overview":
        return Text(overview_text(snapshot))
    if snapshot["kind"] == "module.action":
        return render_detail(snapshot["result"])
    table = Table(expand=True)
    for name in ("ID", "Title", "Status", "Priority", "Assigned to"):
        table.add_column(name, overflow="fold" if name == "ID" else "ellipsis", ratio=3 if name == "Title" else 1)
    for record in snapshot["items"]:
        table.add_row(*(Text(clean(value)) for value in (record["id"], record_title(record),
                      record.get("status", "Unknown"), record.get("priority", "—"), record_owner(record))))
    count = Text(f"{len(snapshot['items'])} shown · {snapshot['total']} total · offset {snapshot['query']['offset']}")
    more = Text(f"Next page: --offset {snapshot['nextOffset']}" if snapshot["nextOffset"] is not None else "End of results")
    return Group(Text(clean(title or MODULES[snapshot["module"]].title), style="bold"), table, count, more)
