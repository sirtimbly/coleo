import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getServiceStatus } from "../daemon";
import { SETTINGS, resolveOperatorConfig, redactedConfig, validateOperatorConfig } from "./operator-config";
import { discoverOpsWorkspace } from "./ops-workspace";
import { checkCentralHealth } from "./ops-health";
import type { OpsOptions } from "./ops-setup";
import type { ResolvedOperatorConfig, Setting } from "./operator-config";
import type { WorkspaceSelection } from "./ops-workspace";
import type { HealthCheck } from "../api/operator-health";

export interface OpsSelection {
  workspace: WorkspaceSelection;
  config: ResolvedOperatorConfig;
  server: string;
  serverOrigin: string;
  role: "local" | "server" | "agent" | "client";
  roleOrigin: string;
  initialized: boolean;
}
/** Shared effective target for status, doctor, and config inspection. No client stores are read. */
export async function resolveOpsSelection(options: OpsOptions): Promise<OpsSelection> {
  const workspace = discoverOpsWorkspace(options);
  process.env.COLEO_DIR = workspace.directory;
  const path = join(workspace.directory, "target.json");
  let target: { server?: string; role?: string } = {};
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (!data || data.schemaVersion !== 1 || (data.server !== undefined && typeof data.server !== "string")
      || (data.role !== undefined && !["local", "server", "agent", "client"].includes(data.role))) throw new Error();
    target = data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid operations target: ${path}`);
  }
  const config = await resolveOperatorConfig(options.server ? { apiUrl: options.server } : {}, {}, workspace.workspace);
  if (options.server) config.origins.apiUrl = "flag:--server";
  if (config.sources.workspace === "default") {
    config.values.workspace = workspace.workspace;
    config.origins.workspace = workspace.found ? `discovered:${workspace.directory}` : "default:current-directory";
  }
  workspace.workspace = config.values.workspace;
  if (target.server && ["saved", "default"].includes(config.sources.apiUrl)) {
    config.values.apiUrl = target.server;
    config.sources.apiUrl = "target";
    config.origins.apiUrl = `${path}:server`;
  }
  if (!config.values.apiUrl) {
    config.values.apiUrl = `http://127.0.0.1:${config.values.port}`;
    config.origins.apiUrl = `default:loopback + port (${config.origins.port})`;
  }
  validateOperatorConfig({ apiUrl: config.values.apiUrl });
  const url = new URL(config.values.apiUrl);
  if (url.pathname !== "/") throw new Error("Server must be an origin without a path");
  const role = options.role || target.role || "local";
  if (!["local", "server", "agent", "client"].includes(role)) throw new Error("Choose role local, server, agent, or client");
  return { workspace, config, server: config.values.apiUrl, serverOrigin: config.origins.apiUrl,
    role: role as OpsSelection["role"], roleOrigin: options.role ? "flag:--role" : target.role ? `${path}:role` : "default",
    initialized: ["operator.json", "config.toml", "target.json"].some(name => existsSync(join(workspace.directory, name))) };
}
interface ConfigEntry { name: string; value: string; origin: string }
export function inspectOpsConfig(selection: OpsSelection): { schemaVersion: 1; kind: "ops.config"; entries: ConfigEntry[] } {
  const config = redactedConfig(selection.config);
  return { schemaVersion: 1, kind: "ops.config", entries: [
    { name: "runtime", value: selection.workspace.directory, origin: selection.workspace.origin },
    { name: "role", value: selection.role, origin: selection.roleOrigin },
    ...Object.keys(SETTINGS).map(name => ({ name, value: config.values[name as Setting], origin: config.origins[name as Setting] })),
  ] };
}
export interface OpsStatus {
  schemaVersion: 1;
  kind: "ops.status";
  ok: boolean;
  initialized: boolean;
  workspace: string;
  runtime: string;
  runtimeOrigin: string;
  server: string;
  serverOrigin: string;
  role: string;
  services: Array<{ name: string; running: boolean; pid?: number }>;
  checks: HealthCheck[];
  nextCommand: string;
}
export async function inspectOpsStatus(selection: OpsSelection, options: OpsOptions, signal: AbortSignal): Promise<OpsStatus> {
  const targetFlags = `--dir ${JSON.stringify(selection.workspace.directory)}${options.server ? ` --server ${JSON.stringify(selection.server)}` : ""}${options.role ? ` --role ${selection.role}` : ""}`;
  const result: OpsStatus = { schemaVersion: 1, kind: "ops.status", ok: false,
    initialized: selection.initialized, workspace: selection.workspace.workspace, runtime: selection.workspace.directory,
    runtimeOrigin: selection.workspace.origin, server: selection.server, serverOrigin: selection.serverOrigin,
    role: selection.role, services: [], checks: [], nextCommand: `coleo-ops ${targetFlags} init` };
  const explicitServer = !selection.serverOrigin.startsWith("default:");
  if (!selection.initialized && !explicitServer) return result;
  const services = selection.role === "local" ? ["server", "brain", "agent"] as const
    : selection.role === "server" ? ["server", "brain"] as const : selection.role === "agent" ? ["agent"] as const : [];
  result.services = await Promise.all(services.map(async name => {
    const status = await getServiceStatus(name);
    return { name, running: status.running, ...(status.pid ? { pid: status.pid } : {}) };
  }));
  const central = await checkCentralHealth({ url: selection.server, key: selection.config.values.apiKey,
    timeout: Math.min(options.timeout, 5), signal,
    agentId: selection.role === "local" || selection.role === "agent" ? selection.config.values.id || undefined : undefined });
  result.checks = central.checks;
  result.ok = central.ok && result.services.every(service => service.running);
  result.nextCommand = result.ok ? "Ready. Open your selected client."
    : `coleo-ops ${targetFlags} doctor --wait`;
  return result;
}
export function formatOpsStatus(status: OpsStatus): string {
  const lines = [
    `Workspace  ${status.workspace}`, `Runtime    ${status.runtime} (${status.runtimeOrigin})`,
    `Server     ${status.server} (${status.serverOrigin})`, `Role       ${status.role}`,
  ];
  if (!status.initialized && !status.checks.length) lines.push("State      Not initialized");
  else {
    if (status.services.length) lines.push(`Local      ${status.services.map(service => `${service.name}: ${service.running ? `running (${service.pid})` : "stopped"}`).join("; ")}`);
    const pending = status.checks.filter(check => check.status === "fail" || check.status === "unknown");
    lines.push(`Readiness  ${status.ok ? "Ready" : "Needs attention"}`);
    lines.push(`Checks     ${status.checks.filter(check => check.status === "pass").length} passing, ${pending.length} blocked, ${status.checks.filter(check => check.status === "skipped").length} skipped`);
    for (const check of pending.slice(0, 3)) lines.push(`  ${check.status}: ${check.name} — ${check.detail.replace(/[\r\n]+/g, " ").slice(0, 180)}`);
    if (pending.length > 3) lines.push(`  …and ${pending.length - 3} more; run doctor for details.`);
  }
  lines.push("", status.nextCommand);
  return lines.join("\n");
}
