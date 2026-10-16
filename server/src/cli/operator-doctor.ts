import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { getColeoDir } from "../config";
import { getServiceStatus } from "../daemon";
import { getCliEntrypoint } from "./entrypoint";
import { resolveOperatorConfig, redactedConfig } from "./operator-config";
import type { ServiceType } from "../daemon";

interface Check { name: string; ok: boolean; detail: string }
export async function operatorDoctor(component: "server" | "agent", flags: Record<string, unknown>): Promise<object> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const [major = 0, minor = 0] = Bun.version.split(".").map(Number);
  check("bun", major > 1 || (major === 1 && minor >= 1), `${Bun.version} (requires >=1.1.0)`);
  check("entrypoint", await Bun.file(getCliEntrypoint(component)).exists(), getCliEntrypoint(component));
  check("git", Boolean(Bun.which("git")), Bun.which("git") ?? "Install git");
  for (const executable of ["ps", "tail"]) check(executable, Boolean(Bun.which(executable)), Bun.which(executable) ?? `Install ${executable}`);
  for (const service of (component === "server" ? ["server", "brain"] : ["agent"]) as ServiceType[]) {
    const status = await getServiceStatus(service);
    check(`${service}-process`, true, status.running ? `Verified PID ${status.pid}` : "Not running");
  }
  let configuration;
  try {
    const config = await resolveOperatorConfig(flags);
    configuration = redactedConfig(config);
    check("configuration", true, config.path);
    for (const path of [getColeoDir(), config.values.workspace]) {
      try { await access(path, constants.R_OK | constants.W_OK); check("path", true, path); }
      catch { check("path", false, `Create a readable/writable directory: ${path}`); }
    }
    if (component === "server") {
      const running = (await getServiceStatus("server")).running;
      const available = running || await new Promise<boolean>(resolve => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(Number(config.values.port), config.values.host, () => server.close(() => resolve(true)));
      });
      check("api-port", available, `${config.values.host}:${config.values.port}${running ? " (managed service running)" : ""}`);
    }
    if (component === "agent") {
      try {
        const { connect } = await import("nats");
        const nc = await connect({ servers: config.values.natsUrl, token: config.values.natsToken || undefined,
          timeout: 2000, reconnect: false });
        await nc.close();
        check("nats", true, config.values.natsUrl);
      } catch { check("nats", false, "NATS connection/authentication failed; check COLEO_NATS_URL and COLEO_NATS_TOKEN"); }
    }
    if (config.values.apiUrl) {
      try {
        const response = await fetch(`${config.values.apiUrl.replace(/\/$/, "")}/api/status`, {
          headers: config.values.apiKey ? { "X-API-Key": config.values.apiKey } : {}, signal: AbortSignal.timeout(2000),
        });
        check("api", response.ok, response.status === 401 || response.status === 403 ? "Authentication rejected; check COLEO_API_KEY" : `HTTP ${response.status}`);
      } catch { check("api", false, "API unreachable; check COLEO_API_URL"); }
    }
  } catch (error) { check("configuration", false, error instanceof Error ? error.message : "Invalid configuration"); }
  const ok = checks.every(check => check.ok);
  if (!ok) process.exitCode = 2;
  return { schemaVersion: 1, kind: "doctor", component, ok, checks, configuration };
}
