import type { Database } from "bun:sqlite";

export interface HealthCheck {
  name: string;
  status: "pass" | "fail" | "unknown" | "skipped";
  checkedAt: string | null;
  detail: string;
}
export interface HealthRow {
  component: string; healthy: number; optional: number; error: string | null; last_check: string;
}
export function healthTime(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}
export function evaluateHealthRows(rows: HealthRow[], since: number, now = Date.now()): HealthCheck[] {
  const inventory = new Map(rows.map(row => [row.component, row]));
  for (const name of ["database", "nats", "maildir", "api_server", "brain_model_api", "brain_planning_gate"]) {
    if (!inventory.has(name)) inventory.set(name, { component: name, healthy: 0, optional: 0, error: null, last_check: "" });
  }
  return [...inventory.values()].map(row => {
    const time = healthTime(row.last_check);
    const fresh = Number.isFinite(time) && time >= since && time <= now + 1000 && now - time <= 300_000;
    return { name: row.component, status: !fresh ? "unknown" : row.healthy === 1 ? "pass" : "fail",
      checkedAt: row.last_check || null,
      detail: !fresh ? row.error ? `Waiting for a fresh observation. Last reported issue: ${healthIssueDetail(row.error)}`
        : row.component === "brain_model_api" && !row.last_check
          ? "No model access observation yet. Brain checks model access when it evaluates a project plan."
          : "Waiting for a fresh health observation"
        : row.healthy === 1 ? "Healthy" : healthIssueDetail(row.error || "Unhealthy") };
  });
}
function healthIssueDetail(error: string): string {
  try {
    const parsed = JSON.parse(error) as { detail?: unknown; nextStep?: unknown };
    if (typeof parsed.detail === "string") return [parsed.detail, typeof parsed.nextStep === "string" ? parsed.nextStep : ""].filter(Boolean).join(". ");
  } catch { /* Non-JSON health errors are already readable. */ }
  return error;
}
export function readOperatorHealth(db: Database, startedAt: Date, since = 0): {
  schemaVersion: number; generation: string; observedAt: string; ok: boolean; checks: HealthCheck[];
} {
  const now = Date.now();
  const brain = db.query("SELECT status, started_at, last_poll_at FROM brain_state WHERE id = 1").get() as {
    status: string; started_at: string | null; last_poll_at: string | null;
  } | null;
  const boundary = Math.max(startedAt.getTime(), healthTime(brain?.started_at) || 0, since);
  const rows = db.query("SELECT component, healthy, optional, error, last_check FROM infrastructure_health").all() as HealthRow[];
  const checks = evaluateHealthRows(rows, boundary, now);
  const poll = healthTime(brain?.last_poll_at);
  const pollHealthy = brain?.status === "running" && poll >= boundary && now - poll <= 300_000;
  checks.push({ name: "brain_poll", status: pollHealthy ? "pass" : "unknown",
    checkedAt: brain?.last_poll_at ?? null, detail: pollHealthy ? "Brain completed a recent poll" : "Brain must complete a recent poll in this runtime generation" });
  return { schemaVersion: 1, generation: startedAt.toISOString(), observedAt: new Date(now).toISOString(),
    ok: checks.every(check => check.status === "pass"), checks };
}
