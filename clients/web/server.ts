import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";

export const WEB_DIST_HINT = "Install the web component with: coleo-install install web";

interface ProxySocket {
  upstream: WebSocket;
  downstream?: ServerWebSocket<ProxySocket>;
  pending: (string | ArrayBuffer)[];
  closed?: { code: number; reason: string };
}

function proxyHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const connectionHeaders = headers.get("connection")?.split(",") ?? [];
  for (const name of [...connectionHeaders, "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]) {
    headers.delete(name.trim());
  }
  return headers;
}

function closeCode(code: number): number {
  return code === 1005 ? 1000 : code === 1006 || code === 1015 ? 1011 : code;
}

async function upgradeProxy(req: Request, server: Server<ProxySocket>, target: URL, apiKey?: string): Promise<Response | undefined> {
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const headers = proxyHeaders(req.headers);
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
    headers.set("x-api-key", apiKey);
    headers.set("x-coleo-api-key", apiKey);
  }
  for (const name of [...headers.keys()]) {
    if (name.startsWith("sec-websocket-")) headers.delete(name);
  }
  const protocols = req.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim());
  // DOM's constructor declaration omits Bun's additional connection options.
  const BunWebSocket = WebSocket as unknown as {
    new(url: string | URL, options: Bun.WebSocketOptions): WebSocket;
  };
  const upstream = new BunWebSocket(target, { headers: Object.fromEntries(headers), protocols });
  upstream.binaryType = "arraybuffer";
  const data: ProxySocket = { upstream, pending: [] };
  upstream.onmessage = event => {
    if (data.downstream) data.downstream.send(event.data);
    else data.pending.push(event.data);
  };
  upstream.onclose = event => {
    data.closed = { code: closeCode(event.code), reason: event.reason };
    data.downstream?.close(data.closed.code, data.closed.reason);
  };
  const opened = await new Promise<boolean>(resolveOpen => {
    const timer = setTimeout(() => { upstream.close(); resolveOpen(false); }, 10_000);
    const finish = (success: boolean) => { clearTimeout(timer); resolveOpen(success); };
    upstream.onopen = () => finish(true);
    upstream.onerror = () => { finish(false); data.downstream?.close(1011, "API WebSocket unavailable"); };
    upstream.addEventListener("close", () => finish(false), { once: true });
  });
  if (!opened) return new Response("API WebSocket unavailable", { status: 502 });
  const responseHeaders = new Headers();
  if (upstream.protocol) responseHeaders.set("sec-websocket-protocol", upstream.protocol);
  if (server.upgrade(req, { data, headers: responseHeaders })) return undefined;
  upstream.close();
  return new Response("WebSocket upgrade failed", { status: 400 });
}

/** Standalone same-origin host; API traffic goes only to the configured target. */
export async function createWebServer(options: {
  distPath: string;
  apiUrl: string;
  apiKey?: string;
  port: number;
  host: string;
}): Promise<Server<ProxySocket>> {
  const root = await realpath(options.distPath);
  const api = new URL(options.apiUrl);
  if (!["http:", "https:"].includes(api.protocol)) throw new Error("COLEO_API_URL must use http or https");
  return Bun.serve<ProxySocket>({
    port: options.port,
    hostname: options.host,
    async fetch(req, server) {
      const url = new URL(req.url);
      const isRoute = (prefix: string) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
      if (isRoute("/api") || isRoute("/uploads") || isRoute("/ws")) {
        const target = new URL(api);
        target.pathname = `${api.pathname.replace(/\/$/, "")}${url.pathname}`;
        target.search = url.search;
        try {
          if (isRoute("/ws") && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            return await upgradeProxy(req, server, target, options.apiKey);
          }
          const headers = proxyHeaders(req.headers);
          if (options.apiKey) {
            headers.set("authorization", `Bearer ${options.apiKey}`);
            headers.set("x-api-key", options.apiKey);
            headers.set("x-coleo-api-key", options.apiKey);
          }
          const response = await fetch(target, {
            method: req.method,
            headers,
            body: req.body,
            redirect: "manual",
            decompress: false,
            signal: req.signal,
          });
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: proxyHeaders(response.headers),
          });
        } catch {
          return new Response("API server unavailable. Check COLEO_API_URL and start the API server.", { status: 502 });
        }
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { return new Response("Invalid path", { status: 400 }); }
      if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) {
        return new Response("Forbidden", { status: 403 });
      }
      let filePath = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      try {
        filePath = await realpath(filePath);
        if (!filePath.startsWith(`${root}${sep}`)) return new Response("Forbidden", { status: 403 });
        if (!(await stat(filePath)).isFile()) throw new Error("Not a file");
      } catch {
        if (extname(pathname) || isRoute("/assets")) {
          return new Response(`Web asset not found. ${WEB_DIST_HINT}`, { status: 404 });
        }
        filePath = await realpath(resolve(root, "index.html")).catch(() => "");
        if (!filePath.startsWith(`${root}${sep}`)) {
          return new Response(`Web UI build not found. ${WEB_DIST_HINT}`, { status: 404 });
        }
      }
      const file = Bun.file(filePath);
      return new Response(req.method === "HEAD" ? null : file.size === 0 ? "" : file, { headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Content-Length": String(file.size),
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      } });
    },
    websocket: {
      open(ws) {
        ws.data.downstream = ws;
        for (const message of ws.data.pending) ws.send(message);
        ws.data.pending = [];
        if (ws.data.closed) ws.close(ws.data.closed.code, ws.data.closed.reason);
      },
      message(ws, message) {
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(message);
      },
      close(ws, code, reason) { ws.data.upstream.close(closeCode(code), reason); },
    },
  });
}
