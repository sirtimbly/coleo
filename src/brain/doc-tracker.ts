/**
 * DocUpdateTracker - Tracks file changes and triggers documentation update tasks
 * 
 * Responsibilities:
 * - Track files changed since last doc update
 * - Check thresholds to trigger doc update tasks
 * - Provide context for doc update tasks (changed files, affected docs)
 * - Record doc update attempts for history
 */

import { join } from "path";
import { readdir, readFile } from "fs/promises";
import fg from "fast-glob";
import { loadConfig } from "../config";

interface DocUpdateContext {
  filesChanged: string[];
  changedFilesCount: number;
  featureDocsToUpdate: string[];
  planDocument?: string;
}

export class DocUpdateTracker {
  private apiBaseUrl: string;
  private apiKey: string;
  private coleoDir: string;
  private projectRoot: string;
  private pollCount: number = 0;

  constructor(
    apiBaseUrl: string,
    apiKey: string,
    coleoDir: string,
    projectRoot: string,
  ) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.coleoDir = coleoDir;
    this.projectRoot = projectRoot;
  }

  private async apiRequest<T>(path: string, options: RequestInit = {}): Promise<T | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          ...options.headers,
        },
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  /**
   * Get configuration for doc updates
   */
  private async getConfig(): Promise<{ fileThreshold: number; pollInterval: number; enabled: boolean }> {
    const config = await loadConfig(this.coleoDir);
    return {
      fileThreshold: config.docs.updateFileThreshold,
      pollInterval: config.docs.updatePollInterval,
      enabled: config.docs.updateEnabled,
    };
  }

  /**
   * Get the timestamp of the last completed doc update
   */
  async getLastDocUpdateTime(): Promise<Date | null> {
    const response = await this.apiRequest<{ completedAt?: string | null }>(
      "/api/brain/internal/doc-updates/last-completed",
    );
    return response?.completedAt ? new Date(response.completedAt) : null;
  }

  /**
   * Count files changed since last doc update
   */
  async countChangedFilesSince(lastUpdateTime: Date): Promise<number> {
    const params = new URLSearchParams({ since: lastUpdateTime.toISOString() });
    const response = await this.apiRequest<{ count?: number }>(
      `/api/brain/internal/file-changes/count?${params.toString()}`,
    );
    return response?.count ?? 0;
  }

  /**
   * Get files changed since last doc update
   */
  async getChangedFilesSince(lastUpdateTime: Date): Promise<string[]> {
    const params = new URLSearchParams({ since: lastUpdateTime.toISOString() });
    const response = await this.apiRequest<{ files?: string[] }>(
      `/api/brain/internal/file-changes/since?${params.toString()}`,
    );
    return response?.files || [];
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
    const config = await this.getConfig();
    if (!config.enabled) {
      return null;
    }

    const lastUpdateTime = await this.getLastDocUpdateTime();

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

    await this.apiRequest<{ created?: boolean }>(
      "/api/brain/internal/doc-updates",
      {
        method: "POST",
        body: JSON.stringify({ id, taskId, triggerType }),
      },
    );
    return id;
  }

  /**
   * Mark doc update as started
   */
  async startDocUpdate(id: string): Promise<void> {
    await this.apiRequest<{ success?: boolean }>(
      `/api/brain/internal/doc-updates/${encodeURIComponent(id)}/start`,
      { method: "POST" },
    );
  }

  /**
   * Mark doc update as completed
   */
  async completeDocUpdate(
    id: string,
    filesReviewed: number,
    docsUpdated: number,
    futureWorkNotesAdded: number
  ): Promise<void> {
    await this.apiRequest<{ success?: boolean }>(
      `/api/brain/internal/doc-updates/${encodeURIComponent(id)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ filesReviewed, docsUpdated, futureWorkNotesAdded }),
      },
    );
  }

  /**
   * Mark doc update as failed
   */
  async failDocUpdate(id: string, error: string): Promise<void> {
    await this.apiRequest<{ success?: boolean }>(
      `/api/brain/internal/doc-updates/${encodeURIComponent(id)}/fail`,
      {
        method: "POST",
        body: JSON.stringify({ error }),
      },
    );
  }

  /**
   * Get recent doc update history
   */
  async getRecentDocUpdates(limit: number = 10): Promise<Array<{
    id: string;
    triggerType: string;
    status: string;
    startedAt: string;
    completedAt?: string;
  }>> {
    const params = new URLSearchParams({ limit: String(limit) });
    const response = await this.apiRequest<{
      updates?: Array<{
        id: string;
        triggerType: string;
        status: string;
        startedAt: string;
        completedAt?: string;
      }>;
    }>(`/api/brain/internal/doc-updates/recent?${params.toString()}`);
    return response?.updates || [];
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
