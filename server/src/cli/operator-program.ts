import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { VERSION } from "../version";
import { getColeoDir } from "../config";
import { startService, stopService, restartService, getServiceStatus, getServiceLogs, getLogFilePath, getPidFilePath } from "../daemon";
import { resolveOperatorConfig, redactedConfig, readOperatorConfig, saveOperatorConfig, ensureAgentId, applyOperatorEnvironment } from "./operator-config";
import { operatorDoctor } from "./operator-doctor";
import type { Setting, ResolvedOperatorConfig, OperatorValues } from "./operator-config";

const fields = {
  server: ["host", "port", "apiUrl", "natsUrl"],
  agent: ["id", "workspace", "natsUrl", "maxArms", "heartbeatInterval", "apiUrl", "verbose"],
  brain: ["interval", "verbose", "swarmEvaluation", "swarmWindowPolls"],
} satisfies Record<string, Setting[]>;
const flagName = (key: string) => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
function addSettings(command: Command, service: "server" | "agent" | "brain"): Command {
  for (const key of fields[service]) {
    if (key === "verbose") command.option("--verbose", "Verbose runtime logging").option("--no-verbose", "Disable verbose runtime logging");
    else command.option(`--${flagName(key)} <value>`, `${key} (flags > environment > saved configuration > defaults)`);
  }
  return command;
}
function emit(command: Command, value: object): void {
  if (command.optsWithGlobals().json) { console.log(JSON.stringify(value)); return; }
  const result = value as Record<string, unknown>;
  const component = String(result.component);
  const executable = component === "agent" ? "coleo-agent" : component === "brain" ? "coleo-server brain" : "coleo-server";
  if (result.kind === "configuration") {
    console.log(`Saved ${component} configuration: ${result.path}\nNext: ${executable} start`);
  } else if (result.kind === "doctor") {
    console.log(`${component}: ${result.ok ? "diagnostic checks passed" : "diagnostic checks failed"}`);
    for (const check of result.checks as Array<{ name: string; ok: boolean; detail: string }>) {
      console.log(`  ${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}`);
    }
  } else {
    console.log(`${component}: ${result.running ? `running (PID ${result.pid})` : "stopped"}`);
    if (result.runtimeDirectory) console.log(`Runtime: ${result.runtimeDirectory}`);
    if (result.logPath) console.log(`Logs: ${result.logPath}`);
    console.log(`Next: ${executable} ${result.running ? "logs" : "start"}`);
  }
}
function launchArgs(service: "server" | "agent" | "brain", config: ResolvedOperatorConfig): string[] {
  return fields[service].filter(key => !(service === "server" && key === "natsUrl" && config.sources[key] === "default"))
    .flatMap(key => key === "verbose"
    ? config.values.verbose === "true" ? ["--verbose"] : []
    : [`--${flagName(key)}`, config.values[key]]);
}
async function configure(component: "server" | "agent", command: Command): Promise<void> {
  const flags = command.optsWithGlobals();
  console.error(`Configuring local ${component} runtime: ${getColeoDir()}`);
  if (flags.interactive) {
    if (!process.stdin.isTTY) throw new Error("--interactive requires a terminal");
    let hidden = false;
    const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stderr.write(chunk); callback(); } });
    const prompt = createInterface({ input: process.stdin, output, terminal: true });
    try {
      for (const key of fields[component].filter(key => key !== "verbose")) {
        const answer = await prompt.question(`${key} (Enter to keep current): `);
        if (answer) flags[key] = answer;
      }
      for (const key of component === "agent" ? ["natsToken", "apiKey"] : ["apiKey"]) {
        process.stderr.write(`${key} (hidden; Enter to keep current): `);
        hidden = true;
        const answer = await prompt.question("");
        hidden = false; process.stderr.write("\n");
        if (answer) flags[key] = answer;
      }
    } finally { prompt.close(); }
  }
  if (flags.apiKeyStdin && flags.natsTokenStdin) throw new Error("Use only one credential stdin option at a time");
  if (flags.apiKeyStdin || flags.natsTokenStdin) {
    flags[flags.apiKeyStdin ? "apiKey" : "natsToken"] = (await Bun.stdin.text()).trim();
  }
  const config = await resolveOperatorConfig(flags);
  if (component === "agent") await ensureAgentId(config);
  const saved = { ...await readOperatorConfig(), ...config.values };
  if (component === "server" && config.sources.natsUrl === "default") delete (saved as Partial<OperatorValues>).natsUrl;
  await saveOperatorConfig(saved);
  emit(command, { schemaVersion: 1, kind: "configuration", component, ok: true, ...redactedConfig(config) });
}
function registerLifecycle(parent: Command, service: "server" | "agent" | "brain"): void {
  for (const operation of ["run", "start", "restart"] as const) {
    const command = addSettings(parent.command(operation).description(`${operation === "run" ? "Run foreground" : operation === "start" ? "Start background" : "Restart"} local ${service} process`), service);
    if (service === "brain" && operation === "run") command.option("--once", "Run one polling cycle")
      .option("--cycles <count>", "Run a bounded number of polling cycles");
    if (operation !== "run") command.option("--startup-timeout <ms>", "Readiness deadline", "30000");
    if (operation === "restart") command.option("--force", "Kill if graceful shutdown times out").option("--timeout <ms>", "Shutdown deadline", "10000");
    command.action(async () => {
      const flags = command.optsWithGlobals();
      const previousValues: Partial<OperatorValues> = {};
      // On restart, previously resolved nonsecret launch settings become saved defaults.
      // Explicit flags and current exported environment still take precedence.
      if (operation === "restart") {
        const { readLaunchArgs } = await import("../daemon");
        const previous = await readLaunchArgs(service);
        for (const key of fields[service]) {
          const index = previous.indexOf(`--${flagName(key)}`);
          if (index >= 0) previousValues[key] = key === "verbose" ? "true" : previous[index + 1];
        }
      }
      const config = await resolveOperatorConfig(flags, previousValues);
      if (service === "agent") await ensureAgentId(config);
      applyOperatorEnvironment(config);
      if (operation === "run") {
        if (flags.json) throw new Error("--json is for bounded operations; run streams runtime text logs");
        const { runOperatorService } = await import("./operator-runtime");
        if (flags.once && flags.cycles) throw new Error("Use either --once or --cycles");
        await runOperatorService(service, config.values, {
          cycles: flags.once ? 1 : flags.cycles ? numberOption(flags.cycles, 1) : undefined,
          launchArgs: launchArgs(service, config),
        });
        return;
      }
      if (service === "agent") console.error("coleo-agent start runs in background; use coleo-agent run for foreground operation.");
      const status = await (operation === "start" ? startService : restartService)(service, {
        args: launchArgs(service, config), force: flags.force, timeout: numberOption(flags.timeout, 10000),
        startupTimeout: numberOption(flags.startupTimeout, 30000),
      });
      emit(command, { schemaVersion: 1, kind: operation, component: service, ok: true, ...status, logPath: getLogFilePath(service) });
    });
  }
  const stop = parent.command("stop").description(`Stop the local ${service} process${service === "agent" ? "; host shutdown is distinct from terminating individual arms" : ""}`)
    .option("--force", "Kill if graceful shutdown times out").option("--timeout <ms>", "Shutdown deadline", "10000");
  stop.action(async () => {
    const flags = stop.optsWithGlobals();
    const status = await stopService(service, { force: flags.force, timeout: numberOption(flags.timeout, 10000) });
    if (status.running) throw new Error(`${service} registration changed during stop; inspect ${service} status before stopping the replacement`);
    emit(stop, { schemaVersion: 1, kind: "stop", component: service, ok: true, ...status });
  });
  const status = parent.command("status").description(`Offline local ${service} process identity and paths`);
  status.action(async () => emit(status, { schemaVersion: 1, kind: "status", component: service, ok: true,
    ...await getServiceStatus(service), runtimeDirectory: getColeoDir(), pidPath: getPidFilePath(service), logPath: getLogFilePath(service) }));
  const logs = parent.command("logs").description("Local text log (append-only across restarts); --json returns bounded lines")
    .option("-n, --lines <count>", "Number of lines", "50").option("-f, --follow", "Stream raw text until interrupted");
  logs.action(async () => {
    const flags = logs.optsWithGlobals();
    const lines = numberOption(flags.lines, 50);
    if (flags.follow) {
      if (flags.json) throw new Error("--follow streams text; omit --json");
      const tail = spawn("tail", ["-n", String(lines), "-F", getLogFilePath(service)], { stdio: "inherit" });
      const interrupt = () => { tail.kill("SIGTERM"); process.exitCode = 130; };
      process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
      try { await new Promise<void>((resolve, reject) => { tail.once("error", reject); tail.once("exit", () => resolve()); }); }
      finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
    } else {
      const output = await getServiceLogs(service, lines);
      if (flags.json) emit(logs, { schemaVersion: 1, kind: "logs", component: service, ok: true, lines: output });
      else console.log(output.join("\n"));
    }
  });
}
function numberOption(value: unknown, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Timeouts and line counts must be positive integers");
  return number;
}
function createOperatorProgram(component: "server" | "agent"): Command {
  const program = new Command().name(`coleo-${component}`).version(VERSION)
    .description(`Manage the local ${component === "server" ? "API and brain" : "Arm Host"}; remote workspace operations use coleo-client`)
    .option("--dir <path>", "Runtime directory (overrides COLEO_DIR)")
    .option("--json", "One JSON object for bounded operations");
  program.hook("preAction", (_root, command) => {
    const dir = command.optsWithGlobals().dir;
    process.env.COLEO_DIR = resolve(dir || getColeoDir());
  });
  registerLifecycle(program, component);
  if (component === "server") registerLifecycle(program.command("brain").description("Local brain lifecycle; starts separately from API"), "brain");
  const config = addSettings(program.command("configure").description("Save validated operator.json (0600), scoped to the runtime directory"), component)
    .option("--interactive", "Prompt for settings and hidden credentials")
    .option("--api-key-stdin", "Read HTTP credential from stdin")
    .option("--nats-token-stdin", "Read NATS credential from stdin");
  if (component === "server") addSettings(config, "brain");
  config.action(async () => configure(component, config));
  const doctor = addSettings(program.command("doctor").description("Read-only local diagnostics and configured transport checks"), component);
  doctor.action(async () => emit(doctor, await operatorDoctor(component, doctor.optsWithGlobals())));
  program.action(() => program.outputHelp());
  return program;
}
export function createServerProgram(): Command { return createOperatorProgram("server"); }
export function createAgentProgram(): Command { return createOperatorProgram("agent"); }
export async function runOperatorProgram(program: Command): Promise<void> {
  program.exitOverride();
  try { await program.parseAsync(); }
  catch (error) {
    if (error && typeof error === "object" && "exitCode" in error && error.exitCode === 0) return;
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ schemaVersion: 1, kind: "error", component: program.name(), ok: false, error: message }));
    else console.error(message);
    // Startup may have opened transport handles before failing. Runtime cleanup has
    // already been awaited; do not leave a failed executable alive on those handles.
    process.exit(1);
  }
}
