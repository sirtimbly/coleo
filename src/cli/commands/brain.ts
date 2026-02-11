import { Command } from "commander";
import { join } from "path";
import { readFile } from "fs/promises";
import { Brain } from "../../brain";
import { getColeoDir } from "../context";
import {
  startService,
  stopService,
  restartService,
  getServiceStatus,
  getServiceLogs,
  formatUptime,
} from "../../daemon";
import { createSqliteBrainDb } from "../../db/brain-db-adapter";

export function registerBrainCommands(program: Command): void {
  const brainCmd = program.command("brain").description("Manage the Coleo brain");

  brainCmd
    .command("run")
    .description("Run brain polling loop (foreground)")
    .option("-i, --interval <ms>", "Poll interval in milliseconds", "30000")
    .option("-v, --verbose", "Verbose output", false)
    .option("--once", "Run a single poll cycle and exit")
    .option("--clean", "Kill zombie/stale OpenCode processes before starting")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const interval = parseInt(options.interval, 10);
      const verbose = options.verbose ?? false;

      if (options.clean) {
        console.log("Cleaning up zombie OpenCode processes...");
        const { execSync } = await import("node:child_process");
        try {
          const pidsOutput = execSync(
            "ps aux | grep 'opencode.*serve' | grep -v grep | awk '{print $2}'",
            { encoding: "utf-8", cwd: process.cwd() },
          ).trim();
          const pids = pidsOutput.split("\n").filter((p: string) => p.length > 0);

          if (pids.length > 0) {
            execSync(`kill -9 ${pids.join(" ")} 2>/dev/null || true`, { cwd: process.cwd() });
            console.log(`Killed ${pids.length} stale process(es): ${pids.join(", ")}`);
          } else {
            console.log("No zombie processes found.");
          }
        } catch {
          console.log("No zombie processes found.");
        }
      }

      const brain = new Brain({
        coleoDir,
        pollIntervalMs: interval,
        verbose: verbose || true,
      });

      await brain.init();

      process.on("SIGINT", () => {
        console.log("\nShutting down brain...");
        brain.stop();
      });

      process.on("SIGTERM", () => {
        brain.stop();
      });

      if (options.once) {
        await brain.runOnce();
        await brain.shutdown();
      } else {
        await brain.run();
        await brain.shutdown();
      }
    });

  brainCmd
    .command("status")
    .description("Show brain status")
    .action(async () => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const content = await readFile(join(coleoDir, "state", "brain.json"), "utf-8");
        const state = JSON.parse(content);

        let activeArmsCount = 0;
        let pendingTasksCount = 0;
        try {
          const { Database } = await import("bun:sqlite");
          const db = new Database(dbPath, { readonly: true });
          const armsResult = db
            .query("SELECT COUNT(*) as count FROM arms WHERE status NOT IN ('stopped')")
            .get();
          activeArmsCount = (armsResult as { count: number })?.count || 0;

          const tasksResult = db
            .query("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'")
            .get();
          pendingTasksCount = (tasksResult as { count: number })?.count || 0;
          db.close();
        } catch {
          // Database might not exist yet
        }

        console.log("Brain Status:");
        console.log(`  Status: ${state.status || "unknown"}`);
        console.log(`  Last poll: ${state.lastPollAt || "never"}`);
        console.log(`  Poll interval: ${state.pollIntervalMs || 30000}ms`);
        console.log(`  Active arms: ${activeArmsCount}`);
        console.log(`  Pending tasks: ${pendingTasksCount}`);
        console.log(`  Completed today: ${state.completedToday || 0}`);
      } catch {
        // Check if brain daemon is running
        const daemonStatus = await getServiceStatus("brain");
        if (daemonStatus.running) {
          console.log("Brain Status:");
          console.log(`  Daemon: running (PID: ${daemonStatus.pid})`);
          console.log(`  Started: ${daemonStatus.startedAt}`);
          console.log(`  Uptime: ${formatUptime(daemonStatus.uptime || 0)}`);
        } else {
          console.log("Brain has not been started yet.");
          console.log("Run: coleo brain run    (foreground)");
          console.log("  or: coleo brain start  (background daemon)");
        }
      }
    });

  // Start brain daemon in background
  brainCmd
    .command("start")
    .description("Start the brain daemon in the background")
    .option("--self-modify", "Require COLEO_SELF_MODIFY env var (for arm access)")
    .action(async (options) => {
      try {
        const status = await startService("brain", {
          requireSelfModify: options.selfModify,
        });
        if (status.running) {
          console.log(`Brain started (PID: ${status.pid})`);
        }
      } catch (err) {
        console.error(`Failed to start brain: ${err}`);
        process.exit(1);
      }
    });

  // Stop brain daemon
  brainCmd
    .command("stop")
    .description("Stop the brain daemon")
    .option("-f, --force", "Force kill if graceful shutdown fails")
    .option("-t, --timeout <ms>", "Timeout for graceful shutdown", "5000")
    .option("--self-modify", "Require COLEO_SELF_MODIFY env var (for arm access)")
    .action(async (options) => {
      try {
        const status = await stopService("brain", {
          requireSelfModify: options.selfModify,
          force: options.force,
          timeout: parseInt(options.timeout, 10),
        });
        if (!status.running) {
          console.log("Brain stopped");
        } else {
          console.log(`Brain still running (PID: ${status.pid})`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to stop brain: ${err}`);
        process.exit(1);
      }
    });

  // Restart brain daemon
  brainCmd
    .command("restart")
    .description("Restart the brain daemon")
    .option("-f, --force", "Force kill if graceful shutdown fails")
    .option("-t, --timeout <ms>", "Timeout for graceful shutdown", "5000")
    .option("--self-modify", "Require COLEO_SELF_MODIFY env var (for arm access)")
    .action(async (options) => {
      try {
        const status = await restartService("brain", {
          requireSelfModify: options.selfModify,
          force: options.force,
          timeout: parseInt(options.timeout, 10),
        });
        if (status.running) {
          console.log(`Brain restarted (PID: ${status.pid})`);
        } else {
          console.error("Failed to restart brain");
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to restart brain: ${err}`);
        process.exit(1);
      }
    });

  // Logs
  brainCmd
    .command("logs")
    .description("Show brain daemon logs")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .action(async (options) => {
      const lines = await getServiceLogs("brain", parseInt(options.lines, 10));
      if (lines.length === 0) {
        console.log("No logs found");
      } else {
        console.log(lines.join("\n"));
      }
    });

  brainCmd
    .command("prompt:task")
    .description("Show what task the brain would determine next (for copying to agent)")
    .action(async () => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");
      const { Database } = await import("bun:sqlite");

      try {
        const db = new Database(dbPath);
        const brainDb = createSqliteBrainDb(db);
        const { generateTaskDetermination, formatTaskDetermination } = await import("../../brain/prompt-generator");

        const result = await generateTaskDetermination({
          projectRoot: process.cwd(),
          coleoDir,
          db: brainDb,
        });

        console.log(formatTaskDetermination(result));
        db.close();
      } catch (err) {
        console.error("Error determining task:", err);
        process.exit(1);
      }
    });

  brainCmd
    .command("prompt:context")
    .description("Show context bundle for a task (for copying to agent)")
    .argument("[task-id-or-subject]", "Task ID or subject to generate context for")
    .action(async (taskIdOrSubject) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");
      const { Database } = await import("bun:sqlite");

      try {
        const db = new Database(dbPath);
        const brainDb = createSqliteBrainDb(db);
        const { generateContextBundle, formatContextBundle } = await import("../../brain/prompt-generator");

        const taskInput = taskIdOrSubject || "next";

        let taskSubject = taskInput;
        if (taskInput === "next") {
          const pendingTask = db
            .query(`
              SELECT subject FROM tasks
              WHERE status = 'pending'
              ORDER BY 
                CASE priority 
                  WHEN 'critical' THEN 1 
                  WHEN 'high' THEN 2 
                  WHEN 'normal' THEN 3 
                  WHEN 'low' THEN 4 
                END,
                created_at ASC
              LIMIT 1
            `)
            .get() as { subject: string } | undefined;

          if (pendingTask) {
            taskSubject = pendingTask.subject;
          } else {
            console.log("No pending tasks found. Please specify a task ID or subject.");
            db.close();
            process.exit(1);
          }
        }

        const result = await generateContextBundle(
          {
            projectRoot: process.cwd(),
            coleoDir,
            db: brainDb,
          },
          taskSubject,
        );

        if (result) {
          console.log(formatContextBundle(result));
        } else {
          console.log(`Task not found: ${taskSubject}`);
          console.log("\nAvailable tasks:");
          const tasks = db
            .query(`
              SELECT id, subject, status, priority FROM tasks
              WHERE status IN ('pending', 'in_progress')
              ORDER BY 
                CASE priority 
                  WHEN 'critical' THEN 1 
                  WHEN 'high' THEN 2 
                  WHEN 'normal' THEN 3 
                  WHEN 'low' THEN 4 
                END
              LIMIT 10
            `)
            .all() as Array<{ id: string; subject: string; status: string; priority: string }>;

          for (const task of tasks) {
            console.log(`  - ${task.id}: ${task.subject} [${task.priority}]`);
          }
        }

        db.close();
      } catch (err) {
        console.error("Error generating context:", err);
        process.exit(1);
      }
    });
}
