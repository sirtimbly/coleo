import { describe, expect, it } from "bun:test";

import {
  parseOpenRouterPricingCatalog,
  resolveOpenRouterPricing,
} from "../openrouter-pricing";

describe("OpenRouter pricing", () => {
  const catalog = parseOpenRouterPricingCatalog({
    data: [
      {
        id: "openai/gpt-5.4-mini",
        canonical_slug: "openai/gpt-5.4-mini-20260701",
        pricing: { prompt: "0.0000004", completion: "0.0000016" },
      },
      {
        id: "anthropic/claude-sonnet-4.6",
        pricing: { prompt: "0.000003", completion: "0.000015" },
      },
      {
        id: "invalid/no-pricing",
        pricing: {},
      },
    ],
  }, "2026-07-28T00:00:00.000Z");

  it("converts per-token rates to per-million-token rates", () => {
    expect(catalog.models[0]).toMatchObject({
      id: "openai/gpt-5.4-mini",
    });
    expect(catalog.models[0]?.input).toBeCloseTo(0.4);
    expect(catalog.models[0]?.output).toBeCloseTo(1.6);
    expect(catalog.models).toHaveLength(2);
  });

  it("matches direct provider IDs exactly", () => {
    const pricing = resolveOpenRouterPricing(catalog, "openai", "gpt-5.4-mini");
    expect(pricing).toMatchObject({
      source: "openrouter",
      estimated: true,
      matchedModel: "openai/gpt-5.4-mini",
    });
    expect(pricing?.input).toBeCloseTo(0.4);
    expect(pricing?.output).toBeCloseTo(1.6);
  });

  it("matches owner-qualified models exposed by the OpenRouter provider", () => {
    expect(resolveOpenRouterPricing(catalog, "openrouter", "anthropic/claude-sonnet-4.6")).toMatchObject({
      input: 3,
      output: 15,
      matchedModel: "anthropic/claude-sonnet-4.6",
    });
  });

  it("uses curated family ownership for market proxy providers", () => {
    expect(resolveOpenRouterPricing(catalog, "github-copilot", "claude-sonnet-4.6")).toMatchObject({
      input: 3,
      output: 15,
      matchedModel: "anthropic/claude-sonnet-4.6",
    });
  });

  it("does not use fuzzy names for unknown models", () => {
    expect(resolveOpenRouterPricing(catalog, "opencode", "gpt-5.4-mini-fast")).toBeUndefined();
    expect(resolveOpenRouterPricing(catalog, "custom", "claude-sonnet-4.6")).toBeUndefined();
  });
});
