import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { Hono } from "hono";
import { tmpdir } from "os";
import { join } from "path";

import {
  createOpenCodeRoutes,
  refreshOpenCodeProvidersCache,
} from "../routes/opencode";
import { setArmClient } from "../arm-client-registry";
import type { ArmClient } from "../../nats/arm-client";

function createFetchMock(
  impl: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  const mock = Object.assign(impl, { preconnect: () => {} });
  return mock as typeof fetch;
}

describe("opencode providers API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;
  let tempDir: string;
  let originalColeoDir: string | undefined;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    db = new Database(":memory:");
    tempDir = await mkdtemp(join(tmpdir(), "coleo-opencode-test-"));
    originalColeoDir = process.env.COLEO_DIR;
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    originalFetch = globalThis.fetch;
    process.env.COLEO_DIR = tempDir;
    process.env.HOME = tempDir;

    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/opencode", createOpenCodeRoutes());
  });

  afterEach(async () => {
    setArmClient(null);
    db.close();
    globalThis.fetch = originalFetch;
    if (originalColeoDir === undefined) {
      delete process.env.COLEO_DIR;
    } else {
      process.env.COLEO_DIR = originalColeoDir;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("refreshes the cache from the local opencode CLI and serves it from /providers", async () => {
    await mkdir(join(tempDir, ".local", "share", "opencode"), { recursive: true });
    await Bun.write(
      join(tempDir, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        opencode: { type: "api", key: "test" },
        "github-copilot": { type: "api", key: "test" },
      }),
    );

    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const scriptPath = join(binDir, "opencode");
    await Bun.write(
      scriptPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"models\" ]; then",
        "  printf '%s\\n' 'opencode/gpt-5.1-codex-mini' 'opencode/claude-opus-4' 'github-copilot/gpt-5.1-codex' 'perplexity/sonar'",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    await chmod(scriptPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath || ""}`;

    const cache = await refreshOpenCodeProvidersCache();
    expect(cache).not.toBeNull();
    expect(cache?.connected).toContain("github-copilot");
    expect(cache?.connected).toContain("opencode");
    expect(cache?.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["github-copilot", "opencode"]),
    );
    expect(cache?.providers.map((provider) => provider.id)).not.toContain("openai");
    expect(
      cache?.providers.find((provider) => provider.id === "opencode")?.models.map((model) => model.id),
    ).toEqual(["claude-opus-4", "gpt-5.1-codex-mini"]);

    globalThis.fetch = createFetchMock(async () => {
      throw new Error("network should not be used");
    });

    const response = await app.request("http://coleo.test/api/opencode/providers");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      providers: Array<{ id: string; models: Array<{ id: string }> }>;
      connected: string[];
      cached: boolean;
      cachedAt: string;
      source: string;
    };

    expect(body.cached).toBe(true);
    expect(body.source).toBe("cache");
    expect(body.connected).toContain("github-copilot");
    expect(body.connected).toContain("opencode");
    expect(body.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["github-copilot", "opencode"]),
    );

    const cachePath = join(tempDir, "cache", "opencode-models.json");
    const cacheContents = JSON.parse(await readFile(cachePath, "utf8")) as {
      providers: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    expect(cacheContents.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["github-copilot", "opencode"]),
    );
  });

  it("returns an empty provider list when no cache exists yet", async () => {
    await mkdir(join(tempDir, ".local", "share", "opencode"), { recursive: true });
    await Bun.write(
      join(tempDir, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        opencode: { type: "api", key: "test" },
      }),
    );

    globalThis.fetch = createFetchMock(async () => {
      throw new Error("network should not be used");
    });

    const response = await app.request("http://coleo.test/api/opencode/providers");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      providers: Array<{ id: string }>;
      connected: string[];
      cached: boolean;
      source: string;
      message: string;
    };

    expect(body.providers).toEqual([]);
    expect(body.connected).toContain("opencode");
    expect(body.cached).toBe(false);
    expect(body.source).toBe("fallback");
    expect(body.message).toContain("No cached OpenCode model catalog yet");
  });

  it("lists providers and saves API keys on the selected arm host", async () => {
    let savedProviderId = "";
    let savedApiKey = "";
    const providers = [{
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-5", name: "gpt-5" }],
      connected: false,
      authMethod: "api-key" as const,
    }];
    const mockArmClient = {
      getAgent: (agentId: string) => agentId === "reef-1"
        ? { capabilities: ["opencode-api", "opencode-provider-auth"] }
        : undefined,
      getOpenCodeProviders: async () => ({
        requestId: "list-1",
        success: true,
        data: { providers },
      }),
      setOpenCodeApiKey: async (_agentId: string, providerId: string, apiKey: string) => {
        savedProviderId = providerId;
        savedApiKey = apiKey;
        return {
          requestId: "save-1",
          success: true,
          data: { providers: [{ ...providers[0]!, connected: true }] },
        };
      },
    };
    setArmClient(mockArmClient as unknown as ArmClient);

    const listResponse = await app.request(
      "http://coleo.test/api/opencode/agents/reef-1/providers",
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ providers });

    const saveResponse = await app.request(
      "http://coleo.test/api/opencode/agents/reef-1/providers/openai/api-key",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-secret" }),
      },
    );
    expect(saveResponse.status).toBe(200);
    expect(savedProviderId).toBe("openai");
    expect(savedApiKey).toBe("sk-secret");
    expect(JSON.stringify(await saveResponse.json())).not.toContain("sk-secret");
  });
});
