import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";

import { initDatabase } from "../../../src/db";
import { createAuthMiddleware } from "../../../src/api/middleware/auth";
import { formatErrorResponse, HttpError } from "../../../src/api/middleware/error";
import { loadMessagingCollection, parseMessagingRequest } from "../../../src/api/messaging-collection";
import { loadMailThreadDetail } from "../../../src/api/mail-thread-projection";
import { createMailRoutes } from "../../../src/api/routes/mail";
import { createWorkbenchInboxRoutes } from "../../../src/api/routes/workbench-inbox";
import { createWorkbenchNamedViewRoutes } from "../../../src/api/routes/workbench-named-views";
import { createWorkbenchAttentionRoutes } from "../../../src/api/routes/workbench-attention";
import { broadcast, createWebSocketHandlers } from "../../../src/api/websocket";
import { writeThreadFixture } from "../../../src/scripts/workbench-demo/thread-fixture-api";
import { THREADED_MAIL_FIXTURE } from "../../../src/workbench/examples/threaded-mail";
import fixtures from "./fixtures.json";

import type { Database } from "bun:sqlite";
import type { IEventStore } from "../../../src/nats/jetstream-types";
import type { MailThreadMessageInput } from "../../../src/workbench/mail-thread-model";

const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset") }).strict(),
  z.object({ action: z.literal("source-outage"), source: z.enum(["mail", "events"]).default("mail"),
    enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("burst"), count: z.number().int().min(1).max(1000).default(50) }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
  z.object({ action: z.literal("add-reply") }).strict(),
  z.object({ action: z.literal("stale-revision") }).strict(),
]);

/** Production routes and WS handlers, isolated storage, no NATS or external mail gateway. */
export async function startBakeoffServer(options: { port?: number; apiKey?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coleo-terminal-bakeoff-"));
  const db = await initDatabase(join(directory, "fixture.db"));
  const apiKey = options.apiKey ?? process.env.API_KEY ?? "dev-terminal-bakeoff";
  let replyNumber = 0;
  let mailOutage = false;
  let eventsOutage = false;
  const store: IEventStore = {
    isInitialized: () => !eventsOutage,
    getEvent: async () => null,
    publishEvent: async () => { throw new Error("Fixture retained store is read-only"); },
    queryEvents: async () => [], getArmEvents: async () => [], getEventsByType: async () => [],
    getRecentEvents: async () => [],
    getStreamMetrics: async () => ({ messages: 0, bytes: 0, firstSequence: 0, lastSequence: 0,
      consumerCount: 0, subjects: [] }),
  };

  async function reset() {
    await rm(join(directory, "mail"), { recursive: true, force: true });
    const roots = fixtures.roots.map((root, index): MailThreadMessageInput => ({
      ...root, mailbox: root.mailbox as MailThreadMessageInput["mailbox"],
      from: "Maya Chen <maya@example.test>", timestamp: `2026-10-01T11:${String(index).padStart(2, "0")}:00.000Z`,
      headers: { "Message-ID": `<${root.id}@example.test>`, "X-Coleo-Thread-Id": root.id },
    }));
    await writeThreadFixture(directory, [...THREADED_MAIL_FIXTURE, ...roots]);
    db.transaction(() => {
      db.run("DELETE FROM workbench_attention");
      db.run("DELETE FROM status_reports");
      db.run("DELETE FROM tasks");
      for (const task of fixtures.tasks) db.run(`INSERT INTO tasks
        (id, subject, description, status, priority, source_type, blocked_reason, created_at, updated_at)
        VALUES (?, ?, ?, 'blocked', 'high', 'manual', 'Human review required', ?, ?)`,
      [task.id, task.subject, task.description, fixtures.timestamp, fixtures.timestamp]);
      db.run(`INSERT INTO status_reports (id, task_id, arm_id, status, summary, created_at)
        VALUES ('bakeoff-report', 'bakeoff-approval', 'arm-fixture', 'needs_review',
        'Both terminal candidates are ready for hands-on review.', ?)`, [fixtures.timestamp]);
      db.run(`INSERT INTO workbench_attention (profile_id, item_key, requires_action, updated_at)
        VALUES ('local', 'thread:inbox:release', 1, ?)`, [fixtures.timestamp]);
    })();
    replyNumber = 0;
    mailOutage = false;
    eventsOutage = false;
  }
  await reset();

  const handlers = createWebSocketHandlers(apiKey);
  type Socket = Parameters<typeof handlers.open>[0];
  const sockets = new Set<Socket>();
  const hint = () => broadcast("mail", "mail.received", { messageId: "fixture-refresh" });
  const app = new Hono<{ Variables: { db: Database } }>();
  app.onError((error, c) => formatErrorResponse(c, error));
  app.use("*", createAuthMiddleware(apiKey));
  // Serialize HTTP reads and controls so reset/outage cannot expose half-written fixtures.
  let pending: Promise<void> = Promise.resolve();
  app.use("*", async (c, next) => {
    const previous = pending;
    let release!: () => void;
    pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { c.set("db", db); await next(); } finally { release(); }
  });
  app.get("/api/health", (c) => c.json({ status: "ok", fixture: "terminal-bake-off", schemaVersion: 1 }));
  app.get("/__test/state", (c) => c.json({ schemaVersion: 1, replyNumber, mailOutage, eventsOutage,
    sockets: sockets.size, expected: fixtures.expected }));
  app.post("/__test/control", async (c) => {
    const parsed = controlSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw HttpError.badRequest(parsed.error.message);
    const control = parsed.data;
    if (control.action === "reset") { await reset(); hint(); }
    if (control.action === "source-outage") {
      if (control.source === "events") eventsOutage = control.enabled;
      else if (mailOutage !== control.enabled) {
        const path = join(directory, "mail", "sent", "new");
        if (control.enabled) { await rename(path, `${path}.saved`); await writeFile(path, "Fixture source outage"); }
        else { await rm(path); await rename(`${path}.saved`, path); }
        mailOutage = control.enabled;
      }
      hint();
      broadcast("activity", "activity.updated", { fixture: true });
    }
    if (control.action === "burst") for (let i = 0; i < control.count; i++) hint();
    if (control.action === "disconnect") for (const ws of sockets) ws.close(1012, "Fixture reconnect scenario");
    if (control.action === "add-reply" || control.action === "stale-revision") {
      if (mailOutage) throw new HttpError(409, "Restore mail before adding a reply");
      const previous = await loadMailThreadDetail(directory, "inbox", "review");
      const id = `fixture-reply-${++replyNumber}`;
      await writeThreadFixture(directory, [{ ...THREADED_MAIL_FIXTURE[1]!, id,
        subject: `API follow-up ${replyNumber}: new replies remain unselected`,
        body: "This arrived after the branch selection. Reload before acting; do not silently select new members.",
        timestamp: new Date(Date.parse(fixtures.timestamp) + replyNumber * 60_000).toISOString(),
        headers: { "Message-ID": `<${id}@example.test>`, "X-Coleo-Thread-Id": "review",
          "In-Reply-To": "<review-api@example.test>", References: "<review-root@example.test> <review-api@example.test>" },
      }]);
      const current = await loadMailThreadDetail(directory, "inbox", "review");
      broadcast("mail", "mail.received", { messageId: id, threadId: "review" });
      return c.json({ ok: true, action: control.action, threadId: "review", messageId: id,
        previousRevision: previous!.thread.revision, revision: current!.thread.revision,
        staleAction: { mailbox: "inbox", revision: previous!.thread.revision,
          memberIds: ["message:<review-api@example.test>"], action: "read" }, expectedStatus: 409 });
    }
    return c.json({ ok: true, ...control });
  });
  app.route("/api/workbench/named-views", createWorkbenchNamedViewRoutes());
  // The route's production loader already exposes dependency injection; supply an empty retained store
  // rather than connecting this local fixture to the developer's JetStream.
  app.get("/api/workbench/inbox", async (c, next) => {
    const query = c.req.query("query");
    if (query === undefined) return next();
    return c.json(await loadMessagingCollection(db, directory, parseMessagingRequest(query), c.req.query("cursor"),
      { store, now: () => new Date(fixtures.timestamp) }));
  });
  app.route("/api/workbench/inbox", createWorkbenchInboxRoutes({ coleoDir: directory,
    referenceDependencies: { store } }));
  app.route("/api/workbench/attention", createWorkbenchAttentionRoutes());
  app.use("/api/mail/*", async (c, next) => {
    if (/\/mail\/(send|gateway)(\/|$)/.test(c.req.path) || c.req.path.endsWith("/track")) {
      throw new HttpError(405, "External delivery and Brain tracking are outside the fixture contract");
    }
    await next();
  });
  app.route("/api/mail", createMailRoutes({ coleoDir: directory }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? Number(process.env.PORT ?? 8091),
    fetch(request, server) {
      if (new URL(request.url).pathname === "/ws") {
        if (server.upgrade(request, { data: { authenticated: false, subscriptions: new Set(), lastPing: Date.now() } })) return;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      return app.fetch(request);
    },
    websocket: { ...handlers, open(ws: Socket) { sockets.add(ws); handlers.open(ws); },
      close(ws: Socket) { sockets.delete(ws); handlers.close(ws); } },
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets) if (Date.now() - ws.data.lastPing > 60_000) ws.close();
  }, 30_000);
  let stopped = false;
  return { server, directory, async stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    for (const ws of sockets) ws.terminate();
    // Bun 1.3.14 can leave pendingWebSockets nonzero after every close callback;
    // its stop promise then never settles. Drain our handlers, not that counter.
    void server.stop(true);
    server.unref();
    await pending;
    db.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

if (import.meta.main) {
  const fixture = await startBakeoffServer();
  console.log(`Terminal bake-off API: http://127.0.0.1:${fixture.server.port} (WS /ws)`);
  console.log(`Temporary storage: ${fixture.directory}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => { await fixture.stop(); process.exit(0); });
}
