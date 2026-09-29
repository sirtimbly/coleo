#!/usr/bin/env bun
/**
 * Classification regression command.
 *
 * Compares a bake-off run directory against the committed baseline
 * (src/scripts/classification-bakeoff/BASELINE.json) using the same
 * scoring as the run's own report (scoreDecision). Advisory only:
 * results never change production behavior (ADR-023 §11).
 *
 * Usage: bun run eval:regression --run <bakeoff-run-dir> [--baseline <path>]
 * Exit codes: 0 = no regression, 1 = regression detected,
 * 2 = usage/runner failure, 3 = run not comparable (corpus mismatch).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { SCENARIOS } from "./classification-bakeoff/fixtures";
import { scoreDecision } from "./classification-bakeoff/classifiers";
import type { Attempt } from "./classification-bakeoff/report";

interface BaselineAccuracy { correct: number; total: number }
interface Baseline {
  provenance: string;
  corpusFingerprint: string;
  models: { current: string; jev: string };
  accuracy: Record<"arm" | "human", Record<"current" | "jev", BaselineAccuracy>>;
}

export interface RunData { metadata: { fingerprint?: string; corpus?: string }; attempts: Attempt[] }
export interface ChannelComparison {
  kind: "arm" | "human";
  backend: "current" | "jev";
  run: BaselineAccuracy;
  baseline: BaselineAccuracy;
  regression: boolean;
}

export async function loadRun(runDir: string): Promise<RunData> {
  const raw = await readFile(resolve(runDir, "results.json"), "utf8");
  const parsed = JSON.parse(raw) as RunData;
  if (!parsed.metadata || !Array.isArray(parsed.attempts)) {
    throw new Error(`${runDir}/results.json is not a bake-off run (missing metadata/attempts)`);
  }
  return parsed;
}

export function compareRun(run: RunData, baseline: Baseline): { comparable: boolean; comparisons: ChannelComparison[] } {
  const byId = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));
  const comparisons: ChannelComparison[] = [];
  for (const kind of ["arm", "human"] as const) {
    for (const backend of ["current", "jev"] as const) {
      const rows = run.attempts.filter((attempt) => attempt.kind === kind && attempt.backend === backend);
      const correct = rows.filter((attempt) => scoreDecision(byId.get(attempt.caseId)!, attempt.decision).primary).length;
      const expected = baseline.accuracy[kind]?.[backend] ?? { correct: 0, total: 0 };
      // Compare accuracy RATIOS so runs with different repeat counts stay
      // comparable (the baseline records two repetitions per case).
      const runRatio = rows.length ? correct / rows.length : null;
      const baselineRatio = expected.total ? expected.correct / expected.total : null;
      comparisons.push({
        kind, backend,
        run: { correct, total: rows.length },
        baseline: expected,
        // Regression = the production classifier lost accuracy on a fixed
        // corpus. JEV deltas are informational unless the baseline is missing.
        regression: backend === "current" && runRatio !== null && baselineRatio !== null && runRatio < baselineRatio,
      });
    }
  }
  // A run without a corpus fingerprint cannot be proven to use the baseline's
  // fixed evaluation set (ADR-023 §2) — treat as incomparable rather than guess.
  const comparable = run.metadata.fingerprint !== undefined && run.metadata.fingerprint === baseline.corpusFingerprint;
  return { comparable, comparisons };
}

export function renderComparison(comparisons: ChannelComparison[], comparable: boolean, baseline: Baseline, run: RunData): string {
  const lines = [
    "# Classification regression comparison",
    "",
    `Corpus match: ${comparable ? "yes" : "NO"} (run ${run.metadata.fingerprint ?? "unknown"} vs baseline ${baseline.corpusFingerprint})`,
    `Baseline models: current ${baseline.models.current}, JEV ${baseline.models.jev}`,
    "",
    "| Channel | Backend | Run | Baseline | Verdict |",
    "|---|---|---:|---:|---|",
  ];
  for (const comparison of comparisons) {
    let verdict = "ok";
    if (comparison.run.total === 0) verdict = "no data";
    else if (comparison.regression) verdict = "REGRESSION";
    else if (comparison.backend === "jev" && comparison.run.correct !== comparison.baseline.correct) verdict = "changed (informational)";
    lines.push(`| ${comparison.kind} | ${comparison.backend} | ${comparison.run.correct}/${comparison.run.total} | ${comparison.baseline.correct}/${comparison.baseline.total} | ${verdict} |`);
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    help: { type: "boolean" }, run: { type: "string" }, baseline: { type: "string" },
  } });
  if (values.help) {
    console.log("Usage: bun run eval:regression --run <bakeoff-run-dir> [--baseline <path>]\nExit codes: 0 no regression, 1 regression, 2 failure, 3 incomparable corpus.");
    return;
  }
  if (!values.run) {
    console.error("Error: --run <bakeoff-run-dir> is required (the output directory of a bake-off run).");
    process.exit(2);
  }
  const baselinePath = resolve(values.baseline || "src/scripts/classification-bakeoff/BASELINE.json");
  let baseline: Baseline;
  let run: RunData;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;
    run = await loadRun(values.run);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  const { comparable, comparisons } = compareRun(run, baseline);
  console.log(renderComparison(comparisons, comparable, baseline, run));
  if (!comparable) process.exit(3);
  if (comparisons.some((comparison) => comparison.regression)) process.exit(1);
}

if (import.meta.main) {
  await main();
}
