import { Command } from "commander";
import { join } from "path";
import { getColeoDir } from "../context";

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

      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath, { readonly: true });

        const limit = Math.min(parseInt(options.count, 10), 100);
        let query = `
          SELECT id, timestamp, actor, action, target, details
          FROM activity
        `;
        const params: (string | number)[] = [];

        if (options.actor) {
          query += " WHERE actor = ?";
          params.push(options.actor);
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

        if (rows.length === 0) {
          console.log("No activity recorded yet.");
          console.log("Activity is logged when arms spawn, tasks are processed, etc.");
          db.close();
          return;
        }

        console.log("Activity Log");
        console.log("=".repeat(60));

        for (const row of rows) {
          const timestamp = new Date(row.timestamp).toLocaleString();
          const target = row.target ? ` on ${row.target}` : "";
          const details = JSON.parse(row.details || "{}");

          console.log(`[${timestamp}]`);
          console.log(`  ${row.actor} ${row.action}${target}`);

          if (details.domain) console.log(`    domain: ${details.domain}`);
          if (details.status) console.log(`    status: ${details.status}`);
          if (details.workdir) console.log(`    workdir: ${details.workdir}`);
          if (details.pid) console.log(`    pid: ${details.pid}`);
          if (
            Object.keys(details).length > 0 &&
            !details.domain &&
            !details.status &&
            !details.workdir &&
            !details.pid
          ) {
            console.log(`    details: ${JSON.stringify(details)}`);
          }
          console.log("");
        }

        db.close();
      } catch (err) {
        console.log("No activity database found.");
        console.log("Start the API server or brain to begin logging activity.");
      }
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
          .all(parseInt(options.count, 10)) as Array<{
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
      } catch (err) {
        console.log("No activity database found.");
        console.log("Start the API server or brain to begin logging activity.");
      }
    });
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
