import { Command } from "commander";
import { join } from "path";
import { getColeoDir } from "../context";

export function registerTasksCommands(program: Command): void {
  const tasksCmd = program.command("tasks").description("Manage tasks");

  tasksCmd
    .command("sync")
    .description("Sync tasks from project plan files (.project/plan.md)")
    .option("-v, --verbose", "Show detailed output", false)
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath, { readwrite: true });

        const autoDiscover = db.query("SELECT value FROM config WHERE key = ?").get("task_auto_discover") as {
          value: string;
        } | null;
        if (!autoDiscover) {
          db.run("INSERT INTO config (key, value) VALUES (?, ?)", ["task_auto_discover", "true"]);
        }

        const { findPlanFiles, parsePlanFile, tasksToDatabaseFormat } = await import("../../brain/plan-parser");

        const projectRoot = process.cwd();
        const planFiles = await findPlanFiles(projectRoot);

        if (planFiles.length === 0) {
          console.log("No plan files found.");
          console.log("Expected: .project/plan.md (and any .project links it references)");
          db.close();
          return;
        }

        console.log(`Found ${planFiles.length} plan file(s):`);
        for (const f of planFiles) {
          console.log(`  - ${f}`);
        }
        console.log("");

        let newTasksCount = 0;
        let updatedTasksCount = 0;
        let skippedCount = 0;

        for (const filePath of planFiles) {
          const result = await parsePlanFile(filePath);

          if (result.errors.length > 0) {
            console.log(`Parse errors in ${filePath}:`);
            for (const err of result.errors) {
              console.log(`  - ${err}`);
            }
            continue;
          }

          const existingFile = db.query("SELECT id, last_hash FROM plan_files WHERE file_path = ?").get(filePath) as
            | { id: number; last_hash: string }
            | undefined;

          if (existingFile?.last_hash === result.fileHash) {
            skippedCount++;
            if (options.verbose) {
              console.log(`  Skipped (unchanged): ${filePath}`);
            }
            continue;
          }

          console.log(`Processing: ${filePath}`);
          console.log(`  Found ${result.tasks.length} task(s), ${result.phases.length} phase(s)`);

          const dbTasks = tasksToDatabaseFormat(result.tasks);

          for (const task of dbTasks) {
            const existing = db.query("SELECT id, status FROM tasks WHERE id = ?").get(task.id) as
              | { id: string; status: string }
              | undefined;

            if (!existing) {
              db.run(
                `
                INSERT INTO tasks (id, subject, description, status, priority, source_type, source_ref, phase, tags, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
                [
                  task.id,
                  task.subject,
                  task.description,
                  task.status,
                  task.priority,
                  task.source_type,
                  task.source_ref,
                  task.phase,
                  task.tags,
                  task.metadata,
                ],
              );
              newTasksCount++;
              if (options.verbose) {
                console.log(`    + Added: ${task.subject}`);
              }
            } else if (existing.status === "pending" && task.status === "completed") {
              db.run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
                task.status,
                new Date().toISOString(),
                task.id,
              ]);
              updatedTasksCount++;
              if (options.verbose) {
                console.log(`    ~ Updated: ${task.subject} (marked complete)`);
              }
            }
          }

          const now = new Date().toISOString();
          if (existingFile) {
            db.run("UPDATE plan_files SET last_parsed_at = ?, last_hash = ?, updated_at = ? WHERE id = ?", [
              now,
              result.fileHash,
              now,
              existingFile.id,
            ]);
          } else {
            db.run("INSERT INTO plan_files (file_path, last_parsed_at, last_hash, updated_at) VALUES (?, ?, ?, ?)", [
              filePath,
              now,
              result.fileHash,
              now,
            ]);
          }
        }

        console.log("\nTask Sync Summary:");
        console.log(`  New tasks: ${newTasksCount}`);
        console.log(`  Updated: ${updatedTasksCount}`);
        console.log(`  Unchanged: ${skippedCount}`);
        console.log(`  Total plan files: ${planFiles.length}`);

        db.close();
      } catch (err) {
        console.error(`Failed to sync tasks: ${err}`);
        process.exit(1);
      }
    });

  tasksCmd
    .command("list")
    .description("List tasks in database")
    .option("-s, --status <status>", "Filter by status (pending, claimed, completed)")
    .option("-n, --limit <n>", "Limit results", "20")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath, { readonly: true });

        let query = "SELECT id, subject, status, priority, phase FROM tasks";
        const params: string[] = [];

        if (options.status) {
          query += " WHERE status = ?";
          params.push(options.status);
        }

        query += " ORDER BY created_at DESC LIMIT ?";
        params.push(options.limit);

        const rows = db.query(query).all(...params) as Array<{
          id: string;
          subject: string;
          status: string;
          priority: string;
          phase: string | null;
        }>;

        if (rows.length === 0) {
          console.log("No tasks found.");
          console.log("Run 'coleo tasks sync' to import from plan files.");
          db.close();
          return;
        }

        console.log("Tasks:");

        const headers = ["Status", "Priority", "Subject", "Phase", "ID"];
        const SUBJECT_MAX_WIDTH = 50;

        const tableRows = rows.map((row) => {
          const statusIcon =
            row.status === "pending"
              ? "○"
              : row.status === "claimed"
                ? "◐"
                : row.status === "in_progress"
                  ? "◑"
                  : "●";
          const priorityIcon =
            row.priority === "critical"
              ? "🔴"
              : row.priority === "high"
                ? "🟠"
                : row.priority === "low"
                  ? "🔵"
                  : "⚪";
          // Truncate subject if too long
          const subject = row.subject.length > SUBJECT_MAX_WIDTH
            ? row.subject.slice(0, SUBJECT_MAX_WIDTH - 3) + "..."
            : row.subject;
          return [
            `${statusIcon} ${row.status}`,
            `${priorityIcon} ${row.priority}`,
            subject,
            row.phase || "-",
            row.id,
          ];
        });

        const colWidths: number[] = headers.map((header, idx) => {
          const cells = tableRows.map((row) => row[idx] ?? "");
          const maxCellLength = cells.length > 0 ? Math.max(...cells.map((cell) => cell.length)) : 0;
          // Cap subject column width
          if (idx === 2) {
            return Math.max(header.length, Math.min(maxCellLength, SUBJECT_MAX_WIDTH));
          }
          return Math.max(header.length, maxCellLength);
        });

        const formatRow = (row: string[]) =>
          row
            .map((cell, idx) => {
              const width = colWidths[idx] ?? (headers[idx] ? headers[idx].length : 0);
              return (cell ?? "").padEnd(width);
            })
            .join("  ");

        console.log(formatRow(headers));
        console.log(colWidths.map((w) => "-".repeat(w)).join("  "));
        for (const row of tableRows) {
          console.log(formatRow(row));
        }

        db.close();
      } catch {
        console.log("No task database found.");
        console.log("Start the API server or run 'coleo tasks sync'.");
        }
      });

  tasksCmd
    .command("unclaim")
    .description("Reset claimed or in-progress tasks back to pending for testing")
    .action(async () => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { initDatabase } = await import("../../db");
        const db = await initDatabase(dbPath);
        const now = new Date().toISOString();
        const result = db.run(
          "UPDATE tasks SET status = 'pending', assigned_to = NULL, claimed_at = NULL, started_at = NULL, updated_at = ? WHERE status IN ('claimed', 'in_progress')",
          [now],
        );
        db.close();
        console.log(`Unclaimed ${result.changes ?? 0} task(s)`);
      } catch (err) {
        console.error(`Failed to unclaim tasks: ${err}`);
        process.exit(1);
      }
    });

  tasksCmd
    .command("reparse")
    .description("Clear plan-sourced tasks and reimport from plan.md files")
    .option("-v, --verbose", "Show detailed output", false)
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath, { readwrite: true });

        // First, delete all tasks sourced from plan.md (keeps manually created tasks)
        const deleteResult = db.run("DELETE FROM tasks WHERE source_type = 'plan'");
        const deletedCount = deleteResult.changes ?? 0;
        console.log(`Deleted ${deletedCount} plan-sourced task(s)`);

        // Also clear plan_files tracking so they get re-parsed
        db.run("DELETE FROM plan_files");
        console.log("Cleared plan file tracking");

        db.close();

        // Now run sync to reimport
        console.log("");
        console.log("Reparsing plan files...");

        // Re-run the sync logic
        const { findPlanFiles, parsePlanFile, tasksToDatabaseFormat } = await import("../../brain/plan-parser");

        const projectRoot = process.cwd();
        const planFiles = await findPlanFiles(projectRoot);

        if (planFiles.length === 0) {
          console.log("No plan files found.");
          return;
        }

        const db2 = new Database(dbPath, { readwrite: true });
        let newTasksCount = 0;

        for (const filePath of planFiles) {
          const result = await parsePlanFile(filePath);

          if (result.errors.length > 0) {
            console.log(`Parse errors in ${filePath}:`);
            for (const err of result.errors) {
              console.log(`  - ${err}`);
            }
            continue;
          }

          console.log(`Processing: ${filePath}`);
          console.log(`  Found ${result.tasks.length} task(s), ${result.phases.length} phase(s)`);

          const dbTasks = tasksToDatabaseFormat(result.tasks);

          for (const task of dbTasks) {
            const existing = db2.query("SELECT id, status FROM tasks WHERE id = ?").get(task.id) as
              | { id: string; status: string }
              | undefined;

            if (!existing) {
              db2.run(
                `
                INSERT INTO tasks (id, subject, description, status, priority, source_type, source_ref, phase, tags, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
                [
                  task.id,
                  task.subject,
                  task.description,
                  task.status,
                  task.priority,
                  task.source_type,
                  task.source_ref,
                  task.phase,
                  task.tags,
                  task.metadata,
                ],
              );
              newTasksCount++;
              if (options.verbose) {
                console.log(`    + Added: ${task.subject}`);
              }
            }
          }

          const now = new Date().toISOString();
          db2.run("INSERT INTO plan_files (file_path, last_parsed_at, last_hash, updated_at) VALUES (?, ?, ?, ?)", [
            filePath,
            now,
            result.fileHash,
            now,
          ]);
        }

      console.log("\nReparse Summary:");
      console.log(`  Deleted: ${deletedCount} plan-sourced tasks`);
      console.log(`  Imported: ${newTasksCount} new task(s)`);
      console.log(`  Plan files: ${planFiles.length}`);

      db2.close();
    } catch (err) {
      console.error(`Failed to reparse tasks: ${err}`);
      process.exit(1);
    }
  });

  tasksCmd
    .command("discuss <taskId> <message>")
    .description("Add a comment to a task discussion")
    .option("-r, --reply-to <commentId>", "Reply to a specific comment")
    .action(async (taskId, message, options) => {
      const apiUrl = process.env.COLEO_API_URL || `http://localhost:8080`;
      const apiKey = process.env.COLEO_API_KEY || "";

      // Get author info from git config or env
      let authorId = process.env.USER || "unknown";
      let authorName = process.env.USER || "CLI User";
      try {
        const { execSync } = await import("child_process");
        const gitEmail = execSync("git config user.email", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
        const gitName = execSync("git config user.name", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
        if (gitEmail) authorId = gitEmail;
        if (gitName) authorName = gitName;
      } catch {
        // Git config not available, use defaults
      }

      try {
        const response = await fetch(`${apiUrl}/api/tasks/${taskId}/discussions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          body: JSON.stringify({
            content: message,
            parentId: options.replyTo,
            authorType: "human",
            authorId,
            authorName,
            client: "cli",
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
          console.error(`Failed to add comment: ${errorData.error || response.statusText}`);
          process.exit(1);
        }

        const result = await response.json() as { comment: { id: string } };
        console.log(`Comment added: ${result.comment.id}`);
      } catch (err) {
        console.error(`Failed to add comment: ${err}`);
        process.exit(1);
      }
    });

  tasksCmd
    .command("discussions <taskId>")
    .description("Show task discussions")
    .option("-n, --limit <n>", "Number of comments to show", "20")
    .option("--json", "Output as JSON")
    .action(async (taskId, options) => {
      const apiUrl = process.env.COLEO_API_URL || `http://localhost:8080`;
      const apiKey = process.env.COLEO_API_KEY || "";

      try {
        const response = await fetch(
          `${apiUrl}/api/tasks/${taskId}/discussions?limit=${options.limit}`,
          {
            headers: {
              "X-API-Key": apiKey,
            },
          }
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
          console.error(`Failed to fetch discussions: ${errorData.error || response.statusText}`);
          process.exit(1);
        }

        const result = await response.json() as {
          discussions: Array<{
            id: string;
            createdAt: string;
            authorName?: string;
            authorId: string;
            edited: boolean;
            parentId?: string;
            content: string;
          }>;
          totalCount: number;
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.discussions.length === 0) {
          console.log("No discussions yet.");
          return;
        }

        console.log(`Discussions (${result.totalCount} total):\n`);

        for (const comment of result.discussions) {
          const date = new Date(comment.createdAt).toLocaleString();
          const author = comment.authorName || comment.authorId;
          const edited = comment.edited ? " (edited)" : "";
          const replyPrefix = comment.parentId ? "  ↳ " : "";

          console.log(`${replyPrefix}[${date}] ${author}${edited}:`);
          console.log(`${replyPrefix}  ${comment.content}`);
          console.log();
        }
      } catch (err) {
        console.error(`Failed to fetch discussions: ${err}`);
        process.exit(1);
      }
    });
}
