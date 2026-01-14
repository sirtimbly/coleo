/**
 * Brain - The central coordinator for Octopai
 * 
 * Runs a polling loop that:
 * 1. Reads human mail from sent/
 * 2. Processes arm messages from queue/
 * 3. Assigns tasks to arms
 * 4. Sends status updates to human inbox
 */

import { readdir, readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { Maildir } from "../mail";
import { initDatabase, Database } from "../db";
import { DocWatcher, getDocWatcher } from "../docs/watcher";
import type { BrainState, Task, QueueMessage, OctopaiConfig, Arm, Discovery } from "../types";

export interface BrainOptions {
  octopaiDir: string;
  pollIntervalMs: number;
  verbose: boolean;
  apiBaseUrl?: string;
  apiKey?: string;
}

/**
 * Domain-specific initial tasks for newly spawned arms
 */
const DOMAIN_INITIAL_TASKS: Record<string, { subject: string; description: string }[]> = {
  frontend: [
    {
      subject: "Review and improve the Dashboard UI",
      description: `Review the current dashboard implementation in src/web/src/pages/DashboardPage.tsx.

Look for opportunities to:
1. Improve the layout and visual hierarchy
2. Add missing status indicators
3. Ensure real-time updates are working
4. Fix any TypeScript errors

When done, report your findings and any changes made.`,
    },
  ],
  backend: [
    {
      subject: "Review API endpoints and add missing functionality",
      description: `Review the API implementation in src/api/.

Look for:
1. Missing CRUD operations
2. Proper error handling
3. Input validation
4. Consistent response formats

When done, report your findings and any changes made.`,
    },
  ],
  testing: [
    {
      subject: "Set up test infrastructure and write initial tests",
      description: `Set up a testing framework for the project.

Tasks:
1. Add vitest or bun test configuration
2. Write unit tests for core functions
3. Add integration tests for API endpoints

When done, report the test coverage and any issues found.`,
    },
  ],
  architect: [
    {
      subject: "Review codebase for architectural consistency",
      description: `Review the codebase to ensure architectural consistency.

Check:
1. All state goes to SQLite (not JSON files)
2. API follows conventions in AGENTS.md
3. Types are properly defined
4. No code duplication

When done, update AGENTS.md if needed and report findings.`,
    },
  ],
  docs: [
    {
      subject: "Review and update project documentation",
      description: `Review the docs/ directory to ensure documentation is up to date.

Tasks:
1. Check docs/architecture/ for accuracy
2. Review docs/guides/ for completeness
3. Check docs/plans/ matches implemented features
4. Identify gaps in documentation

When done, report findings and update any outdated docs.`,
    },
    {
      subject: "Update requirements based on user feedback",
      description: `Review recent email responses from the human and update documentation accordingly.

Tasks:
1. Check inbox for user feedback on requirements
2. Update docs/requirements/ with any clarified specifications
3. Update docs/plans/ with any priority changes
4. Sync docs/architecture/ if system design was discussed

When done, report what documentation was updated.`,
    },
  ],
  general: [
    {
      subject: "Explore the codebase and identify improvements",
      description: `Familiarize yourself with the Octopai codebase.

Tasks:
1. Read AGENTS.md for project guidelines
2. Explore the directory structure
3. Identify any issues or improvements
4. Report your findings

Focus on understanding how the system works before making changes.`,
    },
  ],
};

export class Brain {
  private options: BrainOptions;
  private state: BrainState;
  private inbox: Maildir;
  private sent: Maildir;
  private tasks: Task[] = [];
  private arms: Map<string, Arm> = new Map();
  private seenArmIds: Set<string> = new Set(); // Track arms we've already assigned initial tasks
  private running = false;
  private db: Database | null = null;
  private apiBaseUrl: string;
  private apiKey: string;

  constructor(options: BrainOptions) {
    this.options = options;
    this.apiBaseUrl = options.apiBaseUrl || "http://localhost:7777";
    this.apiKey = options.apiKey || process.env.OCTOPAI_API_KEY || "";
    this.state = {
      status: "stopped",
      pollIntervalMs: options.pollIntervalMs,
      activeArms: [],
      pendingTasks: 0,
      completedToday: 0,
    };
    
    // Set up mail directories
    this.inbox = new Maildir(join(options.octopaiDir, "mail", "inbox"));
    this.sent = new Maildir(join(options.octopaiDir, "mail", "sent"));
  }

  /**
   * Make an API request with authentication
   */
  private async apiRequest<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T | null> {
    try {
      const url = `${this.apiBaseUrl}${path}`;
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          ...options.headers,
        },
      });

      if (!response.ok) {
        this.log(`API error: ${response.status} ${response.statusText}`);
        return null;
      }

      return (await response.json()) as T;
    } catch (err) {
      // API not available, will fall back to direct DB access
      return null;
    }
  }

  /**
   * Initialize brain state and directories
   */
  async init(): Promise<void> {
    // Initialize database
    const dbPath = join(this.options.octopaiDir, "octopai.db");
    this.db = await initDatabase(dbPath);
    
    // Create necessary directories
    const dirs = [
      "mail/inbox",
      "mail/sent", 
      "mail/drafts",
      "mail/archive",
      "queue/brain/pending",
      "queue/brain/processed",
      "state",
      "state/arms",
      "state/notes/shared",
      "logs",
    ];
    
    for (const dir of dirs) {
      await mkdir(join(this.options.octopaiDir, dir), { recursive: true });
    }
    
    // Initialize maildirs
    await this.inbox.init();
    await this.sent.init();
    
    // Load existing state (but reset activeArms - they'll be populated from DB)
    await this.loadState();
    this.state.activeArms = []; // Reset - get from database on first poll
    
    await this.loadTasks();
    await this.loadArms();
    await this.loadSeenArmIds();
    
    // Start documentation watcher for project docs
    try {
      const projectRoot = process.cwd();
      const docWatcher = getDocWatcher(projectRoot);
      docWatcher.onChange(async (event) => {
        // Log doc changes
        this.log(`Documentation changed: ${event.relativePath} (${event.type})`);
        
        // If requirements or plans changed, re-evaluate pending tasks
        if (event.relativePath.includes("requirements") || event.relativePath.includes("plans")) {
          this.log(`Re-evaluating tasks due to doc change: ${event.relativePath}`);
          // Tasks will be re-prioritized in next poll cycle
        }
      });
      await docWatcher.start();
    } catch (err) {
      this.log(`Could not start doc watcher: ${err}`);
    }
    
    this.log("Brain initialized");
  }

  /**
   * Run a single poll cycle
   */
  async poll(): Promise<void> {
    this.state.lastPollAt = new Date().toISOString();
    
    // Step 1: Check for new human messages
    await this.processHumanMail();
    
    // Step 2: Process arm messages
    await this.processArmQueue();
    
    // Step 3: Check arm health and detect new arms
    await this.checkArms();
    
    // Step 4: Assign initial tasks to new arms
    await this.assignInitialTasks();
    
    // Step 5: Assign pending tasks to idle arms
    await this.assignTasks();
    
    // Step 6: Save state
    await this.saveState();
    
    // Step 7: Notify Observatory of poll completion
    await this.notifyObservatory("poll");
    
    this.log(`Poll complete. ${this.tasks.filter(t => t.status === "pending").length} pending, ${this.arms.size} arms`);
  }

  /**
    * Notify Observatory of brain event
    */
  private async notifyObservatory(event: "started" | "stopped" | "paused" | "resumed" | "poll"): Promise<void> {
    if (!this.apiBaseUrl || !this.apiKey) return;

    try {
      const now = Date.now();
      const startedAt = this.state.startedAt ? new Date(this.state.startedAt).getTime() : null;
      const uptime = startedAt ? Math.floor((now - startedAt) / 1000) : undefined;

      await fetch(`${this.apiBaseUrl}/api/brain/notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({
          event,
          status: this.state.status,
          pollIntervalMs: this.state.pollIntervalMs,
          activeArmsCount: this.state.activeArms.length,
          pendingTasksCount: this.state.pendingTasks,
          completedToday: this.state.completedToday,
          uptime,
        }),
      });
    } catch (err) {
      // Silently fail - Observatory might not be running
    }
  }

  /**
    * Run the polling loop
    */
  async run(): Promise<void> {
    this.running = true;
    this.state.status = "running";
    this.state.startedAt = this.state.startedAt || new Date().toISOString();
    
    this.log(`Starting brain with ${this.options.pollIntervalMs}ms interval`);
    
    // Notify Observatory that brain is starting
    await this.notifyObservatory("started");
    
    // Initial poll
    await this.poll();
    
    // Polling loop
    while (this.running) {
      await this.sleep(this.options.pollIntervalMs);
      if (this.running) {
        await this.poll();
      }
    }
    
    this.state.status = "stopped";
    await this.saveState();
    await this.notifyObservatory("stopped");
    this.log("Brain stopped");
  }

  /**
   * Run a single poll cycle and exit
   */
  async runOnce(): Promise<void> {
    this.state.status = "running";
    this.state.startedAt = this.state.startedAt || new Date().toISOString();
    await this.notifyObservatory("started");
    await this.poll();
    this.state.status = "stopped";
    await this.saveState();
    await this.notifyObservatory("stopped");
  }

  /**
   * Stop the brain
   */
  stop(): void {
    this.running = false;
    this.log("Stop requested");
  }

  /**
   * Process new mail from human (in sent/ folder)
   */
  private async processHumanMail(): Promise<void> {
    const messages = await this.sent.list("new");
    
    for (const message of messages) {
      this.log(`Processing human message: ${message.subject}`);
      
      // Parse the message to understand intent
      const intent = this.parseHumanIntent(message.subject, message.body);
      
      switch (intent.type) {
        case "new_task":
          await this.createTask(intent.subject, intent.body, message.id);
          break;
          
        case "doc_update":
          await this.createDocUpdateTask(intent.subject, intent.body, intent.targetDoc, message.id);
          break;
          
        case "approval_response":
          await this.handleApprovalResponse(intent.originalId, intent.approved, intent.comment);
          break;
          
        case "query":
          await this.handleQuery(intent.query, message.id);
          break;
          
        default:
          this.log(`Unknown intent: ${message.subject}`);
      }
      
      // Mark as processed
      await this.sent.markSeen(message.id);
    }
  }

  /**
    * Parse human message to understand intent
    */
  private parseHumanIntent(subject: string, body: string): HumanIntent {
    const lowerSubject = subject.toLowerCase();
    const lowerBody = body.toLowerCase();
    
    // Check for approval response
    if (lowerSubject.includes("re:") && lowerSubject.includes("approval")) {
      const approved = lowerBody.includes("approve") || lowerBody.includes("yes") || lowerBody.includes("ok");
      const originalIdMatch = subject.match(/\[([^\]]+)\]/);
      return {
        type: "approval_response",
        originalId: originalIdMatch?.[1] || "",
        approved,
        comment: body,
      };
    }
    
    // Check for documentation update request
    const docUpdatePatterns = [
      /update (?:the )?docs?/i,
      /update (?:the )?requirements/i,
      /update (?:the )?plans?/i,
      /update (?:the )?documentation/i,
      /revise (?:the )?docs?/i,
      /revise (?:the )?requirements/i,
      /change (?:the )?specs?/i,
      /clarify (?:the )?requirements/i,
    ];
    
    for (const pattern of docUpdatePatterns) {
      if (pattern.test(subject) || pattern.test(body)) {
        // Try to extract target document
        const docMatch = body.match(/docs\/([^\s\n]+)|requirements\/([^\s\n]+)|plans\/([^\s\n]+)/i);
        const targetDoc = docMatch?.[1] || docMatch?.[2] || docMatch?.[3] || undefined;
        
        return {
          type: "doc_update",
          subject: subject.replace(/^(update|revise|change|clarify)\s*(?:the\s*)?/i, "").trim(),
          body,
          targetDoc,
        };
      }
    }
    
    // Check for status query
    if (lowerSubject.includes("status") || lowerBody.includes("what's happening")) {
      return { type: "query", query: "status" };
    }
    
    // Default: treat as new task
    return {
      type: "new_task",
      subject: subject.replace(/^(new task:|task:)\s*/i, ""),
      body,
    };
  }

  /**
   * Process messages from arms
   */
  private async processArmQueue(): Promise<void> {
    const queueDir = join(this.options.octopaiDir, "queue", "brain", "pending");
    const processedDir = join(this.options.octopaiDir, "queue", "brain", "processed");
    
    let files: string[];
    try {
      files = await readdir(queueDir);
    } catch {
      return; // Queue doesn't exist yet
    }
    
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      
      try {
        const content = await readFile(join(queueDir, file), "utf-8");
        const message: QueueMessage = JSON.parse(content);
        
        await this.handleArmMessage(message);
        
        // Move to processed
        await rename(
          join(queueDir, file),
          join(processedDir, file)
        );
      } catch (err) {
        this.log(`Error processing queue message ${file}: ${err}`);
      }
    }
  }

  /**
   * Handle a message from an arm
   */
  private async handleArmMessage(message: QueueMessage): Promise<void> {
    this.log(`Arm message: ${message.type} from ${message.from}`);
    
    switch (message.type) {
      case "task_complete": {
        const payload = message.payload as { taskId: string; summary: string; artifacts: string[] };
        await this.completeTask(payload.taskId, payload.summary, payload.artifacts);
        break;
      }
      
      case "discovery": {
        const discovery = message.payload as Discovery;
        await this.handleDiscovery(message.from, discovery);
        break;
      }
      
      case "approval_request": {
        const payload = message.payload as { action: string; context: string; options: string[] };
        await this.sendApprovalRequest(message.from, payload);
        break;
      }
      
      case "share_note": {
        const note = message.payload as { title: string; content: string; tags: string[] };
        await this.saveSharedNote(message.from, note);
        break;
      }
      
      case "tool_discovery": {
        const tool = message.payload as { name: string; command: string; description: string };
        await this.handleToolDiscovery(message.from, tool);
        break;
      }
      
      case "heartbeat": {
        const payload = message.payload as { status?: string; currentTask?: string; timestamp: string };
        await this.handleHeartbeat(message.from, payload);
        break;
      }

      case "doc_update": {
        const payload = message.payload as { path: string; reason: string; previousContent?: string; newContent?: string };
        await this.handleDocUpdate(message.from, payload);
        break;
      }

      case "file_subscription": {
        const payload = message.payload as { action: "subscribe" | "unsubscribe"; pattern: string; category?: string };
        await this.handleFileSubscription(message.from, payload);
        break;
      }

      case "file_change": {
        const payload = message.payload as { filePath: string; changeType: string; summary: string; impact?: string; detectedAt: string };
        await this.handleFileChange(message.from, payload);
        break;
      }
    }
  }

  /**
   * Create a new task
   */
  private async createTask(subject: string, description: string, mailThreadId?: string): Promise<Task> {
    const task: Task = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      subject,
      description,
      status: "pending",
      priority: "normal",
      createdAt: new Date(),
      updatedAt: new Date(),
      mailThreadId,
    };
    
    this.tasks.push(task);
    await this.saveTasks();
    
    this.log(`Created task: ${task.subject} (${task.id})`);
    
    return task;
  }

  /**
   * Create a documentation update task
   * These tasks are assigned to arms with "docs" domain
   */
  private async createDocUpdateTask(
    subject: string,
    description: string,
    targetDoc?: string,
    mailThreadId?: string
  ): Promise<Task> {
    const taskId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    
    let fullDescription = description;
    if (targetDoc) {
      fullDescription = `Update documentation: docs/${targetDoc}\n\n${description}`;
    } else {
      fullDescription = `Update project documentation based on human feedback:\n\n${description}`;
    }
    
    const task: Task = {
      id: taskId,
      subject: `Docs: ${subject}`,
      description: fullDescription,
      status: "pending",
      priority: "high", // Documentation updates from humans are high priority
      domain: "docs", // Assign to docs specialist arm
      createdAt: new Date(),
      updatedAt: new Date(),
      mailThreadId,
    };
    
    this.tasks.push(task);
    await this.saveTasks();
    
    this.log(`Created doc update task: ${subject} (${taskId})`);
    
    return task;
  }

  /**
   * Complete a task
   */
  private async completeTask(taskId: string, summary: string, artifacts: string[]): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      this.log(`Task not found: ${taskId}`);
      return;
    }
    
    task.status = "completed";
    task.completedAt = new Date();
    task.updatedAt = new Date();
    task.artifacts = artifacts;
    
    this.state.completedToday++;
    await this.saveTasks();
    
    // Notify human
    await this.sendToHuman({
      subject: `[octopai] Task completed: ${task.subject}`,
      body: `Task "${task.subject}" has been completed.\n\n## Summary\n${summary}\n\n## Artifacts\n${artifacts.map(a => `- ${a}`).join("\n") || "None"}`,
      headers: {
        "X-Octopai-Task-Id": taskId,
        "X-Octopai-Type": "task-complete",
      },
    });
    
    this.log(`Completed task: ${task.subject}`);
  }

  /**
   * Handle a discovery from an arm
   */
  private async handleDiscovery(armId: string, discovery: Discovery): Promise<void> {
    // For now, always escalate to human
    await this.sendToHuman({
      subject: `[octopai] Discovery: ${discovery.title}`,
      body: `Arm ${armId} found something:\n\n**Type:** ${discovery.kind}\n**Severity:** ${discovery.severity || "info"}\n\n${discovery.details}${discovery.file ? `\n\n**File:** ${discovery.file}${discovery.line ? `:${discovery.line}` : ""}` : ""}`,
      headers: {
        "X-Octopai-Type": "discovery",
        "X-Octopai-From": armId,
        "X-Octopai-Severity": discovery.severity || "info",
      },
    });
  }

  /**
   * Send an approval request to the human
   */
  private async sendApprovalRequest(
    armId: string, 
    request: { action: string; context: string; options: string[] }
  ): Promise<void> {
    const requestId = `approval-${Date.now()}`;
    
    await this.sendToHuman({
      subject: `[octopai] [${requestId}] Approval needed: ${request.action}`,
      body: `Arm ${armId} needs your approval.\n\n**Action:** ${request.action}\n\n**Context:**\n${request.context}\n\n**Options:** ${request.options.join(" | ")}\n\nReply to this email with your decision.`,
      headers: {
        "X-Octopai-Type": "approval-request",
        "X-Octopai-From": armId,
        "X-Octopai-Request-Id": requestId,
        "Priority": "high",
      },
    });
  }

  /**
   * Handle approval response from human
   */
  private async handleApprovalResponse(originalId: string, approved: boolean, comment: string): Promise<void> {
    // TODO: Find pending approval and notify the arm
    this.log(`Approval response for ${originalId}: ${approved ? "approved" : "rejected"}`);
  }

  /**
   * Handle a status query from human
   */
  private async handleQuery(query: string, replyToId: string): Promise<void> {
    if (query === "status") {
      const pendingTasks = this.tasks.filter(t => t.status === "pending");
      const inProgress = this.tasks.filter(t => t.status === "in_progress");
      const completedToday = this.state.completedToday;
      
      await this.sendToHuman({
        subject: "[octopai] Status Report",
        body: `## Current Status\n\n- **Arms active:** ${this.arms.size}\n- **Pending tasks:** ${pendingTasks.length}\n- **In progress:** ${inProgress.length}\n- **Completed today:** ${completedToday}\n\n## Pending Tasks\n${pendingTasks.map(t => `- ${t.subject}`).join("\n") || "None"}\n\n## In Progress\n${inProgress.map(t => `- ${t.subject} (${t.assignedTo})`).join("\n") || "None"}`,
        headers: {
          "X-Octopai-Type": "status",
          "In-Reply-To": replyToId,
        },
      });
    }
  }

  /**
   * Save a shared note
   */
  private async saveSharedNote(
    author: string,
    note: { title: string; content: string; tags: string[] }
  ): Promise<void> {
    const notesDir = join(this.options.octopaiDir, "state", "notes", "shared");
    const noteId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    
    const fullNote = {
      id: noteId,
      author,
      ...note,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    await writeFile(
      join(notesDir, `${noteId}.json`),
      JSON.stringify(fullNote, null, 2),
      "utf-8"
    );
    
    this.log(`Saved shared note: ${note.title} from ${author}`);
  }

  /**
   * Handle a tool discovery
   */
  private async handleToolDiscovery(
    armId: string,
    tool: { name: string; command: string; description: string }
  ): Promise<void> {
    // Save to toolbox
    const toolboxPath = join(this.options.octopaiDir, "state", "toolbox.json");
    let toolbox: Record<string, unknown> = {};
    
    try {
      const content = await readFile(toolboxPath, "utf-8");
      toolbox = JSON.parse(content);
    } catch {
      // Toolbox doesn't exist yet
    }
    
    toolbox[tool.name] = {
      ...tool,
      discoveredBy: armId,
      discoveredAt: new Date(),
    };
    
    await writeFile(toolboxPath, JSON.stringify(toolbox, null, 2), "utf-8");
    
    // Notify human
    await this.sendToHuman({
      subject: `[octopai] Tool discovered: ${tool.name}`,
      body: `Arm ${armId} discovered a useful tool:\n\n**Name:** ${tool.name}\n**Command:** \`${tool.command}\`\n**Description:** ${tool.description}`,
      headers: {
        "X-Octopai-Type": "tool-discovery",
      },
    });
  }

  /**
   * Handle a heartbeat from an arm - update last_heartbeat in database
   */
  private async handleHeartbeat(
    armId: string,
    payload: { status?: string; currentTask?: string; timestamp: string }
  ): Promise<void> {
    if (!this.db) return;
    
    const now = new Date().toISOString();
    this.db.run(
      "UPDATE arms SET last_heartbeat = ?, last_activity_at = ?, updated_at = ? WHERE id = ?",
      [now, now, now, armId]
    );
    
    // Update in-memory state too
    const arm = this.arms.get(armId);
    if (arm) {
      arm.lastActivity = new Date();
      if (payload.status === "busy" || payload.currentTask) {
        arm.status = "busy";
        arm.currentTask = payload.currentTask;
      } else {
        arm.status = "idle";
      }
    }
    
    this.log(`Heartbeat from ${armId}: ${payload.status || "alive"}`);
  }

  /**
   * Handle documentation update from an arm
   */
  private async handleDocUpdate(
    armId: string,
    payload: { path: string; reason: string; previousContent?: string; newContent?: string }
  ): Promise<void> {
    this.log(`Documentation updated by ${armId}: ${payload.path}`);

    // Notify human of the update
    await this.sendToHuman({
      subject: `[octopai] Documentation updated: ${payload.path}`,
      body: `Arm ${armId} has updated documentation.\n\n**File:** ${payload.path}\n**Reason:** ${payload.reason}`,
      headers: {
        "X-Octopai-Type": "doc-update",
        "X-Octopai-Path": payload.path,
      },
    });

    // Log file change for subscribed arms
    if (this.db) {
      this.db.run(`
        INSERT INTO file_changes (file_path, change_type, content_hash, detected_by_arm_id)
        VALUES (?, 'modified', ?, ?)
      `, [payload.path, payload.newContent ? createHash("sha256").update(payload.newContent).digest("hex").slice(0, 16) : null, armId]);
    }
  }

  /**
   * Handle file subscription request from an arm
   */
  private async handleFileSubscription(
    armId: string,
    payload: { action: "subscribe" | "unsubscribe"; pattern: string; category?: string }
  ): Promise<void> {
    if (!this.db) return;

    if (payload.action === "subscribe") {
      // Check if subscription already exists
      const existing = this.db.query(`
        SELECT id FROM file_subscriptions WHERE arm_id = ? AND file_pattern = ?
      `).get(armId, payload.pattern);

      if (!existing) {
        this.db.run(`
          INSERT INTO file_subscriptions (arm_id, file_pattern, category, subscribed_at)
          VALUES (?, ?, ?, ?)
        `, [armId, payload.pattern, payload.category || null, new Date().toISOString()]);
        this.log(`Arm ${armId} subscribed to: ${payload.pattern}`);
      }
    } else {
      // Unsubscribe
      this.db.run(`
        DELETE FROM file_subscriptions WHERE arm_id = ? AND file_pattern = ?
      `, [armId, payload.pattern]);
      this.log(`Arm ${armId} unsubscribed from: ${payload.pattern}`);
    }
  }

  /**
   * Handle file change report from an arm
   */
  private async handleFileChange(
    armId: string,
    payload: { filePath: string; changeType: string; summary: string; impact?: string; detectedAt: string }
  ): Promise<void> {
    this.log(`File change detected by ${armId}: ${payload.filePath} (${payload.changeType})`);

    // Record the change
    if (this.db) {
      this.db.run(`
        INSERT INTO file_changes (file_path, change_type, content_hash, detected_by_arm_id)
        VALUES (?, ?, ?, ?)
      `, [payload.filePath, payload.changeType, null, armId]);

      // Get all arms subscribed to this file pattern
      const subscriptions = this.db.query(`
        SELECT DISTINCT arm_id, file_pattern FROM file_subscriptions
        WHERE ? LIKE file_pattern
      `).all(payload.filePath) as Array<{ arm_id: string; file_pattern: string }>;

      // Notify subscribed arms
      for (const sub of subscriptions) {
        if (sub.arm_id !== armId) {
          // Queue notification to subscribed arm
          await this.sendToArm(sub.arm_id, {
            type: "file_change_notification",
            payload: {
              filePath: payload.filePath,
              changeType: payload.changeType,
              summary: payload.summary,
              impact: payload.impact,
              detectedBy: armId,
              detectedAt: payload.detectedAt,
            },
          });
          this.log(`Notified arm ${sub.arm_id} of file change: ${payload.filePath}`);
        }
      }

      // If requirements or plans changed, re-evaluate pending tasks
      if (payload.filePath.includes("requirements") || payload.filePath.includes("plans")) {
        this.log(`Requirements/plans changed: ${payload.filePath}. Re-evaluating tasks.`);
        // Tasks will be re-prioritized in next poll cycle
      }
    }

    // Notify human of significant changes
    if (payload.impact === "high" || payload.filePath.includes("requirements")) {
      await this.sendToHuman({
        subject: `[octopai] File change detected: ${payload.filePath}`,
        body: `Arm ${armId} detected a change:\n\n**File:** ${payload.filePath}\n**Type:** ${payload.changeType}\n**Summary:** ${payload.summary}${payload.impact ? `\n**Impact:** ${payload.impact}` : ""}`,
        headers: {
          "X-Octopai-Type": "file-change",
          "X-Octopai-Path": payload.filePath,
        },
      });
    }
  }

  /**
   * Check arm health and mark stale arms as stopped
   */
  private async checkArms(): Promise<void> {
    // Reload arms from database to get any newly spawned arms
    await this.loadArms();
    
    // Check for stale arms (no heartbeat in timeout period)
    await this.checkStaleArms();
    
    this.state.activeArms = Array.from(this.arms.keys());
  }

  /**
   * Mark arms as stopped if they haven't sent a heartbeat recently
   */
  private async checkStaleArms(): Promise<void> {
    // Check each arm's state via API (harness-aware)
    for (const [armId, arm] of this.arms) {
      interface StateResponse {
        state: string;
        hasSession: boolean;
      }
      
      const stateResult = await this.apiRequest<StateResponse>(`/api/arms/${armId}/state`);
      
      if (stateResult) {
        // API available - check harness session state
        if (!stateResult.hasSession || stateResult.state === "stopped" || stateResult.state === "dead") {
          this.log(`Arm ${armId} has no active session (state: ${stateResult.state}), marking as stopped`);
          
          // Update via API
          await this.apiRequest(`/api/arms/${armId}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "stopped" }),
          });
          
          this.arms.delete(armId);
        }
        continue;
      }
      
      // Fallback: Check via PID if API not available
      if (arm.pid) {
        try {
          process.kill(arm.pid, 0);
          // Process alive
        } catch {
          // Process dead
          this.log(`Arm ${armId} process dead, marking as stopped`);
          if (this.db) {
            this.db.run(
              "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
              [new Date().toISOString(), armId]
            );
          }
          this.arms.delete(armId);
        }
      }
    }
    
    // Also check DB for stale arms (heartbeat timeout) when API not available
    if (!this.db) return;
    
    // Get timeout from config (default 120 seconds)
    let timeoutSeconds = 120;
    try {
      const row = this.db.query("SELECT value FROM config WHERE key = 'arm_heartbeat_timeout_seconds'").get() as { value: string } | null;
      if (row) {
        timeoutSeconds = parseInt(row.value, 10);
      }
    } catch {
      // Use default
    }
    
    const cutoffTime = new Date(Date.now() - timeoutSeconds * 1000).toISOString();
    
    // Find arms that haven't heartbeated recently and are not already stopped
    const staleArms = this.db.query(`
      SELECT id, name, last_heartbeat, status
      FROM arms
      WHERE status NOT IN ('stopped', 'starting')
        AND (last_heartbeat IS NULL OR last_heartbeat < ?)
        AND created_at < ?
    `).all(cutoffTime, cutoffTime) as Array<{ id: string; name: string; last_heartbeat: string | null; status: string }>;
    
    for (const arm of staleArms) {
      // Skip if we already removed it via API check
      if (!this.arms.has(arm.id)) continue;
      
      this.log(`Arm ${arm.id} is stale (last heartbeat: ${arm.last_heartbeat || "never"}), marking as stopped`);
      
      this.db.run(
        "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
        [new Date().toISOString(), arm.id]
      );
      
      // Remove from in-memory map
      this.arms.delete(arm.id);
    }
  }

  /**
   * Assign initial tasks to newly spawned arms based on their domain
   */
  private async assignInitialTasks(): Promise<void> {
    for (const [armId, arm] of this.arms) {
      // Skip if we've already assigned initial tasks to this arm
      if (this.seenArmIds.has(armId)) continue;
      
      // Skip if arm is not idle
      if (arm.status !== "idle") continue;
      
      // Get the domain (stored as extra property)
      const domain = (arm as Arm & { domain?: string }).domain || "general";
      
      // Get initial tasks for this domain
      const initialTasks = DOMAIN_INITIAL_TASKS[domain] ?? DOMAIN_INITIAL_TASKS.general ?? [];
      
      // Create tasks for this arm
      for (const taskTemplate of initialTasks) {
        const task = await this.createTask(
          taskTemplate.subject,
          taskTemplate.description
        );
        
        // Immediately assign to this arm
        task.status = "claimed";
        task.assignedTo = armId;
        task.updatedAt = new Date();
        
        // Send to arm
        await this.sendToArm(armId, {
          type: "task_assignment",
          payload: task,
        });
        
        this.log(`Assigned initial task "${task.subject}" to ${armId} (domain: ${domain})`);
      }
      
      // Mark arm as having received initial tasks
      this.seenArmIds.add(armId);
      await this.saveSeenArmIds();
    }
  }

  /**
   * Load seen arm IDs from state
   */
  private async loadSeenArmIds(): Promise<void> {
    try {
      const content = await readFile(
        join(this.options.octopaiDir, "state", "seen_arms.json"),
        "utf-8"
      );
      const ids = JSON.parse(content);
      this.seenArmIds = new Set(ids);
    } catch {
      this.seenArmIds = new Set();
    }
  }

  /**
   * Save seen arm IDs to state
   */
  private async saveSeenArmIds(): Promise<void> {
    await writeFile(
      join(this.options.octopaiDir, "state", "seen_arms.json"),
      JSON.stringify(Array.from(this.seenArmIds)),
      "utf-8"
    );
  }

  /**
   * Assign pending tasks to available arms
   * Considers task domain preferences when assigning
   */
  private async assignTasks(): Promise<void> {
    const pendingTasks = this.tasks.filter(t => t.status === "pending");
    const idleArms = Array.from(this.arms.values()).filter(t => t.status === "idle");
    
    for (const task of pendingTasks) {
      // Find best matching arm based on task domain preference
      let bestArm = idleArms.shift();
      
      if (task.domain) {
        // Look for an arm with matching domain
        const matchingArm = idleArms.find(arm => {
          const armDomain = (arm as Arm & { domain?: string }).domain || "general";
          return armDomain === task.domain || armDomain === "general";
        });
        
        if (matchingArm) {
          // Remove matching arm from idleArms and use it
          const index = idleArms.indexOf(matchingArm);
          if (index > -1) {
            idleArms.splice(index, 1);
          }
          bestArm = matchingArm;
        }
      }
      
      if (!bestArm) break;
      
      task.status = "claimed";
      task.assignedTo = bestArm.id;
      task.updatedAt = new Date();
      
      bestArm.status = "busy";
      bestArm.currentTask = task.id;
      
      // Write task assignment to arm's queue
      await this.sendToArm(bestArm.id, {
        type: "task_assignment",
        payload: task,
      });
      
      const domainMatch = task.domain ? ` (domain: ${task.domain})` : "";
      this.log(`Assigned task "${task.subject}" to ${bestArm.id}${domainMatch}`);
    }
    
    await this.saveTasks();
    await this.saveArms();
  }

  /**
   * Send a message to an arm's queue
   */
  private async sendToArm(
    armId: string, 
    message: { type: string; payload: unknown }
  ): Promise<void> {
    const queueDir = join(this.options.octopaiDir, "queue", "arms", armId);
    await mkdir(queueDir, { recursive: true });
    
    const filename = `${Date.now()}-${message.type}.json`;
    await writeFile(
      join(queueDir, filename),
      JSON.stringify({
        ...message,
        from: "brain",
        to: armId,
        timestamp: new Date(),
      }, null, 2),
      "utf-8"
    );
  }

  /**
   * Send a message to the human's inbox
   */
  private async sendToHuman(message: {
    subject: string;
    body: string;
    headers?: Record<string, string>;
  }): Promise<void> {
    await this.inbox.write({
      from: "brain@octopai.local",
      to: "human@local",
      subject: message.subject,
      date: new Date(),
      body: message.body,
      headers: message.headers || {},
    });
  }

  // State persistence methods

  private async loadState(): Promise<void> {
    try {
      const content = await readFile(
        join(this.options.octopaiDir, "state", "brain.json"),
        "utf-8"
      );
      const saved = JSON.parse(content);
      this.state = { ...this.state, ...saved };
    } catch {
      // No state file yet
    }
  }

  private async saveState(): Promise<void> {
    await writeFile(
      join(this.options.octopaiDir, "state", "brain.json"),
      JSON.stringify(this.state, null, 2),
      "utf-8"
    );
  }

  private async loadTasks(): Promise<void> {
    try {
      const content = await readFile(
        join(this.options.octopaiDir, "state", "tasks.json"),
        "utf-8"
      );
      this.tasks = JSON.parse(content);
    } catch {
      this.tasks = [];
    }
    this.state.pendingTasks = this.tasks.filter(t => t.status === "pending").length;
  }

  private async saveTasks(): Promise<void> {
    await writeFile(
      join(this.options.octopaiDir, "state", "tasks.json"),
      JSON.stringify(this.tasks, null, 2),
      "utf-8"
    );
    this.state.pendingTasks = this.tasks.filter(t => t.status === "pending").length;
  }

  private async loadArms(): Promise<void> {
    // Try API first (preferred - harness-aware)
    interface ApiArm {
      id: string;
      name: string;
      domain: string;
      harness: string;
      status: string;
      pid?: number;
      provider?: string;
      model?: string;
      createdAt: string;
      lastActivityAt?: string;
    }
    
    const apiResult = await this.apiRequest<{ arms: ApiArm[] }>("/api/arms");
    
    if (apiResult) {
      // API is available - use it
      this.arms.clear();
      for (const row of apiResult.arms) {
        if (row.status === "stopped") continue;
        
        const arm: Arm = {
          id: row.id,
          name: row.name,
          agent: row.harness,
          status: row.status as Arm["status"],
          pid: row.pid,
          provider: row.provider,
          model: row.model,
          startedAt: new Date(row.createdAt),
          lastActivity: row.lastActivityAt ? new Date(row.lastActivityAt) : undefined,
        };
        (arm as Arm & { domain?: string }).domain = row.domain;
        this.arms.set(arm.id, arm);
      }
      this.log(`Loaded ${this.arms.size} active arms from API`);
      return;
    }
    
    // Fallback to direct database access
    if (!this.db) return;
    
    try {
      const rows = this.db.query(`
        SELECT id, name, domain, harness, status, pid, provider, model, 
               created_at, last_activity_at
        FROM arms
        WHERE status != 'stopped'
      `).all() as Array<{
        id: string;
        name: string;
        domain: string;
        harness: string;
        status: string;
        pid: number | null;
        provider: string | null;
        model: string | null;
        created_at: string;
        last_activity_at: string | null;
      }>;
      
      for (const row of rows) {
        // Check if process is still running
        let status = row.status as Arm["status"];
        if (row.pid && status !== "stopped") {
          try {
            process.kill(row.pid, 0);
            // Process is alive
            if (status === "starting") {
              status = "idle";
            }
          } catch {
            // Process is dead
            status = "stopped";
          }
          
          // Update status in database if changed
          if (status !== row.status) {
            this.db.run(
              "UPDATE arms SET status = ?, updated_at = ? WHERE id = ?",
              [status, new Date().toISOString(), row.id]
            );
          }
        }
        
        if (status !== "stopped") {
          const arm: Arm = {
            id: row.id,
            name: row.name,
            agent: row.harness,
            status,
            pid: row.pid ?? undefined,
            provider: row.provider ?? undefined,
            model: row.model ?? undefined,
            startedAt: new Date(row.created_at),
            lastActivity: row.last_activity_at ? new Date(row.last_activity_at) : undefined,
          };
          // Store domain in a way we can access it
          (arm as Arm & { domain?: string }).domain = row.domain;
          this.arms.set(arm.id, arm);
        }
      }
      
      this.log(`Loaded ${this.arms.size} active arms from database`);
    } catch (err) {
      this.log(`Error loading arms: ${err}`);
    }
  }

  private async saveArms(): Promise<void> {
    for (const arm of this.arms.values()) {
      const now = new Date().toISOString();
      
      // Try API first
      const apiResult = await this.apiRequest<{ arm: unknown }>(`/api/arms/${arm.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: arm.status,
          lastActivityAt: arm.lastActivity?.toISOString() || now,
        }),
      });
      
      if (apiResult) continue; // Success via API
      
      // Fallback to direct database access
      if (this.db) {
        this.db.run(
          `UPDATE arms SET status = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`,
          [arm.status, arm.lastActivity?.toISOString() || now, now, arm.id]
        );
      }
    }
  }

  /**
   * Register a new arm
   */
  async registerArm(arm: Arm): Promise<void> {
    this.arms.set(arm.id, arm);
    await this.saveArms();
    this.log(`Registered arm: ${arm.id} (${arm.agent})`);
  }

  /**
   * Get current state (for CLI status command)
   */
  getState(): BrainState {
    return { ...this.state };
  }

  /**
   * Get all tasks
   */
  getTasks(): Task[] {
    return [...this.tasks];
  }

  /**
   * Get all arms
   */
  getArms(): Arm[] {
    return Array.from(this.arms.values());
  }

  // Utility methods

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    
    if (this.options.verbose) {
      console.log(line);
    }
    
    // Also append to log file (async, don't await)
    this.appendLog(line).catch(() => {});
  }

  private async appendLog(line: string): Promise<void> {
    const logPath = join(this.options.octopaiDir, "logs", "brain.log");
    const { appendFile } = await import("fs/promises");
    await appendFile(logPath, line + "\n", "utf-8");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Types for parsing human intent
type HumanIntent = 
  | { type: "new_task"; subject: string; body: string }
  | { type: "doc_update"; subject: string; body: string; targetDoc?: string }
  | { type: "approval_response"; originalId: string; approved: boolean; comment: string }
  | { type: "query"; query: string };
