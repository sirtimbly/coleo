import { afterAll, beforeAll, expect, test } from "bun:test";
import { startBakeoffServer } from "./server";

let fixture: Awaited<ReturnType<typeof startBakeoffServer>>;
let base: string;
beforeAll(async () => { fixture = await startBakeoffServer({ port: 0, apiKey: "bakeoff-smoke" }); base = `http://127.0.0.1:${fixture.server.port}`; });
afterAll(async () => { await fixture?.stop(); });
const request = (path: string, body?: unknown, method = body ? "POST" : "GET") => fetch(base + path, {
  method, headers: { "X-API-Key": "bakeoff-smoke", "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const control = (body: unknown) => request("/__test/control", body);

test("real HTTP routes: paging, references, actions, outage, stale revision and reset", async () => {
  expect((await fetch(base + "/api/workbench/named-views/inbox-triage")).status).toBe(401);
  for (const client of ["cli", "tui"]) expect((await request(`/api/workbench/named-views/inbox-triage?client=${client}`)).status).toBe(200);
  const query = { schemaVersion: 1, facet: "messages", limit: 2 };
  const path = `/api/workbench/inbox?query=${encodeURIComponent(JSON.stringify(query))}`;
  const pageResponse = await request(path);
  expect(pageResponse.status).toBe(200);
  const page = await pageResponse.json();
  expect(page.items).toHaveLength(2);
  expect(page.summaries.total).toBe(6);
  expect(page.nextCursor).toBeTruthy();
  const next = await (await request(`${path}&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
  expect(next.items.map((item: { id: string }) => item.id)).not.toContain(page.items[0].id);
  expect((await request("/api/workbench/inbox/references/thread%3Ainbox%3Areview")).status).toBe(200);
  const detail = await (await request("/api/mail/threads/review")).json();
  expect(detail.thread.messageCount).toBe(5);
  const selected = await (await request("/api/mail/threads/review/selection", {
    revision: detail.thread.revision, branchIds: ["message:<review-api@example.test>"],
  })).json();
  expect(selected.memberIds).toHaveLength(2);
  const action = await (await request("/api/mail/threads/review/actions", {
    revision: detail.thread.revision, memberIds: ["message:<review-api@example.test>", "message:<review-terminal@example.test>"], action: "read",
  })).json();
  expect(action.completedMessageIds).toEqual(["review-api"]);
  expect(action.skippedMemberIds).toEqual(["message:<review-terminal@example.test>"]);
  const stale = await (await control({ action: "stale-revision" })).json();
  expect((await request("/api/mail/threads/review/actions", stale.staleAction)).status).toBe(409);
  expect((await control({ action: "source-outage", enabled: true })).status).toBe(200);
  const partial = await (await request(path)).json();
  expect(partial.sources[0].status).toBe("unavailable");
  expect(partial.summaries.complete).toBe(false);
  expect((await request("/api/mail/threads/review")).status).toBe(503);
  await control({ action: "source-outage", enabled: false });
  expect((await request("/api/mail/threads/review")).status).toBe(200);
  expect((await request("/api/workbench/attention/bulk", { itemKeys: ["task:bakeoff-approval"], action: "read" })).status).toBe(200);
  await control({ action: "reset" });
  const restored = await (await request(path)).json();
  expect(restored.items).toEqual(page.items);
  expect(restored.nextCursor).toBe(page.nextCursor);
  for (const [mailbox, count] of [["sent", 3], ["archive", 1]] as const) {
    const result = await (await request(`/api/mail/threads?mailbox=${mailbox}`)).json();
    expect(result.pagination.total).toBe(count);
  }
  const historyPath = `/api/workbench/inbox?query=${encodeURIComponent(JSON.stringify({ facet: "history", search: "no-such-fixture" }))}`;
  const empty = await (await request(historyPath)).json();
  expect(empty.items).toEqual([]);
  expect(empty.summaries.complete).toBe(true);
  await control({ action: "source-outage", source: "events", enabled: true });
  expect((await (await request(historyPath)).json()).summaries.complete).toBe(false);
  await control({ action: "source-outage", source: "events", enabled: false });
  expect((await request("/api/workbench/inbox/references/thread%3Ainbox%3Amissing")).status).toBe(404);
  expect((await request(`${path}&cursor=broken`)).status).toBe(400);
  expect((await control({ action: "burst", count: -1 })).status).toBe(400);
});

test("two simultaneous WS clients: auth, subscriptions, heartbeat, burst and socket-only recovery", async () => {
  async function connect() {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    const wait = async (predicate: (value: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 200; i++) { const found = messages.find(predicate); if (found) return found; await Bun.sleep(5); }
      throw new Error(`Timed out waiting for WS message: ${JSON.stringify(messages)}`);
    };
    ws.send(JSON.stringify({ type: "subscribe", channel: "mail" }));
    expect((await wait((m) => m.type === "error")).error).toBe("Not authenticated");
    ws.send(JSON.stringify({ type: "auth", token: "bakeoff-smoke" }));
    await wait((m) => m.type === "auth" && m.success === false);
    ws.send(JSON.stringify({ type: "auth", apiKey: "bakeoff-smoke" }));
    await wait((m) => m.type === "auth" && m.success === true);
    ws.send(JSON.stringify({ type: "subscribe", channel: "mail" }));
    await wait((m) => m.type === "subscribed");
    ws.send(JSON.stringify({ type: "ping" }));
    await wait((m) => m.type === "pong");
    return { ws, messages, wait };
  }
  const clients = await Promise.all([connect(), connect()]);
  await control({ action: "burst", count: 30 });
  for (const client of clients) {
    await client.wait((m) => m.event === "mail.received");
    expect(client.messages.filter((m) => m.event === "mail.received")).toHaveLength(30);
  }
  const closed = clients.map(({ ws }) => new Promise<number>((resolve) => { ws.onclose = (event) => resolve(event.code); }));
  await control({ action: "disconnect" });
  expect(await Promise.all(closed)).toEqual([1012, 1012]);
  expect((await request("/api/health")).status).toBe(200);
  const reconnected = await connect();
  expect((await request("/api/mail/threads/review")).status).toBe(200);
  const finalClose = new Promise<void>((resolve) => { reconnected.ws.onclose = () => resolve(); });
  reconnected.ws.close();
  await finalClose;
});
