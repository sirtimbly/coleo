#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import { VERSION } from "../version";
import { operatorDoctor } from "./operator-doctor";
import { checkCentralHealth } from "./ops-health";
import { setup, reportHealth, SetupFailure } from "./ops-setup";
import { choose } from "./ops-prompts";
import { formatSetupFailure, formatSetupSuccess, reportHealthProgress } from "./ops-output";
import { resolveOpsSelection, inspectOpsConfig, inspectOpsStatus, formatOpsStatus } from "./ops-inspect";
import type { OpsOptions, SetupResult } from "./ops-setup";
import type { OpsHealth } from "./ops-health";

function seconds(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 86400) throw new InvalidArgumentError("Use 1–86400 seconds");
  return Number(value);
}
async function doctor(options: OpsOptions, signal: AbortSignal): Promise<OpsHealth> {
  const selection = await resolveOpsSelection(options);
  const { role, config } = selection;
  if (!options.json) console.error(`Workspace: ${selection.workspace.workspace}\nRuntime: ${selection.workspace.directory}\nServer: ${selection.server} (${selection.serverOrigin})`);
  const localChecks: OpsHealth["checks"] = [];
  for (const component of (role === "local" ? ["server", "agent"] : role === "server" || role === "agent" ? [role] : []) as Array<"server" | "agent">) {
    const result = await operatorDoctor(component, { apiUrl: selection.server, workspace: selection.workspace.workspace }) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
    process.exitCode = 0;
    localChecks.push(...result.checks.map(check => ({ name: `${component}:${check.name}`, status: check.ok && !(check.name.endsWith("-process") && check.detail === "Not running") ? "pass" as const : "fail" as const,
      checkedAt: new Date().toISOString(), detail: check.detail })));
  }
  const central = await checkCentralHealth({ url: selection.server,
    key: config.values.apiKey, wait: options.wait, timeout: options.timeout, signal,
    agentId: role === "local" || role === "agent" ? config.values.id || undefined : undefined,
    progress: options.wait && !options.json ? reportHealthProgress : undefined });
  return { ...central, ok: central.ok && localChecks.every(check => check.status === "pass"), checks: [...localChecks, ...central.checks] };
}
export function createOpsProgram(signal: AbortSignal): Command {
  const program = new Command("coleo-ops").description("Set up Coleo components and diagnose central service health").version(VERSION)
    .option("--dir <path>", "Runtime/ops state directory")
    .option("--json", "One redacted JSON result on stdout")
    .option("--doctor", "Alias for doctor (cannot be combined with a subcommand)")
    .option("--wait", "Wait for two consecutive green central health snapshots")
    .option("--timeout <seconds>", "Readiness deadline", seconds, 180)
    .option("--server <url>", "Central API origin")
    .option("--role <role>", "Setup: local/client/agent; doctor also supports server");
  const emit = (options: OpsOptions, result: OpsHealth & Partial<SetupResult>) => {
    if (options.json) console.log(JSON.stringify(result));
    else if (result.runtime && result.ok) console.log(formatSetupSuccess(result as SetupResult));
    else { reportHealth(result); for (const command of result.nextCommands ?? []) console.log(command); }
    process.exitCode = result.ok ? 0 : 1;
  };
  const runDoctor = async (options: OpsOptions) => emit(options, await doctor(options, signal));
  program.command("doctor").description("Read-only component and central API readiness diagnostics").action(async (_options, command) => {
    if (program.opts().doctor) throw new Error("Use doctor or --doctor, not both");
    await runDoctor(command.optsWithGlobals());
  });
  program.command("status").description("Show the selected workspace, local processes, and central readiness").action(async (_options: unknown, command: Command) => {
    if (program.opts().doctor) throw new Error("--doctor cannot be combined with status");
    const options = command.optsWithGlobals<OpsOptions>();
    const result = await inspectOpsStatus(await resolveOpsSelection(options), options, signal);
    console.log(options.json ? JSON.stringify(result) : formatOpsStatus(result));
    process.exitCode = result.ok ? 0 : 1;
  });
  program.command("config").description("Inspect effective operations settings (read-only)")
    .command("show").description("Show effective values; credentials are always redacted")
    .option("--show-origin", "Include the source file, environment variable, flag, or default")
    .action(async (_options: unknown, command: Command) => {
      if (program.opts().doctor) throw new Error("--doctor cannot be combined with config show");
      const options = command.optsWithGlobals<OpsOptions & { showOrigin?: boolean }>();
      const result = inspectOpsConfig(await resolveOpsSelection(options));
      if (options.json) console.log(JSON.stringify(result));
      else for (const entry of result.entries) console.log(`${entry.name.padEnd(20)} ${entry.value || "(unset)"}${options.showOrigin ? `  [${entry.origin}]` : ""}`);
    });
  program.command("init").alias("setup").description("Initialize a workspace, client connection, or Arm Host")
    .option("--clients <clients>", "Comma-separated optional clients: tui, web, macos; cli is always included")
    .option("--client <client>", "Compatibility alias for --clients")
    .option("--workspace <path>", "Repository directory")
    .option("--connection <name>", "Client connection name")
    .option("--nats-url <url>", "Remote broker URL")
    .option("--provider <name>", "Brain provider")
    .option("--model <name>", "Brain model")
    .option("--config <path>", "Versioned nonsecret setup JSON")
    .option("--resume", "Recheck and resume the saved setup")
    .option("--dry-run", "Show plan without writes or startup")
    .option("--non-interactive", "Require complete automation inputs")
    .option("--prefix <path>", "Component installation prefix")
    .option("--release <version>", "Release for missing client components", VERSION)
    .action(async (_options, command) => {
      if (program.opts().doctor) throw new Error("--doctor cannot be combined with init");
      emit(command.optsWithGlobals(), await setup(command.optsWithGlobals(), signal));
    });
  program.action(async () => {
    const options = program.opts<OpsOptions & { doctor?: boolean }>();
    if (options.doctor) return runDoctor(options);
    if (!process.stdin.isTTY || options.json) { program.outputHelp(); return; }
    const choice = await choose("What would you like to do?", [
      { value: "init", name: "Initialize Coleo" }, { value: "doctor", name: "Check service health" },
    ], "init", signal);
    if (choice === "doctor") await runDoctor(options);
    else if (choice === "init") emit(options, await setup(options, signal));
    else throw new Error("Choose init or doctor");
  });
  return program;
}
if (import.meta.main) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Cancelled; rerun init --resume"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const program = createOpsProgram(controller.signal).exitOverride();
  try { await program.parseAsync(); }
  catch (error) {
    const code = error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) : undefined;
    if (code !== 0) {
      const message = error instanceof Error ? error.message : "Operation failed";
      const result = { schemaVersion: 1, ok: false, error: message,
        ...(error instanceof SetupFailure ? error.result : {}),
        nextCommand: error instanceof SetupFailure ? error.result.nextCommands[0]
          : `coleo-ops --dir ${JSON.stringify(resolve(program.opts().dir || process.env.COLEO_DIR || ".coleo"))} doctor --wait` };
      if (process.argv.includes("--json")) console.log(JSON.stringify(result));
      else {
        console.error(error instanceof SetupFailure ? formatSetupFailure(error) : `${message}\n${result.nextCommand}`);
      }
      const cancelled = controller.signal.aborted || error instanceof Error && error.name === "AbortError"
        || error instanceof SetupFailure && error.cancelled;
      process.exitCode = cancelled ? 130 : code ? 2 : 1;
    }
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
