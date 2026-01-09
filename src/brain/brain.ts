/**
 * Brain - The central coordinator for Octopai
 * 
 * Runs a polling loop that:
 * 1. Reads human mail from sent/
 * 2. Processes tentacle messages from queue/
 * 3. Assigns tasks to tentacles
 * 4. Sends status updates to human inbox
 */

import { readdir, readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import { join } from "path";
import { Maildir } from "../mail";
import type { BrainState, Task, QueueMessage, OctopaiConfig, Tentacle, Discovery } from "../types";

export interface BrainOptions {
  octopaiDir: string;
  pollIntervalMs: number;
  verbose: boolean;
}

export class Brain {
  private options: BrainOptions;
  private state: BrainState;
  private inbox: Maildir;
  private sent: Maildir;
  private tasks: Task[] = [];
  private tentacles: Map<string, Tentacle> = new Map();
  private running = false;

  constructor(options: BrainOptions) {
    this.options = options;
    this.state = {
      status: "stopped",
      pollIntervalMs: options.pollIntervalMs,
      activeTentacles: [],
      pendingTasks: 0,
      completedToday: 0,
    };
    
    // Set up mail directories
    this.inbox = new Maildir(join(options.octopaiDir, "mail", "inbox"));
    this.sent = new Maildir(join(options.octopaiDir, "mail", "sent"));
  }

  /**
   * Initialize brain state and directories
   */
  async init(): Promise<void> {
    // Create necessary directories
    const dirs = [
      "mail/inbox",
      "mail/sent", 
      "mail/drafts",
      "mail/archive",
      "queue/brain/pending",
      "queue/brain/processed",
      "state",
      "state/tentacles",
      "state/notes/shared",
      "logs",
    ];
    
    for (const dir of dirs) {
      await mkdir(join(this.options.octopaiDir, dir), { recursive: true });
    }
    
    // Initialize maildirs
    await this.inbox.init();
    await this.sent.init();
    
    // Load existing state
    await this.loadState();
    await this.loadTasks();
    await this.loadTentacles();
    
    this.log("Brain initialized");
  }

  /**
   * Run a single poll cycle
   */
  async poll(): Promise<void> {
    this.state.lastPollAt = new Date();
    
    // Step 1: Check for new human messages
    await this.processHumanMail();
    
    // Step 2: Process tentacle messages
    await this.processTentacleQueue();
    
    // Step 3: Check tentacle health
    await this.checkTentacles();
    
    // Step 4: Assign pending tasks
    await this.assignTasks();
    
    // Step 5: Save state
    await this.saveState();
    
    this.log(`Poll complete. ${this.tasks.filter(t => t.status === "pending").length} pending, ${this.tentacles.size} tentacles`);
  }

  /**
   * Run the polling loop
   */
  async run(): Promise<void> {
    this.running = true;
    this.state.status = "running";
    
    this.log(`Starting brain with ${this.options.pollIntervalMs}ms interval`);
    
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
    this.log("Brain stopped");
  }

  /**
   * Run a single poll cycle and exit
   */
  async runOnce(): Promise<void> {
    this.state.status = "running";
    await this.poll();
    this.state.status = "stopped";
    await this.saveState();
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
   * Process messages from tentacles
   */
  private async processTentacleQueue(): Promise<void> {
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
        
        await this.handleTentacleMessage(message);
        
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
   * Handle a message from a tentacle
   */
  private async handleTentacleMessage(message: QueueMessage): Promise<void> {
    this.log(`Tentacle message: ${message.type} from ${message.from}`);
    
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
   * Handle a discovery from a tentacle
   */
  private async handleDiscovery(tentacleId: string, discovery: Discovery): Promise<void> {
    // For now, always escalate to human
    await this.sendToHuman({
      subject: `[octopai] Discovery: ${discovery.title}`,
      body: `Tentacle ${tentacleId} found something:\n\n**Type:** ${discovery.kind}\n**Severity:** ${discovery.severity || "info"}\n\n${discovery.details}${discovery.file ? `\n\n**File:** ${discovery.file}${discovery.line ? `:${discovery.line}` : ""}` : ""}`,
      headers: {
        "X-Octopai-Type": "discovery",
        "X-Octopai-From": tentacleId,
        "X-Octopai-Severity": discovery.severity || "info",
      },
    });
  }

  /**
   * Send an approval request to the human
   */
  private async sendApprovalRequest(
    tentacleId: string, 
    request: { action: string; context: string; options: string[] }
  ): Promise<void> {
    const requestId = `approval-${Date.now()}`;
    
    await this.sendToHuman({
      subject: `[octopai] [${requestId}] Approval needed: ${request.action}`,
      body: `Tentacle ${tentacleId} needs your approval.\n\n**Action:** ${request.action}\n\n**Context:**\n${request.context}\n\n**Options:** ${request.options.join(" | ")}\n\nReply to this email with your decision.`,
      headers: {
        "X-Octopai-Type": "approval-request",
        "X-Octopai-From": tentacleId,
        "X-Octopai-Request-Id": requestId,
        "Priority": "high",
      },
    });
  }

  /**
   * Handle approval response from human
   */
  private async handleApprovalResponse(originalId: string, approved: boolean, comment: string): Promise<void> {
    // TODO: Find pending approval and notify the tentacle
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
        body: `## Current Status\n\n- **Tentacles active:** ${this.tentacles.size}\n- **Pending tasks:** ${pendingTasks.length}\n- **In progress:** ${inProgress.length}\n- **Completed today:** ${completedToday}\n\n## Pending Tasks\n${pendingTasks.map(t => `- ${t.subject}`).join("\n") || "None"}\n\n## In Progress\n${inProgress.map(t => `- ${t.subject} (${t.assignedTo})`).join("\n") || "None"}`,
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
    tentacleId: string,
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
      discoveredBy: tentacleId,
      discoveredAt: new Date(),
    };
    
    await writeFile(toolboxPath, JSON.stringify(toolbox, null, 2), "utf-8");
    
    // Notify human
    await this.sendToHuman({
      subject: `[octopai] Tool discovered: ${tool.name}`,
      body: `Tentacle ${tentacleId} discovered a useful tool:\n\n**Name:** ${tool.name}\n**Command:** \`${tool.command}\`\n**Description:** ${tool.description}`,
      headers: {
        "X-Octopai-Type": "tool-discovery",
      },
    });
  }

  /**
   * Check tentacle health
   */
  private async checkTentacles(): Promise<void> {
    // TODO: Check if tentacle processes are still running
    // For now, just update state
    this.state.activeTentacles = Array.from(this.tentacles.keys());
  }

  /**
   * Assign pending tasks to available tentacles
   */
  private async assignTasks(): Promise<void> {
    const pendingTasks = this.tasks.filter(t => t.status === "pending");
    const idleTentacles = Array.from(this.tentacles.values()).filter(t => t.status === "idle");
    
    // Simple assignment: first pending to first idle
    for (const task of pendingTasks) {
      const tentacle = idleTentacles.shift();
      if (!tentacle) break;
      
      task.status = "claimed";
      task.assignedTo = tentacle.id;
      task.updatedAt = new Date();
      
      tentacle.status = "busy";
      tentacle.currentTask = task.id;
      
      // Write task assignment to tentacle's queue
      await this.sendToTentacle(tentacle.id, {
        type: "task_assignment",
        payload: task,
      });
      
      this.log(`Assigned task "${task.subject}" to ${tentacle.id}`);
    }
    
    await this.saveTasks();
    await this.saveTentacles();
  }

  /**
   * Send a message to a tentacle's queue
   */
  private async sendToTentacle(
    tentacleId: string, 
    message: { type: string; payload: unknown }
  ): Promise<void> {
    const queueDir = join(this.options.octopaiDir, "queue", "tentacles", tentacleId);
    await mkdir(queueDir, { recursive: true });
    
    const filename = `${Date.now()}-${message.type}.json`;
    await writeFile(
      join(queueDir, filename),
      JSON.stringify({
        ...message,
        from: "brain",
        to: tentacleId,
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

  private async loadTentacles(): Promise<void> {
    const tentaclesDir = join(this.options.octopaiDir, "state", "tentacles");
    try {
      const files = await readdir(tentaclesDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await readFile(join(tentaclesDir, file), "utf-8");
        const tentacle: Tentacle = JSON.parse(content);
        this.tentacles.set(tentacle.id, tentacle);
      }
    } catch {
      // No tentacles yet
    }
  }

  private async saveTentacles(): Promise<void> {
    const tentaclesDir = join(this.options.octopaiDir, "state", "tentacles");
    for (const tentacle of this.tentacles.values()) {
      await writeFile(
        join(tentaclesDir, `${tentacle.id}.json`),
        JSON.stringify(tentacle, null, 2),
        "utf-8"
      );
    }
  }

  /**
   * Register a new tentacle
   */
  async registerTentacle(tentacle: Tentacle): Promise<void> {
    this.tentacles.set(tentacle.id, tentacle);
    await this.saveTentacles();
    this.log(`Registered tentacle: ${tentacle.id} (${tentacle.agent})`);
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
   * Get all tentacles
   */
  getTentacles(): Tentacle[] {
    return Array.from(this.tentacles.values());
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
  | { type: "approval_response"; originalId: string; approved: boolean; comment: string }
  | { type: "query"; query: string };
