import type { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { Command } from "commander";

import { BrainTemplateManager } from "../../brain/template-manager";
import { regenerateTasksFromPlan } from "../../brain/task-regenerator";
import { initDatabase } from "../../db";
import { LocalWorkspaceAccess } from "../../workspace";
import { getColeoDir } from "../context";

interface RegenerateOptions {
  explanation: string;
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.stack || error.message;
}

export function registerPlanCommands(program: Command): void {
  const planCmd = program.command("plan").description("Manage the canonical project plan");

  planCmd
    .command("regenerate")
    .description("Evaluate plan.md and replace every non-completed task with a verbose process log")
    .requiredOption("-e, --explanation <text>", "Explain why the task queue needs regeneration")
    .action(async (options: RegenerateOptions) => {
      const startedAt = Date.now();
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");
      const projectRoot = resolve(
        process.env.COLEO_PROJECT_DIR
          || process.env.COLEO_REMOTE_WORKDIR
          || process.cwd(),
      );
      const log = (message: string) => {
        const elapsed = ((Date.now() - startedAt) / 1_000).toFixed(3);
        console.log(`[+${elapsed}s] ${message}`);
      };

      console.log("Plan task regeneration");
      console.log(`  Project root: ${projectRoot}`);
      console.log(`  Coleo directory: ${coleoDir}`);
      console.log(`  Database: ${dbPath}`);
      console.log(`  Explanation: ${options.explanation.trim()}`);
      console.log("");

      let db: Database | undefined;
      try {
        log("Opening and migrating the task database");
        db = await initDatabase(dbPath);
        log("Database ready");
        const templates = new BrainTemplateManager(coleoDir, (message) => log(`Template: ${message}`));
        const result = await regenerateTasksFromPlan({
          db,
          workspace: new LocalWorkspaceAccess(projectRoot),
          explanation: options.explanation,
          templates,
          onProgress: log,
        });

        console.log("");
        console.log("Regeneration summary:");
        console.log(`  Formatter mode: ${result.mode}`);
        console.log(`  Deleted non-completed tasks: ${result.deletedCount}`);
        console.log(`  Created tasks: ${result.createdCount}`);
        console.log(`  Preserved completed tasks: ${result.preservedCompletedCount}`);
        console.log(`  Duration: ${((Date.now() - startedAt) / 1_000).toFixed(3)}s`);
      } catch (error) {
        console.error("");
        console.error("Plan regeneration failed:");
        console.error(errorDetail(error));
        process.exitCode = 1;
      } finally {
        db?.close();
      }
    });
}
