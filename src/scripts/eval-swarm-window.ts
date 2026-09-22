#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { SwarmEvaluator } from "../brain/swarm/evaluator";
import { executionBlock } from "../brain/swarm/runner";
import type { SwarmSnapshot } from "../brain/swarm/types";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  snapshot: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
} });
if (values.help || !values.snapshot) {
  console.log("Usage: bun run src/scripts/eval-swarm-window.ts --snapshot path.json [--out directory]\nEvaluates one saved swarm snapshot through JEV. Never executes proposals or contacts the Coleo API.");
  if (!values.help) process.exitCode = 1;
} else {
  const key = process.env.JEV_API_KEY;
  if (!key) throw new Error("JEV_API_KEY is required");
  const snapshot = await Bun.file(resolve(values.snapshot)).json() as SwarmSnapshot;
  if (!snapshot.window || !Array.isArray(snapshot.entities) || !Array.isArray(snapshot.events)
    || !Array.isArray(snapshot.brainActions) || !Array.isArray(snapshot.evaluations)
    || !Array.isArray(snapshot.discoveries) || !snapshot.coverage) throw new Error("Invalid swarm snapshot");
  const out = resolve(values.out || `test-results/swarm-evaluation/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown): Promise<void> => writeFile(`${out}/${name}`,
    JSON.stringify(value, null, 2).split(key).join("[REDACTED]"), { mode: 0o600 });
  await save("snapshot.json", snapshot);
  const result = await new SwarmEvaluator(key).evaluate(snapshot);
  await save("result.json", { ...result, executionChecks: result.proposals.map((proposal) => ({
    action: proposal.action, targetId: proposal.targetId, block: executionBlock(proposal, snapshot),
  })) });
  console.log(`${result.decisions?.length || 0} decisions, ${result.proposals.length} proposals, ${Math.round(result.elapsedMs)}ms. No actions executed.\n${out}/result.json`);
}
