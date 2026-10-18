import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  fetchProviders,
  resolveModel,
  isModelAvailable,
  getAvailableModelsByCost,
} from "../model-resolver";

const providersFixture = {
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      models: [
        { id: "gpt-4o", name: "GPT-4o", pricing: { input: 2.5, output: 10 } },
        { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      models: [
        { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
        { id: "claude-opus-4", name: "Claude Opus 4", pricing: { input: 15, output: 75 } },
      ],
    },
  ],
  connected: ["openai"],
};

const createResponse = (body: unknown, ok = true) => {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => body,
  } as Response;
};

const createFetchMock = (impl: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch => {
  const mock = Object.assign(impl, { preconnect: () => {} });
  return mock as typeof fetch;
};

describe("model-resolver", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchProviders returns parsed providers", async () => {
    globalThis.fetch = createFetchMock(async () => createResponse(providersFixture));

    const result = await fetchProviders("http://example.test");
    expect(result.providers.length).toBe(2);
    expect(result.connected).toEqual(["openai"]);
  });

  it("fetchProviders returns error payload on non-ok response", async () => {
    globalThis.fetch = createFetchMock(async () => createResponse({}, false));

    const result = await fetchProviders("http://example.test");
    expect(result.providers.length).toBe(0);
    expect(result.connected.length).toBe(0);
    expect(result.error).toContain("API returned 500");
  });

  it("resolveModel returns exact match when available", async () => {
    globalThis.fetch = createFetchMock(async () => createResponse(providersFixture));

    const resolved = await resolveModel("openai", "gpt-4o", "http://example.test");
    expect(resolved.fallback).toBe(false);
    expect(resolved.providerId).toBe("openai");
    expect(resolved.modelId).toBe("gpt-4o");
    expect(resolved.providerName).toBe("OpenAI");
  });

  it("resolveModel falls back to cheapest in provider", async () => {
    globalThis.fetch = createFetchMock(async () => createResponse(providersFixture));

    const resolved = await resolveModel("openai", "does-not-exist", "http://example.test");
    expect(resolved.fallback).toBe(true);
    expect(resolved.providerId).toBe("openai");
    // gpt-4o-mini should be cheaper than gpt-4o
    expect(resolved.modelId).toBe("gpt-4o-mini");
    expect(resolved.fallbackReason).toContain("cheapest alternative");
  });

  it("resolveModel finds same model in another provider", async () => {
    const fixture = {
      ...providersFixture,
      providers: [
        providersFixture.providers[1],
      ],
      connected: ["anthropic"],
    };
    globalThis.fetch = createFetchMock(async () => createResponse(fixture));

    const resolved = await resolveModel("openai", "claude-3-5-sonnet", "http://example.test");
    expect(resolved.fallback).toBe(true);
    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-3-5-sonnet");
  });

  it("resolveModel falls back to first available model", async () => {
    const fixture = {
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: [{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" }],
        },
      ],
      connected: [],
    };
    globalThis.fetch = createFetchMock(async () => createResponse(fixture));

    const resolved = await resolveModel("openai", "unknown", "http://example.test");
    expect(resolved.fallback).toBe(true);
    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-3-5-sonnet");
  });

  it("isModelAvailable returns true only when provider and model exist", async () => {
    globalThis.fetch = createFetchMock(async () => createResponse(providersFixture));

    await expect(isModelAvailable("openai", "gpt-4o", "http://example.test")).resolves.toBe(true);
    await expect(isModelAvailable("openai", "missing", "http://example.test")).resolves.toBe(false);
    await expect(isModelAvailable("missing", "gpt-4o", "http://example.test")).resolves.toBe(false);
  });

  it("getAvailableModelsByCost sorts models by total cost", async () => {
    globalThis.fetch = createFetchMock(async () => createResponse(providersFixture));

    const models = await getAvailableModelsByCost("http://example.test");
    expect(models.length).toBe(4);
    expect(models[0]).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      cost: expect.any(Number),
    });
    expect(models[models.length - 1]).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-4",
      cost: expect.any(Number),
    });
  });
});
