import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as sdk from "@opencode-ai/sdk/v2";
import { existsSync } from "node:fs";
import { ModelCheckError } from "../model-check-error";
import { verifySpawnModel } from "../model-preflight";

const restore: Array<() => void> = [];
afterEach(() => { for (const fn of restore.splice(0)) fn(); });

function mockProbe(result: unknown, providers: Array<{ id: string; models: Record<string, object> }> = [{ id: "openai", models: { "working-model": {}, "unavailable-model": {}, model: {} } }]) {
  let closed = false;
  let deleted = false;
  let aborted = false;
  let permissions: unknown;
  let directory = "";
  let prompt: unknown;
  let configuration: unknown;
  const server = spyOn(sdk, "createOpencodeServer").mockImplementation(async (options) => {
    configuration = options?.config;
    return { url: "http://localhost:1", close() { closed = true; } };
  });
  const client = spyOn(sdk, "createOpencodeClient").mockReturnValue({
    provider: { list: async () => ({ data: { all: providers, connected: providers.map((entry) => entry.id) } }) },
    session: {
      create: async (options: { directory: string; permission: unknown }) => {
        directory = options.directory;
        permissions = options.permission;
        return { data: { id: "probe" } };
      },
      prompt: async (options: unknown) => { prompt = options; return result; },
      abort: async () => { aborted = true; },
      delete: async () => { deleted = true; },
    },
  } as unknown as sdk.OpencodeClient);
  restore.push(() => server.mockRestore(), () => client.mockRestore());
  return { inspect: () => ({ closed, deleted, aborted, directory, prompt, configuration, permissions }) };
}

describe("spawn model access check", () => {
  it("explains a removed provider and suggests a connected provider with the same model", async () => {
    const probe = mockProbe({}, [{ id: "kimi-code-plan-global", models: { "kimi-for-coding": {} } }]);
    await expect(verifySpawnModel("opencode-api", "kimi-for-coding", "kimi-for-coding"))
      .rejects.toThrow("Available selections for this model: kimi-code-plan-global/kimi-for-coding");
    expect(probe.inspect().prompt).toBeUndefined();
    expect(probe.inspect().closed).toBe(true);
  });

  it("explains a model missing from the current provider catalog", async () => {
    const probe = mockProbe({});
    await expect(verifySpawnModel("opencode-api", "openai", "removed-model"))
      .rejects.toThrow('Model "removed-model" is not available');
    expect(probe.inspect().prompt).toBeUndefined();
    expect(probe.inspect().closed).toBe(true);
  });
  it("checks native generation without approving tools, then aborts and cleans up", async () => {
    const probe = mockProbe({ data: { info: {}, parts: [{ type: "text", text: "OK" }] } });
    await verifySpawnModel("opencode", "openai", "working-model");
    const state = probe.inspect();
    expect(state.prompt).toMatchObject({
      model: { providerID: "openai", modelID: "working-model" }, agent: "build",
    });
    expect(state.prompt).not.toHaveProperty("tools");
    expect(state.prompt).not.toHaveProperty("system");
    expect(state.configuration).not.toHaveProperty("agent");
    expect(state.configuration).toHaveProperty("permission", "ask");
    expect(state.permissions).toEqual([{ permission: "*", pattern: "*", action: "ask" }]);
    expect(state.aborted).toBe(true);
    expect(state.configuration).toMatchObject({ mcp: { coleo: { enabled: false } } });
    expect(state.closed).toBe(true);
    expect(state.deleted).toBe(true);
    expect(existsSync(state.directory)).toBe(false);
  });

  it("rejects provider errors inside successful HTTP responses and cleans up", async () => {
    const probe = mockProbe({ data: { info: { error: { name: "APIError", data: { message: "Model is not supported for this account" } } }, parts: [] } });
    await expect(verifySpawnModel("opencode-api", "openai", "unavailable-model"))
      .rejects.toBeInstanceOf(ModelCheckError);
    expect(probe.inspect().closed).toBe(true);
    expect(probe.inspect().deleted).toBe(true);
    expect(existsSync(probe.inspect().directory)).toBe(false);
  });

  it("does not accept an empty response as proof of model access", async () => {
    mockProbe({ data: { info: {}, parts: [] } });
    await expect(verifySpawnModel("opencode-tui", "openai", "model"))
      .rejects.toThrow("did not return a text response");
  });
});
