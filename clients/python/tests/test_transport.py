import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from websockets.asyncio.server import serve

from coleo_inbox.api import Api
from coleo_inbox.contracts import normalize
from coleo_inbox.options import parse
from coleo_inbox.session import Session


async def until(predicate, timeout=4):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.02)


async def test_real_websocket_auth_burst_reconnect(protocol):
    connections, received = [], []
    release = asyncio.Event()
    async def handler(ws):
        connections.append(ws)
        auth = json.loads(await ws.recv())
        received.append(auth)
        assert auth == {"type": "auth", "apiKey": "secret"}
        await ws.send(json.dumps({"type": "auth", "success": True}))
        channels = []
        while len(channels) < 8:
            msg = json.loads(await ws.recv())
            received.append(msg)
            if msg["type"] == "subscribe":
                channels.append(msg["channel"])
        if len(connections) == 1:
            await release.wait()
            for i in range(80):
                await ws.send(json.dumps({"channel": "mail", "event": "mail.read", "data": {"i": i}, "timestamp": "2026-10-09T12:00:00Z"}))
            await asyncio.sleep(.3)
            await ws.close()
        else:
            async for _ in ws:
                pass
    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        api = protocol.api()
        api.url = f"http://127.0.0.1:{port}"
        session = Session(api, protocol.view, parse([], protocol.view))
        session.start()
        await until(lambda: session.snapshot is not None)
        initial = sum(c[1] == "/api/workbench/inbox" for c in protocol.calls)
        release.set()
        await until(lambda: len(connections) >= 2)
        await asyncio.sleep(.3)
        count = sum(c[1] == "/api/workbench/inbox" for c in protocol.calls)
        assert initial + 2 <= count <= initial + 4  # bounded burst plus reconnect recovery
        assert session.connection == "live / authenticated"
        assert sum(m["type"] == "auth" for m in received) == 2
        await session.close()
        assert all(t.done() for t in session.tasks)
        await api.close()


async def test_auth_rejection_never_subscribes(protocol):
    messages = []
    async def handler(ws):
        messages.append(json.loads(await ws.recv()))
        await ws.send('{"type":"auth","success":false,"error":"Invalid API key"}')
        async for message in ws:
            messages.append(json.loads(message))
    async with serve(handler, "127.0.0.1", 0) as server:
        api = protocol.api()
        api.url = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        session = Session(api, protocol.view, parse([], protocol.view))
        task = asyncio.create_task(session.live())
        await until(lambda: "disconnected" in session.connection)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert [m["type"] for m in messages] == ["auth"]
        await api.close()


async def test_real_http_headers_and_query(protocol):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            from urllib.parse import parse_qs, urlsplit
            requests.append(dict(self.headers))
            q = normalize(json.loads(parse_qs(urlsplit(self.path).query)["query"][0]))
            body = json.dumps(protocol.page(q)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    api = Api(f"http://127.0.0.1:{server.server_port}", key="secret")
    try:
        page = await api.page(normalize({"search": "日本語"}))
        assert page["query"]["search"] == "日本語"
        assert requests[0]["X-API-Key"] == "secret"
        assert requests[0]["Authorization"] == "Bearer secret"
    finally:
        await api.close()
        server.shutdown()
        server.server_close()
        thread.join()
