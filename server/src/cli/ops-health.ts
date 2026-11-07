import type { HealthCheck } from "../api/operator-health";

export interface OpsHealth {
  schemaVersion: 1;
  ok: boolean;
  checks: HealthCheck[];
  generation?: string;
}
export interface HealthOptions {
  url: string; key: string; wait?: boolean; timeout: number; since?: string; agentId?: string;
  signal?: AbortSignal; progress?: (result: OpsHealth) => void;
}
export async function checkCentralHealth(options: HealthOptions): Promise<OpsHealth> {
  const origin = new URL(options.url);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Use an HTTP(S) server origin without credentials, path, query or fragment");
  }
  const deadline = Date.now() + options.timeout * 1000;
  let consecutive = 0;
  let generation: string | undefined;
  let lastProgress = "";
  let result: OpsHealth = { schemaVersion: 1, ok: false, checks: [] };
  do {
    options.signal?.throwIfAborted();
    try {
      const url = new URL("/api/operator/health", options.url);
      if (options.since) url.searchParams.set("since", options.since);
      if (options.agentId) url.searchParams.set("agentId", options.agentId);
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())));
      const response = await fetch(url, { headers: { "X-API-Key": options.key },
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout });
      if (!response.ok) throw new Error(`API HTTP ${response.status}${response.status === 404 ? ": upgrade the server for operator health" : ""}`);
      const body = await response.json() as OpsHealth;
      if (body.schemaVersion !== 1 || !Array.isArray(body.checks) || !body.checks.length
        || typeof body.generation !== "string" || body.checks.some(check => typeof check.name !== "string"
          || !["pass", "fail", "unknown", "skipped"].includes(check.status))) throw new Error("Invalid operator health response");
      result = { ...body, checks: body.checks.map(check => ({ ...check,
        detail: options.key ? String(check.detail).replaceAll(options.key, "[redacted]") : String(check.detail) })),
        ok: body.ok === true && body.checks.every(check => check.status === "pass" || check.status === "skipped") };
    } catch (error) {
      options.signal?.throwIfAborted();
      result = { schemaVersion: 1, ok: false, checks: [{ name: "central_api", status: "fail", checkedAt: null,
        detail: error instanceof Error && error.message.startsWith("API HTTP") ? error.message : "Central API unavailable or invalid health response" }] };
    }
    consecutive = result.ok ? generation === result.generation ? consecutive + 1 : 1 : 0;
    generation = result.generation;
    const progress = JSON.stringify({ generation: result.generation, ok: result.ok,
      checks: result.checks.map(({ name, status, detail }) => ({ name, status, detail })).sort((a, b) => a.name.localeCompare(b.name)) });
    if (progress !== lastProgress) { options.progress?.(result); lastProgress = progress; }
    if (!options.wait || consecutive >= 2) return result;
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(options.signal?.reason); };
      const timer = setTimeout(() => { options.signal?.removeEventListener("abort", stop); resolve(); }, Math.min(2000, deadline - Date.now()));
      options.signal?.addEventListener("abort", stop, { once: true });
    });
  } while (Date.now() < deadline);
  return { ...result, ok: false, checks: [...result.checks, { name: "readiness_deadline", status: "fail", checkedAt: null,
    detail: "Timed out waiting for two consecutive green snapshots. Fix blockers and run coleo-ops doctor --wait." }] };
}
