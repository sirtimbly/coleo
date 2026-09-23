#!/usr/bin/env bun
/**
 * Clean-room evaluation command.
 *
 * Generates classification bake-off artifacts from a clean environment:
 * a fresh temporary working directory (no repo-local .coleo/config.toml),
 * env-declared credentials only, artifacts written exclusively to the
 * temp directory. Verifies afterwards that the repository worktree and
 * databases were untouched (ADR-023 §5 redaction, §8 reproducibility;
 * evaluation output is never authoritative state).
 *
 * Usage: bun run eval:clean-room [--repeats 2] [--limit N] [--current-model id]
 * Required env: JEV_API_KEY plus COLEO_BRAIN_API_KEY or OPENAI_API_KEY.
 * Optional env: COLEO_BRAIN_MODEL (explicit model selection, ADR-023 §3).
 */
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface PreflightResult {
  env: Record<string, string>;
  model: string;
}

/** Fail-closed credential/model checks (ADR-023 §3/§6). Exported for tests. */
export function preflight(env: Record<string, string | undefined>, modelOverride?: string): PreflightResult {
  const jevKey = env.JEV_API_KEY?.trim();
  const currentKey = env.COLEO_BRAIN_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  if (!jevKey || !currentKey) {
    throw new Error("Clean-room evaluation requires JEV_API_KEY and COLEO_BRAIN_API_KEY or OPENAI_API_KEY in the environment; refusing undeclared local configuration.");
  }
  const model = modelOverride?.trim() || env.COLEO_BRAIN_MODEL?.trim();
  if (!model) {
    throw new Error("Explicit model configuration required: pass --current-model or set COLEO_BRAIN_MODEL (ADR-023 §3).");
  }
  // Only declared credential/config variables cross into the clean room.
  const clean: Record<string, string> = {};
  for (const name of ["JEV_API_KEY", "COLEO_BRAIN_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "PATH", "HOME"]) {
    if (env[name]) clean[name] = env[name]!;
  }
  return { env: clean, model };
}

/** Verify a run directory contains the full artifact set and no database files. Exported for tests. */
export async function validateArtifacts(runDir: string): Promise<{ fingerprint: string | null; files: string[] }> {
  const required = ["inputs.json", "attempts.jsonl", "results.json", "report.md"];
  const files = await readdir(runDir);
  const missing = required.filter((file) => !files.includes(file));
  if (missing.length) {
    throw new Error(`Run directory ${runDir} is missing artifacts: ${missing.join(", ")}`);
  }
  const databaseFiles = files.filter((file) => /\.(sqlite|sqlite3|db)$/i.test(file));
  if (databaseFiles.length) {
    throw new Error(`Run directory contains database files (evaluation artifacts must not mutate state): ${databaseFiles.join(", ")}`);
  }
  let fingerprint: string | null = null;
  try {
    const { readFile } = await import("node:fs/promises");
    const inputs = JSON.parse(await readFile(join(runDir, "inputs.json"), "utf8")) as { metadata?: { fingerprint?: string } };
    fingerprint = inputs.metadata?.fingerprint ?? null;
  } catch {
    fingerprint = null;
  }
  const { size } = await stat(join(runDir, "attempts.jsonl"));
  if (size === 0) {
    throw new Error("attempts.jsonl is empty; the run recorded no attempts (check credentials/provider reachability).");
  }
  return { fingerprint, files };
}

async function gitStatus(repoRoot: string): Promise<string> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    help: { type: "boolean" }, repeats: { type: "string" }, limit: { type: "string" }, "current-model": { type: "string" },
  } });
  if (values.help) {
    console.log("Usage: bun run eval:clean-room [--repeats 2] [--limit N] [--current-model id]\nRequires JEV_API_KEY + COLEO_BRAIN_API_KEY/OPENAI_API_KEY; artifacts land in a fresh temp directory.");
    return;
  }
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const { env, model } = preflight(process.env, values["current-model"]);
  const room = await mkdtemp(join(tmpdir(), "coleo-clean-room-"));
  const before = await gitStatus(repoRoot);

  const bakeoffArgs = [resolve(repoRoot, "src/scripts/classification-bakeoff.ts"), "--out", room, "--current-model", model,
    ...(values.repeats ? ["--repeats", values.repeats] : []),
    ...(values.limit ? ["--limit", values.limit] : [])];
  console.log(`[clean-room] running bake-off with cwd=${room} (repo config and database excluded)`);
  const proc = Bun.spawn(["bun", "run", ...bakeoffArgs], {
    cwd: room,
    env: { ...env, COLEO_BRAIN_MODEL: model },
    stdout: "inherit", stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`[clean-room] bake-off exited with status ${code}; see output above.`);
    process.exit(code === 2 ? 2 : 1);
  }

  const artifacts = await validateArtifacts(room);
  const after = await gitStatus(repoRoot);
  if (after !== before) {
    console.error("[clean-room] repository worktree changed during evaluation; evaluation artifacts must not mutate project state.");
    process.exit(1);
  }
  console.log(`[clean-room] artifacts: ${room}`);
  console.log(`[clean-room] fingerprint: ${artifacts.fingerprint ?? "unknown"}`);
  console.log(`[clean-room] worktree unchanged; no database files written. Compare with: bun run eval:regression --run ${room}`);
}

if (import.meta.main) {
  await main();
}
