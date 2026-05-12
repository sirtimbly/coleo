/**
 * Documentation Watcher Service
 * 
 * Monitors the docs/ directory for changes and notifies the brain
 * when documentation is updated. This enables arms to stay in sync
 * with project requirements, plans, and architectural decisions.
 */

import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { readFile, stat, readdir } from "fs/promises";

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
  private watchers: Map<string, FSWatcher> = new Map();
  private docStates: Map<string, DocState> = new Map();
  private callbacks: Set<DocWatcherCallback> = new Set();
  private projectRoot: string;
  private docsPath: string;
  private pollInterval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.docsPath = join(projectRoot, "docs");
  }

  /**
   * Start watching the docs/ directory
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log("[DocWatcher] Starting documentation watcher...");

    // First, scan and hash all existing docs
    await this.scanDocs();

    // Set up file system watchers
    await this.setupWatchers();

    // Fallback polling every 5 seconds (for network drives, editors with atomic saves, etc.)
    this.pollInterval = setInterval(() => this.pollChanges(), 5000);

    console.log("[DocWatcher] Documentation watcher started");
  }

  /**
   * Stop watching
   */
  stop(): void {
    this.running = false;

    // Close all watchers
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    // Clear poll interval
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    console.log("[DocWatcher] Documentation watcher stopped");
  }

  /**
   * Register a callback for doc change events
   */
  onChange(callback: DocWatcherCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /**
   * Get current state of all tracked documents
   */
  getState(): DocState[] {
    return Array.from(this.docStates.values());
  }

  /**
   * Get a specific document's state
   */
  getDocState(relativePath: string): DocState | undefined {
    return this.docStates.get(relativePath);
  }

  /**
   * Check if documentation has changed since a given timestamp
   */
  async hasChangesSince(timestamp: Date): Promise<DocChangeEvent[]> {
    const changes: DocChangeEvent[] = [];

    for (const [path, state] of this.docStates) {
      if (state.lastModified > timestamp) {
        changes.push({
          type: "modified",
          path: state.path,
          relativePath: state.relativePath,
          timestamp: state.lastModified,
          contentHash: state.contentHash,
          size: state.size,
        });
      }
    }

    return changes;
  }

  /**
   * Find documents relevant to a task/description
   */
  async findRelevantDocs(taskDescription: string): Promise<DocState[]> {
    const keywords = taskDescription.toLowerCase().split(/\s+/);
    const relevant: RankedDocState[] = [];

    for (const doc of this.docStates.values()) {
      const docText = doc.relativePath.toLowerCase();
      const score = keywords.filter(k => docText.includes(k)).length;

      if (score > 0) {
        relevant.push({ ...doc, relevanceScore: score });
      }
    }

    // Sort by relevance score
    relevant.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return relevant.slice(0, 5).map(({ relevanceScore, ...doc }) => doc); // Return top 5 most relevant
  }

  /**
   * Read document content
   */
  async readDoc(relativePath: string): Promise<string | null> {
    const state = this.docStates.get(relativePath);
    if (!state) return null;

    try {
      return await readFile(state.path, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Get document categories
   */
  getCategories(): DocState["category"][] {
    return [...new Set(this.docStates.values().map((d) => d.category))];
  }

  /**
   * Scan all documents and build initial state
   */
  private async scanDocs(): Promise<void> {
    try {
      await this.scanDirectory(this.docsPath, "");
      // Log summary after scan
      const categories = this.getCategories();
      const docCount = this.docStates.size;
      if (docCount > 0) {
        console.log(`[DocWatcher] Tracking ${docCount} document(s) in ${categories.join(", ")}`);
      } else {
        console.log("[DocWatcher] No documents found, will watch for creation");
      }
    } catch {
      console.log("[DocWatcher] No docs/ directory found, will watch for creation");
    }
  }

  /**
   * Recursively scan a directory
   */
  private async scanDirectory(dir: string, baseRelPath: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = baseRelPath ? `${baseRelPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath, relPath);
      } else if (entry.isFile() && this.isDocFile(entry.name)) {
        await this.addDoc(fullPath, relPath);
      }
    }
  }

  /**
   * Add a document to tracking
   */
  private async addDoc(fullPath: string, relativePath: string): Promise<void> {
    try {
      const content = await readFile(fullPath, "utf-8");
      const stats = await stat(fullPath);
      const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      const category = this.categorizeDoc(relativePath);

      const state: DocState = {
        path: fullPath,
        relativePath,
        contentHash,
        size: stats.size,
        lastModified: stats.mtime,
        category,
      };

      this.docStates.set(relativePath, state);
    } catch {
      // Silently skip files we can't read
    }
  }

  /**
   * Set up file system watchers
   */
  private async setupWatchers(): Promise<void> {
    try {
      const watcher = watch(this.docsPath, { recursive: true }, (event, filename) => {
        if (!filename) return;
        this.handleFileEvent(event as "rename" | "change", filename);
      });
      this.watchers.set(this.docsPath, watcher);
    } catch (err) {
      console.log("[DocWatcher] Cannot use native fs.watch, will rely on polling");
    }
  }

  /**
   * Handle file system events
   */
  private async handleFileEvent(event: "rename" | "change", filename: string): Promise<void> {
    const fullPath = join(this.docsPath, filename);
    const relativePath = filename;

    if (event === "rename") {
      // Check if file was deleted or created
      try {
        await stat(fullPath);
        // File was created
        await this.addDoc(fullPath, relativePath);
        this.emit({
          type: "created",
          path: fullPath,
          relativePath,
          timestamp: new Date(),
          size: (await stat(fullPath)).size,
        });
      } catch {
        // File was deleted
        const oldState = this.docStates.get(relativePath);
        if (oldState) {
          this.docStates.delete(relativePath);
          this.emit({
            type: "deleted",
            path: fullPath,
            relativePath,
            timestamp: new Date(),
            size: 0,
          });
        }
      }
    } else {
      // File was modified
      try {
        const content = await readFile(fullPath, "utf-8");
        const stats = await stat(fullPath);
        const newHash = createHash("sha256").update(content).digest("hex").slice(0, 16);

        const existing = this.docStates.get(relativePath);
        if (existing && existing.contentHash !== newHash) {
          const state: DocState = {
            ...existing,
            contentHash: newHash,
            size: stats.size,
            lastModified: stats.mtime,
          };
          this.docStates.set(relativePath, state);

          this.emit({
            type: "modified",
            path: fullPath,
            relativePath,
            timestamp: new Date(),
            contentHash: newHash,
            size: stats.size,
          });
        }
      } catch {
        // File might have been deleted
      }
    }
  }

  /**
   * Poll for changes (fallback for systems without reliable fs.watch)
   */
  private async pollChanges(): Promise<void> {
    try {
      await this.scanDirectory(this.docsPath, "");
    } catch {
      // Directory might not exist yet
    }
  }

  /**
   * Emit change event to all callbacks
   */
  private emit(event: DocChangeEvent): void {
    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch (err) {
        console.log(`[DocWatcher] Callback error: ${err}`);
      }
    }
  }

  /**
   * Check if a file is a documentation file
   */
  private isDocFile(filename: string): boolean {
    return filename.endsWith(".md") || filename.endsWith(".txt") || filename.endsWith(".rst");
  }

  /**
   * Categorize a document based on its path
   */
  private categorizeDoc(relativePath: string): DocState["category"] {
    const parts = relativePath.split("/");

    if (parts[0] === "architecture") return "architecture";
    if (parts[0] === "guides") return "guides";
    if (parts[0] === "plans") return "plans";
    if (parts[0] === "requirements") return "requirements";
    if (parts[0] === "decisions") return "decisions";

    // Check for keywords in path
    const pathLower = relativePath.toLowerCase();
    if (pathLower.includes("plan")) return "plans";
    if (pathLower.includes("requirement")) return "requirements";
    if (pathLower.includes("decision") || pathLower.includes("adr")) return "decisions";

    return "other";
  }
}

// Singleton instance
let _instance: DocWatcher | null = null;

export function getDocWatcher(projectRoot: string): DocWatcher {
  if (!_instance) {
    _instance = new DocWatcher(projectRoot);
  }
  return _instance;
}

export function stopDocWatcher(): void {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}
