import { Command } from "commander";
import { join } from "path";
import { getApiConfig, getColeoDir, isApiRunning } from "../context";

interface ActivityListRow {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

interface ActivityApiResponse {
  activity?: unknown;
  message?: unknown;
}

export function registerActivityCommands(program: Command): void {
  const activityCmd = program.command("activity").description("View activity log");

  activityCmd
    .command("list")
    .description("List recent activity entries")
    .option("-n, --count <n>", "Number of entries to show", "20")
    .option("-a, --actor <name>", "Filter by actor (arm or component name)")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");
      const limit = parseLimit(options.count, 20, 100);
      const actor = typeof options.actor === "string" && options.actor.trim().length > 0
        ? options.actor.trim()
        : undefined;

      const apiResult = await fetchActivityFromApi(limit, actor);
      if (apiResult && apiResult.rows.length > 0) {
        printDetailedActivityRows(apiResult.rows);
        return;
      }

      const sqliteRows = await fetchActivityFromSqlite(dbPath, limit, actor);
      if (sqliteRows && sqliteRows.length > 0) {
        printDetailedActivityRows(sqliteRows);
        return;
      }

      if (apiResult?.message) {
        console.log(apiResult.message);
      }

      if (apiResult === null && sqliteRows === null) {
        console.log("No activity source available.");
        console.log("Start the API server (with NATS) or brain to begin logging activity.");
        return;
      }

      console.log("No activity recorded yet.");
      console.log("Activity is logged when arms spawn, tasks are processed, etc.");
    });

  activityCmd
    .command("tail")
    .description("Tail activity log in real-time (Ctrl+C to exit)")
    .option("-n, --count <n>", "Initial entries to show", "10")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath, { readonly: true });

        let lastId = 0;
        const lastRow = db.query("SELECT id FROM activity ORDER BY id DESC LIMIT 1").get() as { id: number } | null;
        if (lastRow) lastId = lastRow.id;

        console.log("Tailing activity log (Ctrl+C to exit)...");
        console.log("=".repeat(60));

        const initial = db
          .query(`
            SELECT id, timestamp, actor, action, target, details
            FROM activity
            ORDER BY timestamp DESC
            LIMIT ?
          `)
          .all(parseLimit(options.count, 10, 100)) as Array<{
            id: number;
            timestamp: string;
            actor: string;
            action: string;
            target: string | null;
            details: string;
          }>;

        for (const row of [...initial].reverse()) {
          printActivityRow(row);
        }

        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        const pollInterval = setInterval(() => {
          try {
            const newRows = db
              .query(`
                SELECT id, timestamp, actor, action, target, details
                FROM activity
                WHERE id > ?
                ORDER BY id ASC
              `)
              .all(lastId) as Array<{
                id: number;
                timestamp: string;
                actor: string;
                action: string;
                target: string | null;
                details: string;
              }>;

            if (newRows.length > 0) {
              for (const row of newRows) {
                printActivityRow(row);
                lastId = row.id;
              }
            }
          } catch {
            clearInterval(pollInterval);
          }
        }, 1000);

        process.on("SIGINT", () => {
          clearInterval(pollInterval);
          db.close();
          rl.close();
          process.exit(0);
        });

        process.on("SIGTERM", () => {
          clearInterval(pollInterval);
          db.close();
          rl.close();
          process.exit(0);
        });
      } catch {
        console.log("No activity database found.");
        console.log("Start the API server or brain to begin logging activity.");
      }
    });
}

async function fetchActivityFromApi(
  limit: number,
  actor?: string,
): Promise<{ rows: ActivityListRow[]; message?: string } | null> {
  if (!(await isApiRunning())) {
    return null;
  }

  const { apiUrl, headers } = getApiConfig();
  const fetchLimit = actor ? Math.min(Math.max(limit * 5, 100), 500) : limit;
  const query = new URLSearchParams({ limit: fetchLimit.toString() });

  try {
    const response = await fetch(`${apiUrl}/api/activity?${query.toString()}`, { headers });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as ActivityApiResponse;
    const entries = Array.isArray(payload.activity) ? payload.activity : [];
    const rows = entries
      .map((entry, idx) => normalizeActivityRow(entry, idx + 1))
      .filter((entry): entry is ActivityListRow => entry !== null);
    const filteredRows = actor
      ? rows.filter((row) => row.actor === actor || row.target === actor)
      : rows;

    return {
      rows: filteredRows.slice(0, limit),
      message: typeof payload.message === "string" ? payload.message : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchActivityFromSqlite(
  dbPath: string,
  limit: number,
  actor?: string,
): Promise<ActivityListRow[] | null> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });

    let query = `
      SELECT id, timestamp, actor, action, target, details
      FROM activity
    `;
    const params: (string | number)[] = [];

    if (actor) {
      query += " WHERE actor = ? OR target = ?";
      params.push(actor, actor);
    }

    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    const rows = db.query(query).all(...params) as Array<{
      id: number;
      timestamp: string;
      actor: string;
      action: string;
      target: string | null;
      details: string;
    }>;

    db.close();

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      actor: row.actor,
      action: row.action,
      target: row.target,
      details: parseDetails(row.details),
    }));
  } catch {
    return null;
  }
}

function normalizeActivityRow(entry: unknown, fallbackId: number): ActivityListRow | null {
  if (!isRecord(entry)) {
    return null;
  }

  const id = typeof entry.id === "number" ? entry.id : fallbackId;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
  const actor = typeof entry.actor === "string" ? entry.actor : "unknown";
  const action = typeof entry.action === "string" ? entry.action : "unknown";
  const target = typeof entry.target === "string" ? entry.target : null;

  return {
    id,
    timestamp,
    actor,
    action,
    target,
    details: normalizeDetails(entry.details),
  };
}

function printDetailedActivityRows(rows: ActivityListRow[]): void {
  console.log("Activity Log");
  console.log("=".repeat(60));

  for (const row of rows) {
    const timestamp = new Date(row.timestamp).toLocaleString();
    const target = row.target ? ` on ${row.target}` : "";

    console.log(`[${timestamp}]`);
    console.log(`  ${row.actor} ${row.action}${target}`);

    const domain = asDetailString(row.details.domain);
    const status = asDetailString(row.details.status);
    const workdir = asDetailString(row.details.workdir);
    const pid = row.details.pid;

    if (domain) console.log(`    domain: ${domain}`);
    if (status) console.log(`    status: ${status}`);
    if (workdir) console.log(`    workdir: ${workdir}`);
    if (typeof pid === "number" || typeof pid === "string") console.log(`    pid: ${pid}`);

    if (
      Object.keys(row.details).length > 0 &&
      !domain &&
      !status &&
      !workdir &&
      pid === undefined
    ) {
      console.log(`    details: ${JSON.stringify(row.details)}`);
    }

    console.log("");
  }
}

function parseDetails(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeDetails(parsed);
  } catch {
    return {};
  }
}

function normalizeDetails(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDetailString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function parseLimit(rawValue: unknown, fallback: number, max: number): number {
  if (typeof rawValue !== "string") {
    return fallback;
  }

  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function printActivityRow(row: {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: string;
}): void {
  const timestamp = new Date(row.timestamp).toLocaleTimeString();
  const target = row.target ? ` on ${row.target}` : "";
  console.log(`[${timestamp}] ${row.actor} ${row.action}${target}`);
}
