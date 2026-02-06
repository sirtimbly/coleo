/**
 * DocUpdateTracker - Tracks file changes and triggers documentation update tasks
 * 
 * Responsibilities:
 * - Track files changed since last doc update
 * - Check thresholds to trigger doc update tasks
 * - Provide context for doc update tasks (changed files, affected docs)
 * - Record doc update attempts for history
 */

import type { BrainDb } from "./db-client";
import { join } from "path";
import { readdir, readFile } from "fs/promises";
import fg from "fast-glob";

interface DocUpdateContext {
  filesChanged: string[];
  changedFilesCount: number;
  featureDocsToUpdate: string[];
  planDocument?: string;
}

export class DocUpdateTracker {
  private db: BrainDb;
  private coleoDir: string;
  private projectRoot: string;
  private pollCount: number = 0;

  constructor(db: BrainDb, coleoDir: string, projectRoot: string) {
    this.db = db;
    this.coleoDir = coleoDir;
    this.projectRoot = projectRoot;
  }

  /**
   * Get configuration for doc updates
   */
  private getConfig(): { fileThreshold: number; pollInterval: number; enabled: boolean } {
    const fileThreshold = this.db.query("SELECT value FROM config WHERE key = 'doc_update_file_threshold'").get() as { value: string } | undefined;
    const pollInterval = this.db.query("SELECT value FROM config WHERE key = 'doc_update_poll_interval'").get() as { value: string } | undefined;
    const enabled = this.db.query("SELECT value FROM config WHERE key = 'doc_update_enabled'").get() as { value: string } | undefined;

    return {
      fileThreshold: fileThreshold ? parseInt(fileThreshold.value, 10) : 10,
      pollInterval: pollInterval ? parseInt(pollInterval.value, 10) : 10,
      enabled: enabled ? enabled.value === "true" : true,
    };
  }

  /**
   * Get the timestamp of the last completed doc update
   * Uses config cache for performance, falls back to table query
   */
  async getLastDocUpdateTime(): Promise<Date | null> {
    // Try config first for fast access
    const configResult = this.db.query(`
      SELECT value FROM config WHERE key = 'last_doc_update'
    `).get() as { value: string } | undefined;

    if (configResult && configResult.value) {
      return new Date(configResult.value);
    }

    // Fallback to table query for backward compatibility
    const result = this.db.query(`
      SELECT completed_at FROM doc_updates
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `).get() as { completed_at: string } | undefined;

    return result ? new Date(result.completed_at) : null;
  }

  /**
   * Count files changed since last doc update
   */
  async countChangedFilesSince(lastUpdateTime: Date): Promise<number> {
    const result = this.db.query(`
      SELECT COUNT(*) as count FROM file_changes
      WHERE changed_at > ?
    `).get(lastUpdateTime.toISOString()) as { count: number };

    return result.count;
  }

  /**
   * Get files changed since last doc update
   */
  async getChangedFilesSince(lastUpdateTime: Date): Promise<string[]> {
    const results = this.db.query(`
      SELECT DISTINCT file_path FROM file_changes
      WHERE changed_at > ?
      ORDER BY changed_at DESC
    `).all(lastUpdateTime.toISOString()) as Array<{ file_path: string }>;

    return results.map(r => r.file_path);
  }

  /**
   * Find feature documentation files that may need updating
   * 
   * Feature docs are in docs/features/, docs/api/, docs/capabilities/
   * We do NOT update conceptual docs or architecture decisions
   */
  async findFeatureDocs(): Promise<string[]> {
    const patterns = [
      "docs/features/**/*.md",
      "docs/api/**/*.md",
      "docs/capabilities/**/*.md",
    ];

    const files: string[] = [];
    for (const pattern of patterns) {
      const matches = await fg(pattern, { cwd: this.projectRoot });
      files.push(...matches);
    }

    return files;
  }

  /**
   * Check if doc update should be triggered based on thresholds
   * Returns the trigger reason if triggered, null otherwise
   */
  async checkDocUpdateTrigger(): Promise<{ trigger: "threshold" | "periodic"; reason: string } | null> {
    if (!this.getConfig().enabled) {
      return null;
    }

    const lastUpdateTime = await this.getLastDocUpdateTime();
    const config = this.getConfig();

    // Check periodic trigger
    this.pollCount++;
    if (this.pollCount >= config.pollInterval) {
      this.pollCount = 0;
      return {
        trigger: "periodic",
        reason: `Periodic doc review after ${config.pollInterval} poll cycles`,
      };
    }

    // If no previous update, don't trigger on threshold
    if (!lastUpdateTime) {
      return null;
    }

    // Check file threshold
    const changedCount = await this.countChangedFilesSince(lastUpdateTime);
    if (changedCount >= config.fileThreshold) {
      return {
        trigger: "threshold",
        reason: `${changedCount} files changed since last doc update (threshold: ${config.fileThreshold})`,
      };
    }

    return null;
  }

  /**
   * Get context for a documentation update task
   */
  async getDocUpdateContext(): Promise<DocUpdateContext> {
    const lastUpdateTime = await this.getLastDocUpdateTime();
    const filesChanged = lastUpdateTime ? await this.getChangedFilesSince(lastUpdateTime) : [];
    const featureDocs = await this.findFeatureDocs();

    // Filter to only code files (not docs themselves)
    const codeFiles = filesChanged.filter(f => 
      !f.endsWith(".md") && !f.endsWith(".txt") && !f.includes("/docs/")
    );

    // Find which feature docs might be affected by changed files
    const affectedDocs = featureDocs.filter(doc => {
      const docLower = doc.toLowerCase();
      const changedLower = codeFiles.map(f => f.toLowerCase());
      
      // Simple matching: check if any changed file path contains doc keywords
      for (const changed of changedLower) {
        const pathParts = changed.split("/");
        for (const part of pathParts) {
          if (part.length > 3 && docLower.includes(part)) {
            return true;
          }
        }
      }
      return false;
    });

    // Find plan document for "future work" notes
    const planFiles = await fg(".project/plans/*.md", { cwd: this.projectRoot });
    const planDocument = planFiles[0];

    return {
      filesChanged: codeFiles,
      changedFilesCount: codeFiles.length,
      featureDocsToUpdate: affectedDocs,
      planDocument,
    };
  }

  /**
   * Create a doc update record
   */
  async createDocUpdate(
    taskId: string,
    triggerType: "phase_complete" | "threshold" | "human_request" | "periodic"
  ): Promise<string> {
    const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    
    this.db.run(`
      INSERT INTO doc_updates (id, task_id, trigger_type)
      VALUES (?, ?, ?)
    `, [id, taskId, triggerType]);

    return id;
  }

  /**
   * Mark doc update as started
   */
  startDocUpdate(id: string): void {
    this.db.run(`
      UPDATE doc_updates SET status = 'in_progress' WHERE id = ?
    `, [id]);
  }

  /**
   * Mark doc update as completed
   */
  completeDocUpdate(
    id: string,
    filesReviewed: number,
    docsUpdated: number,
    futureWorkNotesAdded: number
  ): void {
    const now = new Date().toISOString();
    this.db.run(`
      UPDATE doc_updates SET
        status = 'completed',
        completed_at = ?,
        files_reviewed = ?,
        docs_updated = ?,
        future_work_notes_added = ?
      WHERE id = ?
    `, [now, filesReviewed, docsUpdated, futureWorkNotesAdded, id]);

    // Update last_doc_update config for fast access
    this.db.run(`
      INSERT OR REPLACE INTO config (key, value, updated_at)
      VALUES ('last_doc_update', ?, ?)
    `, [now, now]);
  }

  /**
   * Mark doc update as failed
   */
  failDocUpdate(id: string, error: string): void {
    this.db.run(`
      UPDATE doc_updates SET 
        status = 'failed',
        completed_at = datetime('now'),
        metadata = ?
      WHERE id = ?
    `, [JSON.stringify({ error }), id]);
  }

  /**
   * Get recent doc update history
   */
  getRecentDocUpdates(limit: number = 10): Array<{
    id: string;
    triggerType: string;
    status: string;
    startedAt: string;
    completedAt?: string;
  }> {
    const results = this.db.query(`
      SELECT id, trigger_type, status, started_at, completed_at
      FROM doc_updates
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string;
      trigger_type: string;
      status: string;
      started_at: string;
      completed_at?: string;
    }>;

    return results.map(r => ({
      id: r.id,
      triggerType: r.trigger_type,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
  }

  /**
   * Generate "Future Work" note template for incomplete features
   */
  generateFutureWorkNote(
    featureName: string,
    planDescription: string,
    phase?: string
  ): string {
    let note = `## ${featureName}

**Status**: ${phase ? `Planned for ${phase}` : 'Planned'}
**Details**: ${planDescription}

_Note: This feature is planned but not yet implemented._`;

    return note;
  }

  /**
   * Generate partial implementation note template
   */
  generatePartialImplementationNote(
    featureName: string,
    implemented: string[],
    pending: string[]
  ): string {
    let note = `## ${featureName}

**Status**: Partial Implementation
**Implemented**: ${implemented.join(", ")}
**Pending**: ${pending.join(", ")}`;

    return note;
  }
}
