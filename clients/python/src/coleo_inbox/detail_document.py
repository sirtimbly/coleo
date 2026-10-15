"""Readable native message/record cards; complete wire data stays inspectable."""
import asyncio
import json

from textual import work
from textual.containers import Vertical, VerticalScroll
from textual.widgets import Collapsible, Markdown, Static

from .presentation import clean, detail_markdown


class DetailCard(Vertical):
    DEFAULT_CSS = """
    DetailCard { height: auto; margin: 0 0 1 0; padding: 1; border: round $border-blurred; }
    DetailCard > .card-title { height: auto; text-style: bold; }
    DetailCard > .card-meta { height: auto; color: $text-muted; margin-bottom: 1; }
    DetailCard Markdown { margin: 0; padding: 0; }
    DetailCard Collapsible { padding: 0; margin-top: 1; border: none; }
    DetailCard .technical-data { height: auto; }
    """

    def __init__(self, record):
        super().__init__()
        self.record = record

    def compose(self):
        record = self.record
        yield Static(clean(record.get("subject") or record.get("title") or record.get("kind") or "Details"),
                     classes="card-title", markup=False)
        facts = [f"{label}: {clean(record[key])}" for key, label in (
            ("from", "From"), ("to", "To"), ("status", "Status"), ("priority", "Priority"),
            ("source", "Source"), ("timestamp", "Date"), ("updatedAt", "Updated")) if record.get(key) is not None]
        if facts:
            yield Static(" · ".join(facts), classes="card-meta", markup=False)
        body = record.get("body") or record.get("description") or record.get("summary")
        if isinstance(body, str):
            yield Markdown(clean(body))
            for key, label in (("blockedReason", "Blocked reason"), ("resolution", "Resolution"),
                               ("nextSteps", "Next steps")):
                if record.get(key):
                    yield Markdown(f"### {label}\n\n{clean(record[key])}")
        else:
            yield Markdown(detail_markdown(record))
        with Collapsible(title="Technical details", collapsed=True):
            yield Static(clean(json.dumps(record, ensure_ascii=False, indent=2)), classes="technical-data", markup=False)


class DetailDocument(VerticalScroll):
    DEFAULT_CSS = """
    DetailDocument { padding: 1; }
    DetailDocument > Markdown { margin: 0; padding: 0; }
    """

    def __init__(self, message="Select a row and press Enter to inspect it.", **kwargs):
        super().__init__(**kwargs)
        self.message = message
        self.payload = None
        self.render_version = 0
        self.render_lock = asyncio.Lock()

    def compose(self):
        yield Markdown(self.message)

    def update(self, message):
        self.payload = None
        self.render_version += 1
        self.render_document(message, None, self.render_version)

    def show_detail(self, payload, diagnostics=()):
        if payload == self.payload and not diagnostics:
            return
        self.payload = payload
        self.render_version += 1
        self.render_document("\n\n".join(clean(d) for d in diagnostics), payload, self.render_version)

    @work(group="detail-render")
    async def render_document(self, message, payload, version):
        # DOM mounts/removals must finish; cancelling them halfway can cancel a
        # child message pump. Coalesce stale content before entering this lane.
        async with self.render_lock:
            if version != self.render_version:
                return
            await self.remove_children()
            if message:
                await self.mount(Markdown(message))
            if payload is not None:
                records = payload.get("messages") or ([payload["message"]] if "message" in payload else [payload])
                await self.mount(*(DetailCard(record) for record in records if isinstance(record, dict)))
            self.scroll_home(animate=False)
