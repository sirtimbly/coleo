import { describe, expect, it } from "bun:test";
import {
  COST_POLL_INTERVAL_MS,
  COST_RATE_WINDOW_MS,
  COST_WINDOW_MS,
  appendCostSample,
  buildCostSamplesFromMessages,
  computeCostRatePerHour,
  parseMessageTimestamp,
  type CostSample,
} from "../src/components/arm-cost-usage-helpers";

describe("ArmCostUsageChart helpers", () => {
  it("exposes cost constants matching the spec cadence", () => {
    expect(COST_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(COST_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(COST_POLL_INTERVAL_MS).toBeLessThanOrEqual(15_000);
    expect(COST_RATE_WINDOW_MS).toBeGreaterThan(0);
  });

  it("parses numeric, ISO string, and object message timestamps", () => {
    expect(parseMessageTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp("1700000000")).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp("2026-07-27T21:00:00Z")).toBeGreaterThan(0);
    expect(parseMessageTimestamp({ completed: 1_700_000_000 } as never)).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp(undefined)).toBeNull();
    expect(parseMessageTimestamp(null)).toBeNull();
  });

  it("builds cumulative-cost samples from messages, oldest first", () => {
    const messages = [
      { info: { id: "m1", cost: 0.001, time: 1_700_000_000_000 } },
      { info: { id: "m2", cost: 0.002, time: 1_700_000_001_000 } },
      { info: { id: "m3", cost: 0.004, time: 1_700_000_002_000 } },
    ];
    const samples = buildCostSamplesFromMessages(messages);
    expect(samples).toHaveLength(3);
    expect(samples[0]!.cumulativeCost).toBeCloseTo(0.001, 6);
    expect(samples[1]!.cumulativeCost).toBeCloseTo(0.003, 6);
    expect(samples[2]!.cumulativeCost).toBeCloseTo(0.007, 6);
  });

  it("skips messages with zero or undefined cost", () => {
    const messages = [
      { info: { id: "m1", cost: 0, time: 1_700_000_000_000 } },
      { info: { id: "m2", cost: undefined, time: 1_700_000_001_000 } },
      { info: { id: "m3", cost: 0.003, time: 1_700_000_002_000 } },
    ];
    const samples = buildCostSamplesFromMessages(messages);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.cumulativeCost).toBeCloseTo(0.003, 6);
  });

  it("appends new samples and dedups near-duplicates", () => {
    const now = Date.now();
    let samples: CostSample[] = [];
    samples = appendCostSample(samples, {
      timestamp: now,
      cumulativeCost: 0.1,
      messageCost: 0.1,
      inputTokens: 10,
      outputTokens: 5,
    });
    samples = appendCostSample(samples, {
      timestamp: now + 50,
      cumulativeCost: 0.1,
      messageCost: 0.1,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(samples).toHaveLength(1);
  });

  it("prunes samples older than the 30-minute window", () => {
    const now = Date.now();
    const oldSample: CostSample = {
      timestamp: now - COST_WINDOW_MS - 60_000,
      cumulativeCost: 0.05,
      messageCost: 0.05,
      inputTokens: 1,
      outputTokens: 1,
    };
    const freshSample: CostSample = {
      timestamp: now,
      cumulativeCost: 0.2,
      messageCost: 0.2,
      inputTokens: 2,
      outputTokens: 1,
    };
    let samples: CostSample[] = [];
    samples = appendCostSample(samples, oldSample);
    samples = appendCostSample(samples, freshSample);
    expect(samples.some((s) => s.cumulativeCost === 0.05)).toBe(false);
    expect(samples.some((s) => s.cumulativeCost === 0.2)).toBe(true);
  });

  it("computes a positive cost rate when spend is increasing", () => {
    const now = Date.now();
    const samples: CostSample[] = [
      { timestamp: now - 60_000, cumulativeCost: 0.05, messageCost: 0.05, inputTokens: 1, outputTokens: 0 },
      { timestamp: now, cumulativeCost: 0.25, messageCost: 0.2, inputTokens: 10, outputTokens: 5 },
    ];
    const rate = computeCostRatePerHour(samples, now);
    expect(rate).toBeGreaterThan(0);
  });

  it("returns zero rate when there are fewer than two qualifying samples", () => {
    const now = Date.now();
    expect(computeCostRatePerHour([], now)).toBe(0);
    expect(
      computeCostRatePerHour(
        [{ timestamp: now, cumulativeCost: 0.1, messageCost: 0.1, inputTokens: 1, outputTokens: 1 }],
        now,
      ),
    ).toBe(0);
  });

  it("returns zero rate when no samples are within the recent window", () => {
    const now = Date.now();
    const samples: CostSample[] = [
      {
        timestamp: now - COST_RATE_WINDOW_MS - 60_000,
        cumulativeCost: 0.05,
        messageCost: 0.05,
        inputTokens: 1,
        outputTokens: 0,
      },
      {
        timestamp: now - COST_RATE_WINDOW_MS - 30_000,
        cumulativeCost: 0.25,
        messageCost: 0.2,
        inputTokens: 10,
        outputTokens: 5,
      },
    ];
    expect(computeCostRatePerHour(samples, now)).toBe(0);
  });
});
