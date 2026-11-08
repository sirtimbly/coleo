import { describe, expect, it } from "bun:test";
import { createOpencodeClient, openCodeHeaders } from "../opencode-v2-client";
import { normalizeV2Event } from "../opencode-v2-events";

describe("OpenCode V2 boundary", () => {
  it("authenticates prompts and translates model, permission, and form requests", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const headers = openCodeHeaders({ OPENCODE_PASSWORD: "test-private-password" });
    const server = Bun.serve({ port: 0, async fetch(request) {
      expect(request.headers.get("Authorization")).toBe(headers.Authorization!);
      const path = new URL(request.url).pathname;
      requests.push({ path, body: await request.json() });
      if (path.endsWith("/prompt")) return Response.json({ data: {} });
      return new Response(null, { status: 204 });
    } });
    try {
      const client = createOpencodeClient({ baseUrl: server.url.origin, headers });
      await client.session.promptAsync({ path: { id: "test" }, body: {
        model: { providerID: "provider", modelID: "model" }, parts: [{ type: "text", text: "Hello" }],
      } });
      await client.postSessionIdPermissionsPermissionId({ path: { id: "test", permissionID: "request" }, body: { response: "once" } });
      await client.native.session.form.reply({ sessionID: "test", formID: "form", answer: { choice: "yes" } });
      expect(requests).toEqual([
        { path: "/api/session/test/model", body: { model: { providerID: "provider", id: "model" } } },
        { path: "/api/session/test/prompt", body: { text: "Hello", files: [] } },
        { path: "/api/session/test/permission/request/reply", body: { decision: "once" } },
        { path: "/api/session/test/form/form/reply", body: { answer: { choice: "yes" } } },
      ]);
    } finally { await server.stop(true); }
  });

  it("accumulates text per message and releases completed stream buffers", () => {
    const text = new Map<string, string>();
    const data = { sessionID: "session", assistantMessageID: "message", ordinal: 0 };
    normalizeV2Event({ type: "session.text.delta", data: { ...data, delta: "Hel" } }, text);
    const event = normalizeV2Event({ type: "session.text.delta", data: { ...data, delta: "lo" } }, text);
    expect(event).toMatchObject({ type: "message.part.updated", properties: { part: { type: "text", text: "Hello" } } });
    normalizeV2Event({ type: "session.text.ended", data }, text);
    expect(text.size).toBe(0);
    expect(normalizeV2Event({ type: "session.execution.failed", data: { ...data, error: { message: "expired" } } }, text))
      .toMatchObject({ type: "session.error", properties: { error: { message: "expired" } } });
  });
});
