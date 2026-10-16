import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { getColeoDir } from "../config";
import { loadEnvFile } from "../config/env";

export const SETTINGS = {
  host: ["COLEO_API_HOST", "0.0.0.0"], port: ["COLEO_API_PORT", "8080"],
  apiUrl: ["COLEO_API_URL", ""], apiKey: ["COLEO_API_KEY", ""],
  natsUrl: ["COLEO_NATS_URL", "nats://127.0.0.1:4222"], natsToken: ["COLEO_NATS_TOKEN", ""],
  workspace: ["COLEO_AGENT_WORKDIR", ""], id: ["COLEO_AGENT_ID", ""],
  maxArms: ["COLEO_AGENT_MAX_ARMS", "10"], heartbeatInterval: ["COLEO_AGENT_HEARTBEAT_INTERVAL", "30000"],
  interval: ["COLEO_BRAIN_INTERVAL", "30000"], verbose: ["COLEO_VERBOSE", "false"],
  swarmEvaluation: ["COLEO_SWARM_EVALUATION", "off"], swarmWindowPolls: ["COLEO_SWARM_WINDOW_POLLS", "10"],
} as const;
export type Setting = keyof typeof SETTINGS;
export type OperatorValues = Record<Setting, string>;
export interface ResolvedOperatorConfig { values: OperatorValues; sources: Record<Setting, string>; path: string }
export function operatorConfigPath(): string { return join(getColeoDir(), "operator.json"); }
export async function readOperatorConfig(): Promise<Partial<OperatorValues>> {
  let text;
  try { text = await readFile(operatorConfigPath(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  try {
    const data = JSON.parse(text);
    if (data.schemaVersion !== 1 || !data.values || typeof data.values !== "object") throw new Error();
    for (const [key, value] of Object.entries(data.values)) {
      if (!(key in SETTINGS) || typeof value !== "string") throw new Error();
    }
    return data.values;
  } catch { throw new Error(`Invalid operator configuration: ${operatorConfigPath()}`); }
}
export function validateOperatorConfig(values: Partial<OperatorValues>): void {
  for (const key of ["host", "id", "workspace"] as const) {
    if (values[key]?.includes("\0") || values[key]?.includes("\n")) throw new Error(`${key} contains invalid characters`);
  }
  if (values.host !== undefined && !values.host.trim()) throw new Error("host must not be empty");
  if (values.verbose !== undefined && !["true", "false"].includes(values.verbose)) throw new Error("verbose must be true or false");
  for (const key of ["port", "maxArms", "heartbeatInterval", "interval", "swarmWindowPolls"] as const) {
    if (values[key] !== undefined && (!/^\d+$/.test(values[key]!) || Number(values[key]) < 1)) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  if (Number(values.port) > 65535) throw new Error("port must be at most 65535");
  if (Number(values.swarmWindowPolls) > 100) throw new Error("swarmWindowPolls must be at most 100");
  if (values.swarmEvaluation && !["off", "shadow", "execute"].includes(values.swarmEvaluation)) throw new Error("Invalid swarm evaluation mode");
  for (const key of ["apiUrl", "natsUrl"] as const) {
    if (!values[key]) continue;
    let url: URL;
    try { url = new URL(values[key]!); } catch { throw new Error(`Invalid ${key}`); }
    if (!(key === "apiUrl" ? ["http:", "https:"] : ["nats:", "tls:", "ws:", "wss:"]).includes(url.protocol)) throw new Error(`Invalid ${key} protocol`);
    if (url.username || url.password || url.search || url.hash) throw new Error(`${key} must not contain credentials, query or fragment; use environment credentials`);
  }
}
export async function saveOperatorConfig(values: Partial<OperatorValues>): Promise<void> {
  validateOperatorConfig(values);
  await mkdir(getColeoDir(), { recursive: true });
  const path = operatorConfigPath();
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ schemaVersion: 1, values }, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
export async function resolveOperatorConfig(flags: Record<string, unknown> = {}, previous: Partial<OperatorValues> = {}): Promise<ResolvedOperatorConfig> {
  const exported = { ...process.env };
  await loadEnvFile();
  const saved = { ...await readOperatorConfig(), ...previous };
  const values = {} as OperatorValues;
  const sources = {} as Record<Setting, string>;
  for (const key of Object.keys(SETTINGS) as Setting[]) {
    const [env, fallback] = SETTINGS[key];
    const flag = flags[key];
    const environmentValue = process.env[env] || (key === "apiKey" ? process.env.COLEO_API_TOKEN : undefined);
    const exportedValue = exported[env] || (key === "apiKey" ? exported.COLEO_API_TOKEN : undefined);
    const source = flag !== undefined ? "flag" : exportedValue ? "environment" : environmentValue ? "env-file" : saved[key] !== undefined ? "saved" : "default";
    values[key] = String(flag ?? exportedValue ?? environmentValue ?? saved[key] ?? fallback);
    sources[key] = source;
  }
  values.workspace = resolve(values.workspace || process.env.COLEO_PROJECT_DIR || process.cwd());
  // Preserve the existing host/port environment shorthand for NATS.
  if (sources.natsUrl === "default" && (process.env.COLEO_NATS_HOST || process.env.COLEO_NATS_PORT)) {
    const { resolveNatsUrl } = await import("../network-config");
    values.natsUrl = resolveNatsUrl(); sources.natsUrl = "environment";
  }
  validateOperatorConfig(values);
  return { values, sources, path: operatorConfigPath() };
}
export async function ensureAgentId(config: ResolvedOperatorConfig): Promise<void> {
  if (config.values.id) return;
  config.values.id = `${hostname()}-${crypto.randomUUID().slice(0, 8)}`;
  config.sources.id = "saved";
  await saveOperatorConfig({ ...await readOperatorConfig(), id: config.values.id });
}
export function applyOperatorEnvironment(config: ResolvedOperatorConfig): void {
  for (const key of Object.keys(SETTINGS) as Setting[]) {
    // Leave an unconfigured NATS URL absent so the server's existing local bootstrap can run.
    if (key === "natsUrl" && config.sources[key] === "default") continue;
    process.env[SETTINGS[key][0]] = config.values[key];
  }
}
export function redactedConfig(config: ResolvedOperatorConfig): ResolvedOperatorConfig {
  return { ...config, values: { ...config.values, apiKey: config.values.apiKey ? "[redacted]" : "", natsToken: config.values.natsToken ? "[redacted]" : "" } };
}
