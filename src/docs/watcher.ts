/**
 * Documentation watcher backed by the workspace access boundary.
 *
 * Local development reads the local checkout. Split deployments poll the same
 * metadata through the API/NATS bridge, so filesystem I/O always occurs on the
 * Arm Host that owns the checkout.
 */

import { join } from "path";
import { LocalWorkspaceAccess, type WorkspaceAccess } from "../workspace";

export interface DocChangeEvent {
  type: "created" | "modified" | "deleted";
  path: string;
  relativePath: string;
  timestamp: Date;
  contentHash?: string;
  size: number;
}

export interface DocState {
  path: string;
  relativePath: string;
  contentHash: string;
  size: number;
  lastModified: Date;
  category: "architecture" | "guides" | "plans" | "requirements" | "decisions" | "other";
}

export type DocWatcherCallback = (event: DocChangeEvent) => void;

interface RankedDocState extends DocState {
  relevanceScore: number;
}

export class DocWatcher {
  private readonly docStates = new Map<string, DocState>();
  private readonly callbacks = new Set<DocWatcherCallback>();
  private readonly projectRoot: string;
  private readonly workspace: WorkspaceAccess;
  private pollInterval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(projectRoot: string, workspace?: WorkspaceAccess) {
    this.projectRoot = projectRoot;
    this.workspace = workspace || new LocalWorkspaceAccess(projectRoot);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log("[DocWatcher] Starting documentation watcher...");
    await this.refresh(false);
    this.pollInterval = setInterval(() => {
      void this.refresh(true).catch((error) => {
        console.log(`[DocWatcher] Poll failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 5000);
    console.log("[DocWatcher] Documentation watcher started");
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log("[DocWatcher] Documentation watcher stopped");
  }

  onChange(callback: DocWatcherCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  getState(): DocState[] {
    return Array.from(this.docStates.values());
  }

  getDocState(relativePath: string): DocState | undefined {
    return this.docStates.get(relativePath);
  }

  async hasChangesSince(timestamp: Date): Promise<DocChangeEvent[]> {
    return Array.from(this.docStates.values())
      .filter((state) => state.lastModified > timestamp)
      .map((state) => ({
        type: "modified" as const,
        path: state.path,
        relativePath: state.relativePath,
        timestamp: state.lastModified,
        contentHash: state.contentHash,
        size: state.size,
      }));
  }

  async findRelevantDocs(taskDescription: string): Promise<DocState[]> {
    const keywords = taskDescription.toLowerCase().split(/\s+/);
    const relevant: RankedDocState[] = [];
    for (const doc of this.docStates.values()) {
      const docText = doc.relativePath.toLowerCase();
      const relevanceScore = keywords.filter((keyword) => docText.includes(keyword)).length;
      if (relevanceScore > 0) relevant.push({ ...doc, relevanceScore });
    }
    relevant.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return relevant.slice(0, 5).map(({ relevanceScore: _relevanceScore, ...doc }) => doc);
  }

  async readDoc(relativePath: string): Promise<string | null> {
    const state = this.docStates.get(relativePath);
    if (!state) return null;
    return (await this.workspace.readText(`docs/${relativePath}`))?.content ?? null;
  }

  getCategories(): DocState["category"][] {
    return [...new Set(this.docStates.values().map((doc) => doc.category))];
  }

  /** Run one metadata poll immediately. Useful for deterministic callers and tests. */
  async checkForChanges(): Promise<void> {
    await this.refresh(true);
  }

  private async refresh(emitChanges: boolean): Promise<void> {
    const files = await this.workspace.scan(["docs/**/*.md", "docs/**/*.txt", "docs/**/*.rst"]);
    const next = new Map<string, DocState>();

    for (const file of files) {
      const relativePath = file.path.replace(/^docs\//, "");
      const state: DocState = {
        path: join(this.projectRoot, file.path),
        relativePath,
        contentHash: file.contentHash.slice(0, 16),
        size: file.size,
        lastModified: new Date(file.modifiedAt),
        category: this.categorizeDoc(relativePath),
      };
      next.set(relativePath, state);

      if (!emitChanges) continue;
      const previous = this.docStates.get(relativePath);
      if (!previous) {
        this.emit({
          type: "created",
          path: state.path,
          relativePath,
          timestamp: state.lastModified,
          contentHash: state.contentHash,
          size: state.size,
        });
      } else if (previous.contentHash !== state.contentHash) {
        this.emit({
          type: "modified",
          path: state.path,
          relativePath,
          timestamp: state.lastModified,
          contentHash: state.contentHash,
          size: state.size,
        });
      }
    }

    if (emitChanges) {
      for (const [relativePath, previous] of this.docStates) {
        if (!next.has(relativePath)) {
          this.emit({
            type: "deleted",
            path: previous.path,
            relativePath,
            timestamp: new Date(),
            size: 0,
          });
        }
      }
    }

    this.docStates.clear();
    for (const [path, state] of next) this.docStates.set(path, state);

    if (!emitChanges) {
      const categories = this.getCategories();
      if (this.docStates.size > 0) {
        console.log(`[DocWatcher] Tracking ${this.docStates.size} document(s) in ${categories.join(", ")}`);
      } else {
        console.log("[DocWatcher] No documents found, will poll for creation");
      }
    }
  }

  private emit(event: DocChangeEvent): void {
    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch (error) {
        console.log(`[DocWatcher] Callback error: ${error}`);
      }
    }
  }

  private categorizeDoc(relativePath: string): DocState["category"] {
    const first = relativePath.split("/")[0];
    if (first === "architecture") return "architecture";
    if (first === "guides") return "guides";
    if (first === "plans") return "plans";
    if (first === "requirements") return "requirements";
    if (first === "decisions") return "decisions";

    const lower = relativePath.toLowerCase();
    if (lower.includes("plan")) return "plans";
    if (lower.includes("requirement")) return "requirements";
    if (lower.includes("decision") || lower.includes("adr")) return "decisions";
    return "other";
  }
}

let instance: DocWatcher | null = null;

export function getDocWatcher(projectRoot: string, workspace?: WorkspaceAccess): DocWatcher {
  if (!instance) instance = new DocWatcher(projectRoot, workspace);
  return instance;
}

export function stopDocWatcher(): void {
  if (!instance) return;
  instance.stop();
  instance = null;
}
