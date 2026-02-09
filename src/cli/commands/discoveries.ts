import { Command } from "commander";
import { join } from "path";
import { getColeoDir } from "../context";
import {
  getOpenDiscoveries,
  getTaskDiscoveries,
  getDiscoveriesByPhase,
  getResolvedDiscoveries,
  findDiscoveryByTitle,
  resolveDiscovery,
  formatDiscovery,
  getResolutionReason,
  toDiscovery,
  type DiscoveryRow,
} from "./discoveries-db";

export function registerDiscoveriesCommands(program: Command): void {
  const discoveriesCmd = program.command("discoveries").description("Discovery analysis tools");

  discoveriesCmd
    .command("summarize")
    .description("Test the LLM discovery summarizer for a task")
    .option("-t, --task <subject>", "Task subject or ID to summarize discoveries for")
    .option("-v, --verbose", "Show raw LLM response and reasoning")
    .action(async (options: { task?: string; verbose?: boolean }) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { initDatabase } = await import("../../db");
        const { DiscoverySummarizer, formatDiscoverySummary } = await import("../../brain/discovery-summarizer");

        const db = await initDatabase(dbPath);

        const globalDiscoveries = getOpenDiscoveries(db, 50);

        console.log(`Found ${globalDiscoveries.length} global discoveries\n`);

        let task: { id: string; subject: string; description: string; priority: string; domain?: string };

        if (options.task) {
          const taskRow = db
            .query(
              `
            SELECT id, subject, description, priority, domain
            FROM tasks
            WHERE subject LIKE ? OR id = ?
            LIMIT 1
          `,
            )
            .get(`%${options.task}%`, options.task) as {
            id: string;
            subject: string;
            description: string;
            priority: string;
            domain: string | null;
          } | null;

          if (taskRow) {
            task = {
              id: taskRow.id,
              subject: taskRow.subject,
              description: taskRow.description,
              priority: taskRow.priority,
              domain: taskRow.domain || undefined,
            };
            console.log(`Using task: ${task.subject} (${task.id})\n`);
          } else {
            task = {
              id: "test-task",
              subject: options.task,
              description: `Test task: ${options.task}`,
              priority: "normal",
            };
            console.log(`Using mock task: ${task.subject}\n`);
          }
        } else {
          const pendingTask = db
            .query(
              `
            SELECT id, subject, description, priority, domain
            FROM tasks
            WHERE status = 'pending'
            ORDER BY created_at DESC
            LIMIT 1
          `,
            )
            .get() as {
            id: string;
            subject: string;
            description: string;
            priority: string;
            domain: string | null;
          } | null;

          if (pendingTask) {
            task = {
              id: pendingTask.id,
              subject: pendingTask.subject,
              description: pendingTask.description,
              priority: pendingTask.priority,
              domain: pendingTask.domain || undefined,
            };
            console.log(`Using pending task: ${task.subject} (${task.id})\n`);
          } else {
            task = {
              id: "demo-task",
              subject: "Implement new feature",
              description: "A demonstration task for testing the discovery summarizer",
              priority: "normal",
              domain: "development",
            };
            console.log(`No pending tasks found. Using demo task: ${task.subject}\n`);
          }
        }

        const taskDiscoveries = getTaskDiscoveries(db, task.id);

        console.log(`Found ${taskDiscoveries.length} task-specific discoveries\n`);

        const globalDisc = globalDiscoveries.map(toDiscovery);
        const taskDisc = taskDiscoveries.map(toDiscovery);

        console.log("=".repeat(60));
        console.log("CALLING DISCOVERY SUMMARIZER...");
        console.log("=".repeat(60));
        console.log();

        if (!process.env.OPENAI_API_KEY) {
          console.log("WARNING: OPENAI_API_KEY not set. Using fallback summarization.\n");
        } else {
          console.log(`Using model: ${process.env.OPENAI_MODEL || "gpt-4o-mini"}\n`);
        }

        const summarizer = new DiscoverySummarizer((msg) => {
          if (options.verbose) {
            console.log(`[DEBUG] ${msg}`);
          }
        });

        const startTime = Date.now();
        const summary = await summarizer.summarize({
          task: task as Parameters<typeof summarizer.summarize>[0]["task"],
          globalDiscoveries: globalDisc,
          taskDiscoveries: taskDisc,
        });
        const elapsed = Date.now() - startTime;

        console.log(`Summarization completed in ${elapsed}ms\n`);
        console.log("=".repeat(60));
        console.log("FORMATTED SUMMARY (as it appears in context bundle)");
        console.log("=".repeat(60));
        console.log();
        console.log(formatDiscoverySummary(summary));
        console.log();

        if (options.verbose && summary.reasoning) {
          console.log("=".repeat(60));
          console.log("LLM REASONING");
          console.log("=".repeat(60));
          console.log(summary.reasoning);
          console.log();
        }

        if (options.verbose) {
          console.log("=".repeat(60));
          console.log("RAW SUMMARY OBJECT");
          console.log("=".repeat(60));
          console.log(JSON.stringify(summary, null, 2));
        }

        db.close();
      } catch (err) {
        console.error("Error:", err);
        process.exit(1);
      }
    });

  discoveriesCmd
    .command("list")
    .description("List all open discoveries")
    .option("-l, --limit <n>", "Maximum number to show", "20")
    .option("-p, --phase <phase>", "Filter by phase (exploration, implementation, verification)")
    .action(async (options: { limit: string; phase?: string }) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { initDatabase } = await import("../../db");
        const db = await initDatabase(dbPath);

        const discoveries = options.phase
          ? getDiscoveriesByPhase(db, options.phase, parseInt(options.limit, 10))
          : getOpenDiscoveries(db, parseInt(options.limit, 10));

        if (discoveries.length === 0) {
          console.log("No open discoveries found.");
          db.close();
          return;
        }

        console.log(`Open Discoveries (${discoveries.length}):\n`);

        for (const d of discoveries) {
          console.log(formatDiscovery(d));
          console.log();
        }

        db.close();
      } catch (err) {
        console.error("Error:", err);
        process.exit(1);
      }
    });

  discoveriesCmd
    .command("resolve <title>")
    .description("Resolve or dismiss a discovery by title match")
    .option("-r, --resolution <type>", "Resolution type: resolved or dismissed", "resolved")
    .option("--reason <reason>", "Reason for resolution", "Manually resolved via CLI")
    .action(async (title: string, options: { resolution: string; reason: string }) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { initDatabase } = await import("../../db");
        const db = await initDatabase(dbPath);

        const discovery = findDiscoveryByTitle(db, title);

        if (!discovery) {
          console.log(`No open discovery found matching: "${title}"`);
          db.close();
          return;
        }

        console.log(`Found discovery:`);
        console.log(`  ID: ${discovery.id}`);
        console.log(`  Title: ${discovery.title}`);
        console.log(`  Kind: ${discovery.kind}`);
        console.log(`  Severity: ${discovery.severity}`);
        console.log();

        const resolution = options.resolution === "dismissed" ? "dismissed" : "resolved";
        
        resolveDiscovery(db, discovery.id, resolution, options.reason, "cli");

        console.log(`Discovery marked as ${resolution}.`);
        console.log(`Reason: ${options.reason}`);

        db.close();
      } catch (err) {
        console.error("Error:", err);
        process.exit(1);
      }
    });

  discoveriesCmd
    .command("history")
    .description("Show resolved/dismissed discoveries")
    .option("-l, --limit <n>", "Maximum number to show", "20")
    .action(async (options: { limit: string }) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { initDatabase } = await import("../../db");
        const db = await initDatabase(dbPath);

        const discoveries = getResolvedDiscoveries(db, parseInt(options.limit, 10));

        if (discoveries.length === 0) {
          console.log("No resolved or dismissed discoveries found.");
          db.close();
          return;
        }

        console.log(`Resolved/Dismissed Discoveries (${discoveries.length}):\n`);

        for (const d of discoveries) {
          const status = d.status === "resolved" ? "[RESOLVED]" : "[DISMISSED]";
          const severity = `[${(d.severity || "info").toUpperCase()}]`;
          const reason = getResolutionReason(d.metadata);

          console.log(`${status} ${severity} ${d.kind}: ${d.title}`);
          console.log(`  Updated: ${d.updated_at}${reason ? `\n  Reason: ${reason}` : ""}`);
          console.log();
        }

        db.close();
      } catch (err) {
        console.error("Error:", err);
        process.exit(1);
      }
    });
}
