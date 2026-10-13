/**
 * Test Timing Utilities
 * 
 * Timing helpers for tracking test performance.
 */

import type { TimingHelper } from "./types";

export function createTimingHelper(): TimingHelper {
  const marks: Record<string, number> = {};
  const startTime = Date.now();
  marks["_start"] = startTime;

  return {
    mark: (name: string) => {
      marks[name] = Date.now();
    },
    duration: (from?: string, to?: string) => {
      const fromTime = from ? (marks[from] ?? startTime) : startTime;
      const toTime = to ? (marks[to] ?? Date.now()) : Date.now();
      return toTime - fromTime;
    },
    all: () => {
      const result: Record<string, number> = {};
      for (const [name, time] of Object.entries(marks)) {
        if (name !== "_start") {
          result[name] = time - startTime;
        }
      }
      return result;
    },
  };
}
