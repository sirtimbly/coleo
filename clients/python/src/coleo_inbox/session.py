"""One ordered refresh lane; hint bursts coalesce, generations reject obsolete reads."""
import asyncio
import contextlib
import json
from copy import deepcopy

from websockets.asyncio.client import connect

from .contracts import normalize
from .selection import Selection, execute
from .snapshot import load


class Session:
    def __init__(self, api, view, options, changed=lambda: None):
        self.api, self.view, self.options, self.changed = api, view, options, changed
        self.snapshot = None
        self.selection = Selection()
        self.generation = 0
        self.lock = asyncio.Lock()
        self.dirty = asyncio.Event()
        self.connection = "connecting"
        self.error = ""
        self.tasks = []

    def start(self):
        self.tasks = [asyncio.create_task(self.refresh_loop()), asyncio.create_task(self.live())]
        self.dirty.set()

    async def close(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def query(self, **changes):
        q = {**self.options.query, **changes}
        if "mailbox" in changes:
            q["facet"] = "messages"
        if "brainCategory" in changes:
            q["facet"] = "brain"
        normalized = normalize(q)
        if normalized == self.options.query:
            return
        self.options.query = normalized
        self.options.cursor, self.options.pages = None, 1
        self.selection.entries.clear()
        self.snapshot = None
        self.generation += 1
        self.changed()
        self.dirty.set()

    def more(self):
        if self.snapshot and self.snapshot["traversal"]["nextCursor"]:
            self.options.pages = min(100, self.options.pages + 1)
            self.generation += 1
            self.dirty.set()

    async def refresh_loop(self):
        while True:
            await self.dirty.wait()
            await asyncio.sleep(.12)
            self.dirty.clear()
            await self.refresh()

    async def refresh(self):
        async with self.lock:
            generation = self.generation
            try:
                result = await load(self.api, self.view, deepcopy(self.options))
                if generation != self.generation:
                    return
                if not result["complete"] and self.snapshot:
                    healthy = {s["id"] for p in result["pages"] for s in p["sources"] if s["status"] == "fresh" and s["complete"]}
                    ids = {i["id"] for i in result["items"]}
                    retained = [i for i in self.snapshot["items"] if i["sourceId"] not in healthy and i["id"] not in ids]
                    result["items"].extend(retained)
                    if retained:
                        result["diagnostics"].append(f"Retained {len(retained)} stale items from unavailable sources; actions disabled")
                self.snapshot, self.error = result, ""
            except Exception as exc:
                if generation != self.generation:
                    return
                self.error = str(exc)
                if self.snapshot:
                    self.snapshot["complete"] = False
                    self.snapshot["diagnostics"] = [f"Retained stale data: {exc}"]
            self.changed()

    async def mark_read(self):
        async with self.lock:
            if not self.snapshot:
                raise ValueError("No loaded snapshot")
            plan = self.selection.plan(self.snapshot)
            result = await execute(self.api, plan)
            # Never automatically retry writes, including partially successful batches.
            self.selection.entries.clear()
            self.error = result.get("error", f"Read {len(result['completedMessageIds'])} messages / {len(result['completedItemIds'])} items; skipped {len(result['skippedMemberIds'])} context members")
            self.changed()
        self.dirty.set()
        return result

    async def live(self):
        url = self.api.url.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/ws"
        delay = .5
        while True:
            try:
                async with connect(url, open_timeout=10, max_size=2**20) as ws:
                    await ws.send(json.dumps({"type": "auth", "apiKey": self.api.key}))
                    async with asyncio.timeout(10):
                        while True:
                            auth = json.loads(await ws.recv())
                            if auth.get("type") == "auth":
                                if auth.get("success") is not True:
                                    raise ValueError("WebSocket authentication rejected")
                                break
                    for channel in ("workbench", "mail", "activity", "brain", "tasks", "bugs", "arms", "proposals"):
                        await ws.send(json.dumps({"type": "subscribe", "channel": channel}))
                    self.connection = "live / authenticated"
                    self.changed()
                    self.dirty.set()  # socket-only reconnect always recovers via HTTP
                    delay = .5
                    async def heartbeat():
                        while True:
                            await ws.send('{"type":"ping"}')
                            await asyncio.sleep(20)
                    ping = asyncio.create_task(heartbeat())
                    try:
                        async for raw in ws:
                            hint = json.loads(raw)
                            if hint.get("channel") and hint.get("event"):
                                self.dirty.set()
                    finally:
                        ping.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await ping
                    self.connection = "disconnected; retrying"
                    self.changed()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.connection = f"disconnected: {type(exc).__name__}: {exc}; retrying"
                self.changed()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15)
