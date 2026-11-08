import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { OpenCode } from "@opencode/client";
import { existsSync } from "node:fs";
import * as startup from "../opencode-v2-server";
import { ModelCheckError } from "../model-check-error";
import { verifySpawnModel } from "../model-preflight";

const restore: Array<() => void> = [];
afterEach(() => { for (const fn of restore.splice(0)) fn(); });

function mockProbe(error?: string, text = "OK") {
  let closed = false;
  let directory = "";
  let created: Record<string, unknown> = {};
  const paths: string[] = [];
  const http = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(`${request.method} ${path}`);
    if (path.endsWith("/wait") || request.method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/api/model") return Response.json({ data: [{ providerID: "opencode", id: "working-model", enabled: true }] });
    if (path === "/api/session" && request.method === "POST") {
      created = await request.json() as Record<string, unknown>;
      return Response.json({ data: { id: "probe" } });
    }
    if (path === "/api/session/probe/message") return Response.json({ data: [{ id: "message", type: "assistant", time: { created: 1, completed: 2 },
      content: [{ type: "text", text }], ...(error ? { error: { type: "api", message: error } } : {}) }], cursor: {} });
    return Response.json({ data: {} });
  } });
  const mock = spyOn(startup, "startModelCheckServer").mockImplementation(async path => {
    directory = path;
    return { client: OpenCode.make({ baseUrl: http.url.origin }), close: async () => { closed = true; } };
  });
  restore.push(() => mock.mockRestore(), () => { void http.stop(true); });
  return { inspect: () => ({ closed, directory, created, paths }) };
}

describe("native V2 model preflight", () => {
  it("checks generation and cleans only its temporary session and directory", async () => {
    const probe = mockProbe();
    await verifySpawnModel("opencode-api", "opencode", "working-model");
    const state = probe.inspect();
    expect(state.created).toMatchObject({ agent: "build", model: { providerID: "opencode", id: "working-model" },
      permissions: [{ action: "*", resource: "*", effect: "ask" }] });
    expect(state.paths).toContain("POST /api/session/probe/prompt");
    expect(state.paths).toContain("POST /api/session/probe/interrupt");
    expect(state.paths).toContain("DELETE /api/session/probe");
    expect(state.closed).toBe(true);
    expect(existsSync(state.directory)).toBe(false);
  });
  it("rejects a model absent from the native catalog before creating a session", async () => {
    const probe = mockProbe();
    await expect(verifySpawnModel("opencode-api", "opencode", "missing-model")).rejects.toThrow("not enabled");
    expect(probe.inspect().created).toEqual({});
    expect(probe.inspect().closed).toBe(true);
  });
  it("surfaces expired provider keys from successful HTTP message responses", async () => {
    const probe = mockProbe("This API key has expired");
    await expect(verifySpawnModel("opencode-api", "opencode", "working-model")).rejects.toThrow("This API key has expired");
    expect(probe.inspect().closed).toBe(true);
  });
  it("does not accept an empty response as proof of model access", async () => {
    mockProbe(undefined, "");
    await expect(verifySpawnModel("opencode-api", "opencode", "working-model")).rejects.toThrow("did not return a text response");
  });
  it("does not mislabel a startup failure as a provider-login problem", async () => {
    const mock = spyOn(startup, "startModelCheckServer").mockRejectedValue(new Error("OpenCode V2 could not start"));
    restore.push(() => mock.mockRestore());
    try { await verifySpawnModel("opencode-api", "opencode", "working-model"); throw new Error("Expected failure"); }
    catch (error) { expect(error).not.toBeInstanceOf(ModelCheckError); expect(String(error)).toContain("could not start"); }
  });
});
