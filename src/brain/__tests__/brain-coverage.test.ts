import { describe, it, expect } from "bun:test";
import { Brain } from "../brain";
import { join } from "path";

// Minimal smoke test to ensure brain.ts is included in coverage.
describe("Brain coverage smoke", () => {
  it("constructs and stops without throwing", () => {
    const testDir = join("/tmp", `coleo-brain-coverage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
    });

    // Should be safe to call stop without running the loop.
    brain.stop();

    expect(brain).toBeTruthy();
  });
});
