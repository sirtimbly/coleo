import { describe, expect, it } from "bun:test";
import {
  COMPRESSION_THRESHOLD_PCT,
  SAMPLE_INTERVAL_MS,
  SAMPLE_WINDOW_MS,
  appendSample,
  type ContextSample,
} from "../src/components/arm-context-usage-helpers";

describe("ArmContextUsageChart helpers", () => {
  it("exposes the constants that drive the spec", () => {
    expect(SAMPLE_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(SAMPLE_INTERVAL_MS).toBeLessThanOrEqual(15_000);
    expect(SAMPLE_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(COMPRESSION_THRESHOLD_PCT).toBe(0.8);
  });

  it("appends new context samples onto the running time series", () => {
    const now = Date.now();
    const sample: ContextSample = { timestamp: now, used: 1000, budget: 200000 };
    let samples: ContextSample[] = [];
    samples = appendSample(samples, sample);
    samples = appendSample(samples, { timestamp: now + 1000, used: 1200, budget: 200000 });
    expect(samples).toHaveLength(2);
  });

  it("ignores near-duplicate samples within a tiny time window", () => {
    const now = Date.now();
    const sample: ContextSample = { timestamp: now, used: 1000, budget: 200000 };
    let samples: ContextSample[] = [];
    samples = appendSample(samples, sample);
    samples = appendSample(samples, { ...sample, timestamp: now + 50 });
    expect(samples).toHaveLength(1);
  });

  it("drops samples older than the 30-minute window", () => {
    const now = Date.now();
    const oldSample: ContextSample = {
      timestamp: now - SAMPLE_WINDOW_MS - 1000,
      used: 500,
      budget: 200000,
    };
    const newSample: ContextSample = { timestamp: now, used: 1500, budget: 200000 };
    let samples: ContextSample[] = [];
    samples = appendSample(samples, oldSample);
    samples = appendSample(samples, newSample);
    expect(samples.some((s) => s.used === 500)).toBe(false);
    expect(samples.some((s) => s.used === 1500)).toBe(true);
  });
});
