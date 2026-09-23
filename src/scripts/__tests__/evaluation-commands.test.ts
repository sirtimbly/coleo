import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRun, loadRun, renderComparison } from "../evaluation-regression";
import { preflight, validateArtifacts } from "../evaluation-clean-room";
import { SCENARIOS } from "../classification-bakeoff/fixtures";
import type { Attempt } from "../classification-bakeoff/report";
import baselineJson from "../classification-bakeoff/BASELINE.json";

const baseline = baselineJson as typeof baselineJson & {
  accuracy: Record<"arm" | "human", Record<"current" | "jev", { correct: number; total: number }>>;
};
const expectedLabel = (caseId: string) => SCENARIOS.find((scenario) => scenario.id === caseId)!.expected;
const firstCase = (kind: "arm" | "human") => SCENARIOS.find((scenario) => scenario.kind === kind)!.id;

function attempt(partial: Partial<Attempt> & { caseId: string; kind: "arm" | "human"; backend: "current" | "jev" }): Attempt {
  return { repeat: 1, mode: "model", elapsedMs: 100, logs: [], ...partial };
}

/** Correctly labeled attempts for every fixture in a channel, one per case per backend. */
function perfectChannel(kind: "arm" | "human", backend: "current" | "jev"): Attempt[] {
  return SCENARIOS.filter((scenario) => scenario.kind === kind)
    .map((scenario) => attempt({ caseId: scenario.id, kind, backend, decision: { label: scenario.expected } }));
}

function runData(attempts: Attempt[], fingerprint = baseline.corpusFingerprint) {
  return { metadata: { fingerprint, corpus: "synthetic-v1" }, attempts };
}

describe("evaluation regression command", () => {
  it("flags an accuracy drop on the current classifier as a regression", () => {
    const attempts = perfectChannel("arm", "current");
    // Corrupt exactly one current arm decision to dip below the 40/40 baseline.
    attempts[0] = attempt({ caseId: attempts[0]!.caseId, kind: "arm", backend: "current", decision: { label: "not-the-expected-label" } });
    attempts.push(...perfectChannel("human", "current"));
    const { comparable, comparisons } = compareRun(runData(attempts), baseline);
    expect(comparable).toBe(true);
    const armCurrent = comparisons.find((comparison) => comparison.kind === "arm" && comparison.backend === "current")!;
    expect(armCurrent.run.correct).toBe(SCENARIOS.filter((scenario) => scenario.kind === "arm").length - 1);
    expect(armCurrent.regression).toBe(true);
    const humanCurrent = comparisons.find((comparison) => comparison.kind === "human" && comparison.backend === "current")!;
    expect(humanCurrent.regression).toBe(false);
  });

  it("passes when current accuracy meets the baseline", () => {
    const attempts = [
      ...perfectChannel("arm", "current"), ...perfectChannel("human", "current"),
      ...perfectChannel("arm", "jev"), ...perfectChannel("human", "jev"),
    ];
    const { comparable, comparisons } = compareRun(runData(attempts), baseline);
    expect(comparable).toBe(true);
    expect(comparisons.filter((comparison) => comparison.regression)).toHaveLength(0);
    const armCurrent = comparisons.find((comparison) => comparison.kind === "arm" && comparison.backend === "current")!;
    // Single-repetition runs score one decision per fixture (the baseline
    // records two repetitions per case, hence its 40/40).
    expect(armCurrent.run.correct).toBe(SCENARIOS.filter((scenario) => scenario.kind === "arm").length);
  });

  it("marks a corpus fingerprint mismatch as incomparable", () => {
    const attempts: Attempt[] = [attempt({ caseId: firstCase("arm"), kind: "arm", backend: "current", decision: { label: expectedLabel(firstCase("arm")) } })];
    const { comparable } = compareRun(runData(attempts, "deadbeef"), baseline);
    expect(comparable).toBe(false);
    // A run without any fingerprint is likewise incomparable (ADR-023 §2).
    expect(compareRun({ metadata: {}, attempts }, baseline).comparable).toBe(false);
  });

  it("renders a comparison table with the baseline provenance", () => {
    const attempts = perfectChannel("arm", "current");
    const run = runData(attempts);
    const { comparable, comparisons } = compareRun(run, baseline);
    const rendered = renderComparison(comparisons, comparable, baseline, run);
    expect(rendered).toContain("Classification regression comparison");
    expect(rendered).toContain(baseline.corpusFingerprint);
    expect(rendered).toContain("gpt-5.6-luna");
  });

  it("loads a run directory and rejects malformed results.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-regression-test-"));
    try {
      await expect(loadRun(dir)).rejects.toThrow();
      await writeFile(join(dir, "results.json"), JSON.stringify({ nope: true }));
      await expect(loadRun(dir)).rejects.toThrow("not a bake-off run");
      await writeFile(join(dir, "results.json"), JSON.stringify({ metadata: {}, attempts: [] }));
      const loaded = await loadRun(dir);
      expect(loaded.attempts).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("evaluation clean-room command", () => {
  it("fails closed without declared credentials", () => {
    expect(() => preflight({}, undefined)).toThrow("JEV_API_KEY");
    expect(() => preflight({ JEV_API_KEY: "jev" }, undefined)).toThrow("COLEO_BRAIN_API_KEY or OPENAI_API_KEY");
  });

  it("requires an explicit model configuration", () => {
    const env = { JEV_API_KEY: "jev", OPENAI_API_KEY: "current" };
    expect(() => preflight(env, undefined)).toThrow("Explicit model configuration required");
    expect(() => preflight(env, "  ")).toThrow("Explicit model configuration required");
    const result = preflight(env, "gpt-5.6-luna");
    expect(result.model).toBe("gpt-5.6-luna");
    expect(result.env.OPENAI_API_KEY).toBe("current");
    expect(result.env.JEV_API_KEY).toBe("jev");
    // Undeclared environment must not leak into the clean room.
    expect("UNRELATED_LOCAL_VAR" in result.env).toBe(false);
  });

  it("validates the artifact set and rejects database files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-cleanroom-test-"));
    try {
      await expect(validateArtifacts(dir)).rejects.toThrow("missing artifacts");
      await writeFile(join(dir, "inputs.json"), JSON.stringify({ metadata: { fingerprint: "abc123" } }));
      await writeFile(join(dir, "attempts.jsonl"), "one attempt\n");
      await writeFile(join(dir, "results.json"), "{}");
      await writeFile(join(dir, "report.md"), "# report");
      const ok = await validateArtifacts(dir);
      expect(ok.fingerprint).toBe("abc123");
      await writeFile(join(dir, "state.sqlite"), "binary");
      await expect(validateArtifacts(dir)).rejects.toThrow("database files");
      // Subdirectory run output also validates (nested temp run dirs).
      const nested = join(dir, "run");
      await mkdir(nested);
      for (const file of ["inputs.json", "attempts.jsonl", "results.json", "report.md"]) {
        await writeFile(join(nested, file), file === "inputs.json" ? JSON.stringify({ metadata: {} }) : "x");
      }
      expect((await validateArtifacts(nested)).fingerprint).toBeNull();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects an empty attempts log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-cleanroom-empty-"));
    try {
      await writeFile(join(dir, "inputs.json"), JSON.stringify({ metadata: {} }));
      await writeFile(join(dir, "attempts.jsonl"), "");
      await writeFile(join(dir, "results.json"), "{}");
      await writeFile(join(dir, "report.md"), "# report");
      await expect(validateArtifacts(dir)).rejects.toThrow("no attempts");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
