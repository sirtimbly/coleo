import re
from datetime import datetime, timezone

from rich.console import Group
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.tree import Tree

from .contracts import reference


def clean(value):
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", "", str(value))


def state(item):
    return "ACTION" if item.get("requiresAction") else "unread" if item.get("unread") else "read"


def age(value, now=None):
    """Short display-only time; wire JSON and full detail retain exact timestamps."""
    if not value:
        return "unknown"
    try:
        date = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if date.tzinfo is None:
            return "unknown"
        now = now or datetime.now(timezone.utc)
        seconds = (now - date).total_seconds()
        distance = abs(seconds)
        if distance >= 30 * 86400:
            return date.astimezone(timezone.utc).strftime("%d %b" if date.year == now.year else "%Y-%m-%d")
        amount = "now" if distance < 60 else f"{int(distance // 60)}m" if distance < 3600 else f"{int(distance // 3600)}h" if distance < 86400 else f"{int(distance // 86400)}d"
        return f"in {amount}" if seconds < -60 else amount
    except (ValueError, TypeError, OverflowError):
        return "unknown"


def source_label(value):
    label = clean(value or "")
    match = re.fullmatch(r"(Inbox|Sent|Archive)\s*[·•]\s*(\d+)\s+messages?", label, re.IGNORECASE)
    return f"{match[1].title()} ({match[2]})" if match else label


def card(item):
    return Panel(Group(Text(clean(item.get("title", "")), style="bold"),
                       Text(clean(item.get("summary", ""))),
                       Text(f"{source_label(item.get('source'))} · {age(item.get('timestamp'))} · {state(item)}", style="dim")),
                 title=reference(item["id"]), border_style="cyan")


def render(snapshot, width=100):
    parts = [Text(f"Inbox · {snapshot['query']['facet']} · {len(snapshot['items'])} loaded", style="bold cyan")]
    summaries = snapshot["pages"][0]["summaries"]
    count = lambda key: str(summaries[key]) if summaries[key] is not None else "unknown"
    parts.append(Text(f"Query: {count('total')} total · {count('unread')} unread · {count('requiresAction')} need action", no_wrap=True, overflow="ellipsis"))
    rows = snapshot["rows"]
    presentation = snapshot["presentation"]["id"]
    if presentation == "cards":
        parts.extend(card({"id": r["id"], **r["values"]}) for r in rows)
    elif presentation == "timeline":
        timeline = Tree("Timeline · loaded window")
        for r in rows:
            v = r["values"]
            timeline.add(Text(clean(f"{age(v.get('timestamp'))}  {reference(r['id'])}  {v.get('title', '')}"))).add(Text(clean(v.get("summary") or "")))
        parts.append(timeline)
    else:
        table = Table(expand=True, show_lines=False, padding=(0, 1))
        table.add_column("Ref", width=9, no_wrap=True)
        table.add_column("Subject", ratio=3, overflow="ellipsis", no_wrap=True)
        if width >= 65:
            table.add_column("Source", max_width=16, no_wrap=True, overflow="ellipsis")
            table.add_column("State", width=6, no_wrap=True)
        if width >= 95:
            table.add_column("Age", max_width=10, no_wrap=True)
        for r in rows:
            v = r["values"]
            cells = [reference(r["id"]), "  " * r["depth"] + clean(v.get("title") or "")]
            if width >= 65:
                cells += [source_label(v.get("source")), state(v)]
            if width >= 95:
                cells.append(age(v.get("timestamp")))
            table.add_row(*(Text(c) for c in cells))
        parts.append(table)
    for m in snapshot["metadata"]:
        value = age(m["value"]) if m["field"] == "timestamp" else m["value"] if m["value"] is not None else "unknown"
        parts.append(Text(f"{m['label']}: {value} ({m['scope']})"))
    # Report every page's worst source status, without exposing long revisions.
    statuses = {}
    for page in snapshot["pages"]:
        for source in page["sources"]:
            status = source["status"] + ("/partial" if not source["complete"] else "")
            rank = ({"fresh": 0, "stale": 1, "unavailable": 2}.get(source["status"], 3), not source["complete"])
            if source["id"] not in statuses or rank > statuses[source["id"]][0]:
                statuses[source["id"]] = (rank, status)
    parts.append(Text("Sources: " + " · ".join(f"{key} {value[1]}" for key, value in statuses.items()), no_wrap=True, overflow="ellipsis"))
    for d in snapshot["diagnostics"]:
        parts.append(Text(clean(d), style="yellow"))
    t = snapshot["traversal"]
    parts.append(Text("Complete requested window" if snapshot["complete"] else "PARTIAL — actions disabled", style="green" if snapshot["complete"] else "yellow"))
    if t["nextCursor"]:
        parts.append(Text("More · --pages; cursor in --json", no_wrap=True, overflow="ellipsis"))
    return Group(*parts)


def detail_markdown(detail):
    messages = detail.get("messages", [detail["message"]] if "message" in detail else [])
    if messages:
        return "\n\n---\n\n".join(f"# {clean(m.get('subject', 'Message'))}\n\nFrom: {clean(m.get('from', ''))}  \nTo: {clean(m.get('to', ''))}  \n{clean(m.get('timestamp', ''))}\n\n{clean(m.get('body', ''))}" for m in messages)
    # Record/event details vary; expose every field recursively without a raw JSON envelope.
    def fields(value, depth=2):
        if isinstance(value, dict):
            return "\n\n".join(f"{'#' * min(depth, 6)} {clean(k)}\n\n{fields(v, depth + 1)}" for k, v in value.items())
        if isinstance(value, list):
            return "\n\n".join(fields(v, depth) for v in value)
        return clean(value)
    return fields(detail)


def render_detail(detail):
    return Markdown(detail_markdown(detail))
