import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../web-server";

let directory: string;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coleo-web-test-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Coleo</title>");
  await writeFile(join(directory, "assets/app.js"), "console.log('coleo')");
  await writeFile(join(directory, "assets/empty.css"), "");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await rm(directory, { recursive: true, force: true });
});

async function host(apiUrl = "http://127.0.0.1:1", apiKey?: string) {
  const server = await createWebServer({ distPath: directory, apiUrl, apiKey, host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.stop(true));
  return server;
}

test("serves deep links, MIME types, empty files, HEAD and revalidation; missing assets give hints", async () => {
  const server = await host();
  const page = await fetch(new URL("/projects/123?view=tasks", server.url));
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("cache-control")).toBe("no-cache");
  expect(await page.text()).toContain("<title>Coleo</title>");
  const js = await fetch(new URL("/assets/app.js", server.url));
  expect(js.headers.get("content-type")).toContain("javascript");
  expect(await js.text()).toContain("console.log");
  const head = await fetch(new URL("/assets/app.js", server.url), { method: "HEAD" });
  expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
  expect(await head.text()).toBe("");
  expect((await fetch(new URL("/assets/empty.css", server.url))).status).toBe(200);
  for (const path of ["/assets/missing", "/missing.js"]) {
    const missing = await fetch(new URL(path, server.url));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("coleo-install install web");
  }
  expect((await fetch(server.url, { method: "POST" })).status).toBe(405);
});

test("contains decoded paths and symlinks inside the artifact", async () => {
  await symlink(join(directory, ".."), join(directory, "outside"));
  const server = await host();
  expect((await fetch(new URL("/outside/", server.url))).status).toBe(403);
  expect((await fetch(new URL("/%2e%2e%2fsecret", server.url))).status).toBe(403);
  expect((await fetch(new URL("/%ZZ", server.url))).status).toBe(400);
});

test("proxies HTTP bodies, status, headers, auth, queries and uploads without following redirects", async () => {
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/redirect") return new Response(null, { status: 307, headers: { Location: "/login" } });
    return Response.json({ path: url.pathname, query: url.search, method: req.method,
      body: await req.text(), auth: req.headers.get("authorization"), cookie: req.headers.get("cookie") },
    { status: 422, headers: { "x-upstream": "yes", "set-cookie": "session=test; HttpOnly" } });
  } });
  cleanups.push(() => api.stop(true));
  const server = await host(api.url.toString());
  for (const path of ["/api/tasks", "/uploads/image.png"]) {
    const response = await fetch(new URL(`${path}?q=a%2Bb&n=2`, server.url), {
      method: "POST", body: "payload", headers: { Authorization: "Bearer test", Cookie: "session=in" },
    });
    expect(response.status).toBe(422);
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(response.headers.get("set-cookie")).toContain("session=test");
    expect(await response.json()).toEqual({ path, query: "?q=a%2Bb&n=2", method: "POST", body: "payload",
      auth: "Bearer test", cookie: "session=in" });
  }
  const redirect = await fetch(new URL("/api/redirect", server.url), { redirect: "manual" });
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe("/login");
  expect(await (await fetch(new URL("/apiary", server.url))).text()).toContain("<title>Coleo</title>");
  api.stop(true);
  expect((await fetch(new URL("/api/tasks", server.url))).status).toBe(502);
});

test("WebSockets preserve auth, query, selected subprotocol, text/binary messages and upstream close", async () => {
  let handshake: { auth: string | null; cookie: string | null; query: string; protocols: string | null };
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      handshake = { auth: req.headers.get("authorization"), cookie: req.headers.get("cookie"),
        query: new URL(req.url).search, protocols: req.headers.get("sec-websocket-protocol") };
      if (server.upgrade(req, { headers: { "sec-websocket-protocol": "coleo" } })) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(ws) { ws.send("welcome"); },
      message(ws, message) {
        if (message === "close") ws.close(4001, "finished");
        else ws.send(message);
      },
    },
  });
  cleanups.push(() => api.stop(true));
  const server = await host(api.url.toString());
  const BunWebSocket = WebSocket as unknown as {
    new(url: string | URL, options: Bun.WebSocketOptions): WebSocket;
  };
  const ws = new BunWebSocket(new URL("/ws?token=a%2Bb", server.url).toString().replace("http:", "ws:"), {
    protocols: ["coleo", "other"], headers: { Authorization: "Bearer test", Cookie: "session=in" },
  });
  cleanups.push(() => ws.close());
  ws.binaryType = "arraybuffer";
  const received: (string | number[])[] = [];
  const closed = new Promise<CloseEvent>((resolve, reject) => {
    ws.onerror = reject;
    ws.onopen = () => { ws.send("hello"); ws.send(new Uint8Array([0, 128, 255])); ws.send("close"); };
    ws.onmessage = event => received.push(typeof event.data === "string" ? event.data : [...new Uint8Array(event.data)]);
    ws.onclose = resolve;
  });
  const event = await closed;
  expect(handshake!).toEqual({ auth: "Bearer test", cookie: "session=in", query: "?token=a%2Bb", protocols: "coleo, other" });
  expect(ws.protocol).toBe("coleo");
  expect(received).toEqual(["welcome", "hello", [0, 128, 255]]);
  expect(event.code).toBe(4001);
  expect(event.reason).toBe("finished");
});

test("WebSocket client close reaches the API", async () => {
  let resolveClosed: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>(resolve => { resolveClosed = resolve; });
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message() {}, close(_ws, code, reason) { resolveClosed({ code, reason }); } },
  });
  cleanups.push(() => api.stop(true));
  const server = await host(api.url.toString());
  const ws = new WebSocket(new URL("/ws", server.url).toString().replace("http:", "ws:"));
  cleanups.push(() => ws.close());
  ws.onopen = () => ws.close(4002, "client done");
  // Bun 1.3.14's WebSocket client omits the close reason on the wire, even directly.
  expect((await closed).code).toBe(4002);
});

test("WebSocket authorization rejection never upgrades the browser connection", async () => {
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch() { return new Response("Unauthorized", { status: 401 }); },
  });
  cleanups.push(() => api.stop(true));
  const server = await host(api.url.toString());
  const ws = new WebSocket(new URL("/ws", server.url).toString().replace("http:", "ws:"));
  cleanups.push(() => ws.close());
  let opened = false;
  await new Promise<void>(resolve => {
    ws.onopen = () => { opened = true; ws.close(); };
    ws.onerror = () => resolve();
    ws.onclose = () => resolve();
  });
  expect(opened).toBe(false);
});

test("compressed HTTP responses preserve bytes and encoding headers", async () => {
  const compressed = Bun.gzipSync("compressed upstream body");
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch() { return new Response(compressed, { headers: {
      "content-encoding": "gzip", "content-length": String(compressed.length),
    } }); },
  });
  cleanups.push(() => api.stop(true));
  const server = await host(api.url.toString());
  const response = await fetch(new URL("/api/compressed", server.url), { decompress: false });
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("content-length")).toBe(String(compressed.length));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(compressed);
});

test("selected connection credentials authenticate HTTP and WebSocket upstream only", async () => {
  const key = "selected-private-key";
  const requests: string[] = [];
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      if (req.headers.get("authorization") !== `Bearer ${key}` || req.headers.get("x-api-key") !== key ||
          req.headers.get("x-coleo-api-key") !== key) {
        return new Response("Unauthorized", { status: 401 });
      }
      requests.push(new URL(req.url).pathname);
      if (req.headers.get("upgrade") === "websocket" && server.upgrade(req)) return;
      return Response.json({ authenticated: true });
    },
    websocket: { open(ws) { ws.send("authenticated"); }, message() {} },
  });
  cleanups.push(() => api.stop(true));
  const server = await host(`${api.url}selected`, key);
  const response = await fetch(new URL("/api/status", server.url), {
    headers: { authorization: "Bearer wrong", "x-api-key": "wrong", "x-coleo-api-key": "wrong" },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(key);
  const ws = new WebSocket(new URL("/ws", server.url).toString().replace("http:", "ws:"));
  cleanups.push(() => ws.close());
  expect(await new Promise<string>((resolve, reject) => {
    ws.onmessage = event => resolve(event.data);
    ws.onerror = reject;
  })).toBe("authenticated");
  expect(requests).toEqual(["/selected/api/status", "/selected/ws"]);
  expect(await (await fetch(server.url)).text()).not.toContain(key);
});
