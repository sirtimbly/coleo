import { join } from "node:path";
import { findPlanFiles, parsePlanFile, tasksToDatabaseFormat } from "../../brain/plan-parser";
import type { Database } from "bun:sqlite";
import type { WorkspaceAccess } from "../../workspace";

export interface MaintenanceResult {
  schemaVersion: 1;
  kind: "module.maintenance";
  module: "tasks";
  operation: "sync" | "reparse" | "unclaim";
  workspace: string | null;
  added: number;
  updated: number;
  deleted: number;
  unclaimed: number;
  skipped: number;
  files: Array<{ path: string; tasks: number; phases: number; skipped: boolean }>;
  errors: string[];
}

export async function maintainTasks(
  db: Database,
  operation: MaintenanceResult["operation"],
  workspace?: WorkspaceAccess,
): Promise<MaintenanceResult> {
  const result: MaintenanceResult = {
    schemaVersion: 1, kind: "module.maintenance", module: "tasks", operation,
    workspace: workspace?.root ?? null, added: 0, updated: 0, deleted: 0,
    unclaimed: 0, skipped: 0, files: [], errors: [],
  };
  if (operation === "unclaim") {
    db.run(`UPDATE tasks SET status = 'pending', assigned_to = NULL,
      claimed_at = NULL, started_at = NULL, updated_at = ? WHERE status IN ('claimed', 'in_progress')`,
    [new Date().toISOString()]);
    result.unclaimed = (db.query("SELECT changes() AS count").get() as { count: number }).count;
    return result;
  }
  if (!workspace) throw new Error("Workspace is required for plan maintenance");
  // Explicit read propagates remote workspace failures which discovery treats as missing files.
  if (!await workspace.readText(join(workspace.root, ".project", "plan.md"))) {
    result.errors.push("No .project/plan.md found in the server workspace");
    return result;
  }
  const paths = await findPlanFiles(workspace.root, workspace);
  const parsed = await Promise.all(paths.map(async (path) => ({ path, plan: await parsePlanFile(path, workspace) })));
  for (const { path, plan } of parsed) {
    result.errors.push(...plan.errors.map((error) => `${path}: ${error}`));
  }
  if (!parsed.length) result.errors.push("No plan files found in the server workspace");
  // Do not clear stored tasks until every replacement plan has parsed successfully.
  if (operation === "reparse" && result.errors.length) return result;
  db.transaction(() => {
    if (operation === "reparse") {
      db.run("DELETE FROM tasks WHERE source_type = 'plan'");
      result.deleted = (db.query("SELECT changes() AS count").get() as { count: number }).count;
      db.run("DELETE FROM plan_files");
    } else {
      db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('task_auto_discover', 'true')");
    }
    for (const { path, plan } of parsed) {
      if (plan.errors.length) continue;
      const existingFile = db.query("SELECT id, last_hash FROM plan_files WHERE file_path = ?").get(path) as
        { id: number; last_hash: string } | null;
      const skipped = existingFile?.last_hash === plan.fileHash;
      result.files.push({ path, tasks: plan.tasks.length, phases: plan.phases.length, skipped });
      if (skipped) { result.skipped++; continue; }
      for (const task of tasksToDatabaseFormat(plan.tasks)) {
        const existing = db.query("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status: string } | null;
        if (!existing) {
          db.run(`INSERT INTO tasks
            (id, subject, description, status, priority, source_type, source_ref, phase, tags, metadata, plan_line_uid)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [task.id, task.subject, task.description, task.status, task.priority, task.source_type,
            task.source_ref, task.phase, task.tags, task.metadata, task.plan_line_uid ?? null]);
          result.added++;
        } else if (operation === "sync" && existing.status === "pending" && task.status === "completed") {
          db.run("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?", [new Date().toISOString(), task.id]);
          result.updated++;
        }
      }
      const now = new Date().toISOString();
      if (existingFile) {
        db.run("UPDATE plan_files SET last_parsed_at = ?, last_hash = ?, updated_at = ? WHERE id = ?",
          [now, plan.fileHash, now, existingFile.id]);
      } else {
        db.run("INSERT INTO plan_files (file_path, last_parsed_at, last_hash, updated_at) VALUES (?, ?, ?, ?)",
          [path, now, plan.fileHash, now]);
      }
    }
  })();
  return result;
}
