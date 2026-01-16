/**
 * Brain - The central coordinator for Octopai
 * 
 * Runs a polling loop that:
 * 1. Reads human mail from sent/
 * 2. Processes arm messages from queue/ and NATS
 * 3. Assigns tasks to arms
 * 4. Sends status updates to human inbox
 */

import { readdir, readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { Maildir } from "../mail";
import { initDatabase, Database } from "../db";
import { DocWatcher, getDocWatcher, stopDocWatcher } from "../docs/watcher";
import { parsePlanFile, findPlanFiles, tasksToDatabaseFormat, type PlanParseResult } from "./plan-parser";
import { DocUpdateTracker } from "./doc-tracker";
import { NatsClient, TOPICS, type BrainMessage } from "../nats";
import type { BrainState, Task, QueueMessage, OctopaiConfig, Arm, Discovery, MessageType } from "../types";

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
  private seenArmIds: Set<string> = new Set();
  private running = false;
  private db: Database | null = null;
  private apiBaseUrl: string;
  private apiKey: string;
  private natsUrl!: string;
  private natsClient: NatsClient | null = null;
  private mailProcessor: MailProcessor;
  private stuckArmAnalyzer: StuckArmAnalyzer;
  private docTracker: DocUpdateTracker | null = null;
  // Track last stuck state per arm to avoid duplicate escalations
  private lastStuckState: Map<string, { stuckType: string; escalatedAt: Date }> = new Map();
  // Track idle arm prompt-response patterns to detect stuck loops
  private idleArmPromptTracker: Map<string, {
    promptCount: number;           // How many prompts sent without productive response
    lastPromptAt: Date;            // When we last prompted this arm
    lastProductiveAt: Date | null; // When arm last did real work
    escalationLevel: number;       // 0 = none, 1 = interrupt, 2 = compact, 3 = kill
  }> = new Map();

  /**
   * Log an activity entry
   */
  private logActivity(actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO activity (timestamp, actor, action, target, details) VALUES (?, ?, ?, ?, ?)`,
      [now, actor, action, target || null, JSON.stringify(details || {})]
    );
  }

  constructor(options: BrainOptions) {
    this.options = options;
    this.apiBaseUrl = options.apiBaseUrl || process.env.OCTOPAI_API_URL || "http://localhost:7777";
    this.apiKey = options.apiKey || process.env.OCTOPAI_API_KEY || "";
    this.natsUrl = process.env.OCTOPAI_NATS_URL || "nats://localhost:4222";
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

    // Initialize mail processor
    this.mailProcessor = new MailProcessor((msg) => this.log(msg));

    // Initialize stuck arm analyzer
    this.stuckArmAnalyzer = new StuckArmAnalyzer((msg) => this.log(msg));
  }

  /**
   * Connect to NATS and subscribe to brain messages
   */
  async startNats(): Promise<void> {
    try {
      this.natsClient = new NatsClient({
        serverUrl: this.natsUrl,
        clientId: `brain-${process.pid}`,
        debug: this.options.verbose,
      });
      
      await this.natsClient.connect();
      this.log(`Connected to NATS at ${this.natsUrl}`);
      
      // Subscribe to brain messages from arms
      this.natsClient.subscribe<BrainMessage>(TOPICS.BRAIN_MESSAGES, async (message) => {
        await this.handleBrainMessage(message);
      });
      
      this.log("Subscribed to brain messages on NATS");
    } catch (err) {
      this.log(`NATS not available: ${err}`);
      this.natsClient = null;
    }
  }

  /**
   * Disconnect from NATS
   */
  async stopNats(): Promise<void> {
    if (this.natsClient) {
      await this.natsClient.disconnect();
      this.natsClient = null;
      this.log("Disconnected from NATS");
    }
  }

  /**
   * Handle a message received via NATS
   */
  private async handleBrainMessage(message: BrainMessage): Promise<void> {
    this.log(`NATS: Received ${message.type} from ${message.from}`);
    
    // Convert NATS message to QueueMessage format and handle
    const queueMessage: QueueMessage = {
      id: `nats-${Date.now()}`,
      from: message.from,
      to: message.to,
      type: message.type as MessageType,
      payload: message.payload,
      timestamp: new Date(message.timestamp),
    };
    
    await this.handleArmMessage(queueMessage);
  }

  /**
    * Make an API request with authentication
    */
  private async apiRequest<T>(
    path: string,
    options: RequestInit = {},
    timeoutMs: number = 2000
  ): Promise<T | null> {
    try {
      const url = `${this.apiBaseUrl}${path}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          ...options.headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.log(`API error: ${response.status} ${response.statusText}`);
        return null;
      }

      return (await response.json()) as T;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Request timed out - API not available
      }
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
    
    // Initialize doc update tracker
    this.docTracker = new DocUpdateTracker(this.db, this.options.octopaiDir, process.cwd());
    
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
    
     // Step 4: Check for stuck arms and help them
     await this.checkStuckArms();
     
     // Step 4b: Check for idle arms stuck in prompt loops
     await this.checkIdleArmStuckLoops();
     
     // Step 5: Assign initial tasks to new arms
    await this.assignInitialTasks();
    
    // Step 6: Assign pending tasks to idle arms
    await this.assignTasks();
    
    // Step 7: Prompt idle arms to check for work or file changes
    await this.promptIdleArms();
    
    // Step 8: Sync tasks from plan files
    await this.syncPlanTasks();
    
    // Step 8b: Check for documentation update triggers
    await this.checkDocUpdateTrigger();
    
    // Step 9: Save state
    await this.saveState();
    
    // Step 10: Notify Observatory of poll completion
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
     this.logActivity("brain", "started", undefined, { pollIntervalMs: this.options.pollIntervalMs });
     
     // Connect to NATS
     await this.startNats();
     
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
     
     // Disconnect from NATS
     await this.stopNats();
     
     this.state.status = "stopped";
     await this.saveState();
     await this.notifyObservatory("stopped");
     this.logActivity("brain", "stopped");
     this.log("Brain stopped");
   }

   /**
    * Run a single poll cycle and exit
    */
   async runOnce(): Promise<void> {
     this.state.status = "running";
     this.state.startedAt = this.state.startedAt || new Date().toISOString();
     
     // Connect to NATS (optional)
     await this.startNats();
     
     await this.notifyObservatory("started");
     await this.poll();
     
     // Disconnect from NATS
     await this.stopNats();
     
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
    * Shutdown the brain and clean up resources
    * This should be called after run() or runOnce() completes
    */
   async shutdown(): Promise<void> {
     // Stop the doc watcher
     stopDocWatcher();

     // Disconnect from NATS
     await this.stopNats();

     // Close the database
     if (this.db) {
       this.db.close();
       this.db = null;
     }

    this.log("Brain shutdown complete");
  }

  /**
   * Process new mail from human (in sent/ folder)
   */
  private async processHumanMail(): Promise<void> {
    const messages = await this.sent.list("new");

    if (messages.length === 0) return;

    this.log(`Processing ${messages.length} human message(s)...`);

    // Build context for LLM
    const armContexts = Array.from(this.arms.values()).map(arm => ({
      name: arm.name,
      domain: (arm as Arm & { domain?: string }).domain || "general",
      status: arm.status,
    }));

    const recentActivity = this.db
      ? (this.db.query("SELECT actor, action FROM activity ORDER BY timestamp DESC LIMIT 5").all() as Array<{ actor: string; action: string }>)
        .map(a => `${a.actor} ${a.action}`)
      : [];

    for (const message of messages) {
      this.log(`Processing: ${message.subject}`);

      // Use LLM to determine intent
      const intent = await this.mailProcessor.processMessage(
        message.subject,
        message.body,
        {
          availableArms: armContexts,
          pendingTasks: this.tasks.filter(t => t.status === "pending").length,
          recentActivity,
        }
      );

      this.log(`Intent: ${intent.type} (${intent.reasoning})`);

      // Handle the intent
      switch (intent.type) {
        case "new_task":
          await this.createTask(
            intent.subject || message.subject,
            intent.body || message.body,
            message.id,
            intent.priority,
            intent.domain
          );
          break;

        case "doc_update":
          await this.createDocUpdateTask(
            intent.subject || message.subject,
            intent.body || message.body,
            intent.targetDoc,
            message.id
          );
          break;

        case "approval_response":
          await this.handleApprovalResponse(
            intent.originalId || "",
            intent.approved || false,
            intent.comment || message.body
          );
          break;

        case "query":
          await this.handleQuery(intent.query || "status", message.id);
          break;

        case "prompt_arm":
          if (intent.armName && intent.instruction) {
            await this.sendPromptToArm(intent.armName, intent.instruction);
            this.log(`Prompted arm ${intent.armName} directly`);
            this.logActivity("brain", "arm_prompted", intent.armName, {
              reason: "human_mail",
              instruction: intent.instruction.slice(0, 100),
            });
          }
          break;

        case "escalate":
          this.log(`Escalating message to human: ${message.subject}`);
          await this.sendToHuman({
            subject: `[octopai] Cannot process: ${message.subject}`,
            body: `I received this message but couldn't determine the appropriate action:\n\n${message.body}`,
          });
          break;

        default:
          this.log(`Unknown intent type: ${(intent as { type: string }).type}`);
      }

      // Mark as processed
      await this.sent.markSeen(message.id);
    }
  }

  /**
   * Create a new task (updated to support priority and domain)
   */
  private async createTask(
    subject: string,
    description: string,
    mailThreadId?: string,
    priority?: "critical" | "high" | "normal" | "low",
    domain?: string
  ): Promise<Task> {
    const task: Task = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      subject,
      description,
      status: "pending",
      priority: priority || "normal",
      domain,
      createdAt: new Date(),
      updatedAt: new Date(),
      mailThreadId,
    };

    this.tasks.push(task);
    await this.saveTasks();

    this.log(`Created task: ${task.subject} (${task.id}) domain=${domain || "any"} priority=${task.priority}`);
    this.logActivity("brain", "task_created", task.id, { subject, priority: task.priority, domain, mailThreadId });

    return task;
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

      case "status_report": {
        const payload = message.payload as {
          id: string;
          taskId: string;
          armId: string;
          status: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
          summary: string;
          issues: string[];
          blockers: string[];
          nextSteps?: string;
          filesChanged: string[];
          testsStatus?: "passing" | "failing" | "not_run";
        };
        await this.handleStatusReport(payload);
        break;
      }

      case "task_assignment": {
        // Arm is claiming or releasing a task
        const payload = message.payload as { action: string; taskId: string };
        if (payload.action === "claim") {
          await this.claimTaskForArm(message.from, payload.taskId);
        }
        break;
      }

      case "status_update": {
        // Arm is updating their status on a task (e.g., acknowledging it)
        const payload = message.payload as { taskId: string; status: string; message?: string };
        await this.updateTaskStatus(message.from, payload.taskId, payload.status, payload.message);
        break;
      }
    }
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
    this.logActivity("brain", "task_created", taskId, { subject, priority: task.priority, domain: "docs", targetDoc });
    
    return task;
  }

  /**
   * Handle an arm claiming a task
   * Updates the database to assign the task to the arm
   */
  private async claimTaskForArm(armId: string, taskId: string): Promise<void> {
    this.log(`Arm ${armId} claiming task ${taskId}`);
    
    try {
      const now = new Date().toISOString();
      
      if (!this.db) {
        this.log(`Database not initialized, cannot claim task`);
        return;
      }
      
      // Update task in database - set assigned_to and add to assigned_arms array
      this.db.run(`
        UPDATE tasks 
        SET assigned_to = ?,
            assigned_arms = json_insert(
              COALESCE(assigned_arms, '[]'),
              '$[#]',
              ?
            ),
            status = CASE WHEN status = 'pending' THEN 'claimed' ELSE status END,
            updated_at = ?
        WHERE id = ?
      `, [armId, armId, now, taskId]);
      
      // Also update the in-memory tasks array
      const task = this.tasks.find(t => t.id === taskId);
      if (task) {
        task.assignedTo = armId;
        task.status = task.status === "pending" ? "claimed" : task.status;
        task.updatedAt = new Date();
      }
      
      this.logActivity("brain", "task_claimed", taskId, { armId });
      this.log(`Task ${taskId} claimed by arm ${armId}`);
    } catch (err) {
      this.log(`Error claiming task ${taskId} for arm ${armId}: ${err}`);
    }
  }

  /**
   * Handle an arm updating their status on a task (e.g., acknowledging work started)
   */
  private async updateTaskStatus(armId: string, taskId: string, status: string, message?: string): Promise<void> {
    this.log(`Arm ${armId} updating task ${taskId} status to ${status}`);
    
    try {
      const now = new Date().toISOString();
      
      if (!this.db) {
        this.log(`Database not initialized, cannot update task status`);
        return;
      }
      
      // Map incoming status to valid task status
      let dbStatus = status;
      if (status === "in_progress") {
        dbStatus = "in_progress";
      } else if (status === "claimed") {
        dbStatus = "claimed";
      }
      
      // Update task in database
      this.db.run(`
        UPDATE tasks 
        SET status = ?,
            assigned_to = COALESCE(assigned_to, ?),
            assigned_arms = CASE 
              WHEN assigned_arms IS NULL OR assigned_arms = '[]' THEN json_array(?)
              WHEN NOT json_valid(assigned_arms) THEN json_array(?)
              WHEN NOT EXISTS (SELECT 1 FROM json_each(assigned_arms) WHERE value = ?) 
                THEN json_insert(assigned_arms, '$[#]', ?)
              ELSE assigned_arms
            END,
            updated_at = ?
        WHERE id = ?
      `, [dbStatus, armId, armId, armId, armId, armId, now, taskId]);
      
      // Also update the in-memory tasks array
      const task = this.tasks.find(t => t.id === taskId);
      if (task) {
        task.status = dbStatus as Task["status"];
        task.assignedTo = task.assignedTo || armId;
        task.updatedAt = new Date();
      }
      
      this.logActivity("brain", "task_status_update", taskId, { armId, status: dbStatus, message });
      this.log(`Task ${taskId} status updated to ${dbStatus} by arm ${armId}`);
    } catch (err) {
      this.log(`Error updating task ${taskId} status: ${err}`);
    }
  }

  /**
   * Complete a task
   * Enhanced for progressive planning: checks for status reports with issues
   * and triggers plan re-evaluation to determine next tasks
   */
  private async completeTask(taskId: string, summary: string, artifacts: string[]): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      this.log(`Task not found: ${taskId}`);
      return;
    }
    
    // Check for status reports with issues for this task
    const statusReportsWithIssues = await this.getStatusReportsWithIssues(taskId);
    
    if (statusReportsWithIssues.length > 0) {
      // There are issues - create a verification task instead of just completing
      const latestReport = statusReportsWithIssues[0]!; // Most recent report (guaranteed by length check)
      this.log(`Task ${taskId} has ${statusReportsWithIssues.length} status reports with issues. Creating verification task.`);
      
      await this.createVerificationTask(task, {
        id: latestReport.id,
        summary: latestReport.summary,
        issues: latestReport.issues,
        nextSteps: latestReport.nextSteps,
        testsStatus: latestReport.testsStatus,
      });
      
      // The verification task creation also completes the original task
      return;
    }
    
    task.status = "completed";
    task.completedAt = new Date();
    task.updatedAt = new Date();
    task.artifacts = artifacts;
    
    this.state.completedToday++;
    await this.saveTasks();
    
    // Log activity
    this.logActivity("brain", "task_completed", taskId, { subject: task.subject, artifacts });
    
    // Check for tasks that were blocked on this task and unblock them
    await this.unblockDependentTasks(taskId);
    
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
   * Get status reports with issues for a task
   */
  private async getStatusReportsWithIssues(taskId: string): Promise<Array<{
    id: string;
    summary: string;
    issues: string[];
    nextSteps?: string;
    testsStatus?: "passing" | "failing" | "not_run";
  }>> {
    if (!this.db) return [];
    
    try {
      const rows = this.db.query(`
        SELECT id, summary, issues, next_steps, tests_status
        FROM status_reports
        WHERE task_id = ? AND status IN ('issues_found', 'completed_with_issues', 'needs_review')
        ORDER BY created_at DESC
      `).all(taskId) as Array<{
        id: string;
        summary: string;
        issues: string;
        next_steps: string | null;
        tests_status: string | null;
      }>;
      
      return rows.map(row => ({
        id: row.id,
        summary: row.summary,
        issues: JSON.parse(row.issues || "[]") as string[],
        nextSteps: row.next_steps || undefined,
        testsStatus: row.tests_status as "passing" | "failing" | "not_run" | undefined,
      }));
    } catch (err) {
      this.log(`Error querying status reports: ${err}`);
      return [];
    }
  }

  /**
   * Unblock tasks that were waiting on a completed task
   * Part of progressive planning - re-evaluates which tasks can now proceed
   */
  private async unblockDependentTasks(completedTaskId: string): Promise<void> {
    if (!this.db) return;
    
    try {
      // Find tasks that depend on the completed task
      const dependentRows = this.db.query(`
        SELECT td.task_id, t.subject, t.dependency_blocked
        FROM task_dependencies td
        JOIN tasks t ON td.task_id = t.id
        WHERE td.depends_on_task_id = ?
        AND t.status IN ('pending', 'blocked')
      `).all(completedTaskId) as Array<{
        task_id: string;
        subject: string;
        dependency_blocked: number;
      }>;
      
      for (const row of dependentRows) {
        // Check if this task has any other unmet dependencies
        const unmetDeps = this.db.query(`
          SELECT COUNT(*) as count
          FROM task_dependencies td
          WHERE td.task_id = ?
          AND td.depends_on_task_id != ?
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.id = td.depends_on_task_id
            AND t.status = 'completed'
          )
        `).get(row.task_id, completedTaskId) as { count: number };
        
        if (unmetDeps.count === 0) {
          // All dependencies met - unblock the task
          const task = this.tasks.find(t => t.id === row.task_id);
          if (task && (task.status === "blocked" || task.status === "pending")) {
            task.status = "pending";
            task.updatedAt = new Date();
            
            // Update the dependency_blocked flag in DB
            this.db.run(`
              UPDATE tasks SET dependency_blocked = 0, status = 'pending', updated_at = ?
              WHERE id = ?
            `, [new Date().toISOString(), row.task_id]);
            
            this.log(`Unblocked task: ${row.subject} (was waiting on ${completedTaskId})`);
            this.logActivity("brain", "task_unblocked", row.task_id, {
              completedDependency: completedTaskId,
              subject: row.subject,
            });
          }
        }
      }
      
      await this.saveTasks();
    } catch (err) {
      this.log(`Error unblocking dependent tasks: ${err}`);
    }
  }

  /**
   * Handle a status report from an arm
   * Status reports allow the brain to re-evaluate plans based on progress, issues, or blockers
   */
  private async handleStatusReport(report: {
    id: string;
    taskId: string;
    armId: string;
    status: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
    summary: string;
    issues: string[];
    blockers: string[];
    nextSteps?: string;
    filesChanged: string[];
    testsStatus?: "passing" | "failing" | "not_run";
  }): Promise<void> {
    const task = this.tasks.find(t => t.id === report.taskId);
    if (!task) {
      this.log(`Status report for unknown task: ${report.taskId}`);
      return;
    }

    // Store status report in database
    if (this.db) {
      const now = new Date().toISOString();
      try {
        this.db.run(`
          INSERT INTO status_reports (id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          report.id,
          report.taskId,
          report.armId,
          report.status,
          report.summary,
          JSON.stringify(report.issues),
          JSON.stringify(report.blockers),
          report.nextSteps || null,
          JSON.stringify(report.filesChanged),
          report.testsStatus || null,
          now,
        ]);
        this.log(`Stored status report: ${report.id} for task ${report.taskId}`);
      } catch (err) {
        this.log(`Error storing status report: ${err}`);
      }
    }

    // Log activity
    this.logActivity("brain", "status_report_received", report.taskId, {
      reportId: report.id,
      armId: report.armId,
      status: report.status,
      issueCount: report.issues.length,
      blockerCount: report.blockers.length,
    });

    // Handle based on status
    switch (report.status) {
      case "blocked": {
        // Update task status to blocked
        task.status = "blocked";
        task.updatedAt = new Date();
        await this.saveTasks();

        // Notify human about blockers
        await this.sendToHuman({
          subject: `[octopai] Task blocked: ${task.subject}`,
          body: `Task "${task.subject}" is blocked by arm ${report.armId}.\n\n## Summary\n${report.summary}\n\n## Blockers\n${report.blockers.map(b => `- ${b}`).join("\n") || "No specific blockers listed"}\n\n## Next Steps Suggested\n${report.nextSteps || "None specified"}`,
          headers: {
            "X-Octopai-Task-Id": report.taskId,
            "X-Octopai-Type": "task-blocked",
          },
        });
        this.log(`Task ${task.subject} blocked. Notified human.`);
        break;
      }

      case "issues_found": {
        // Log issues but don't change task status yet
        this.log(`Issues found in task ${task.subject}: ${report.issues.length} issues`);
        
        // If significant issues, notify human
        if (report.issues.length > 0) {
          await this.sendToHuman({
            subject: `[octopai] Issues found: ${task.subject}`,
            body: `Arm ${report.armId} found issues while working on "${task.subject}":\n\n## Issues\n${report.issues.map(i => `- ${i}`).join("\n")}\n\n## Summary\n${report.summary}\n\n## Next Steps\n${report.nextSteps || "Continuing work..."}`,
            headers: {
              "X-Octopai-Task-Id": report.taskId,
              "X-Octopai-Type": "issues-found",
            },
          });
        }
        break;
      }

      case "needs_review": {
        // Task needs human or other arm review
        this.log(`Task ${task.subject} needs review`);
        await this.sendToHuman({
          subject: `[octopai] Review needed: ${task.subject}`,
          body: `Arm ${report.armId} requests review for "${task.subject}":\n\n## Summary\n${report.summary}\n\n## Files Changed\n${report.filesChanged.map(f => `- ${f}`).join("\n") || "None listed"}\n\n## Tests\n${report.testsStatus || "Not run"}`,
          headers: {
            "X-Octopai-Task-Id": report.taskId,
            "X-Octopai-Type": "needs-review",
          },
        });
        break;
      }

      case "completed_with_issues": {
        // Create a verification task for follow-up
        await this.createVerificationTask(task, report);
        break;
      }

      case "on_track": {
        // Just log progress, no action needed
        this.log(`Task ${task.subject} progressing: ${report.summary}`);
        break;
      }
    }
  }

  /**
   * Create a verification/polish task when a task completes with issues
   * This is part of progressive planning - the brain re-evaluates and creates follow-up work
   */
  private async createVerificationTask(
    originalTask: Task,
    report: {
      id: string;
      summary: string;
      issues: string[];
      nextSteps?: string;
      testsStatus?: "passing" | "failing" | "not_run";
    }
  ): Promise<Task> {
    const taskId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    
    const issuesList = report.issues.length > 0 
      ? `## Issues to Address\n${report.issues.map(i => `- ${i}`).join("\n")}\n\n`
      : "";
    
    const testInfo = report.testsStatus === "failing"
      ? "## ⚠️ Tests are failing - this should be addressed first\n\n"
      : "";

    const description = `This is a verification task for: "${originalTask.subject}"

The original task was completed but with issues that need attention.

## Original Completion Summary
${report.summary}

${issuesList}${testInfo}## Suggested Next Steps
${report.nextSteps || "Review and polish the implementation"}

## Original Task ID
${originalTask.id}`;

    const verifyTask: Task = {
      id: taskId,
      subject: `Verify & Polish: ${originalTask.subject}`,
      description,
      status: "pending",
      priority: originalTask.priority === "critical" ? "critical" : "high",
      classification: "qa", // Verification tasks are QA-type work
      domain: originalTask.domain,
      createdAt: new Date(),
      updatedAt: new Date(),
      context: {
        notes: `Follow-up verification for ${originalTask.id}. Status report: ${report.id}`,
      },
    };

    this.tasks.push(verifyTask);
    await this.saveTasks();

    // Mark original task as completed (with issues noted)
    originalTask.status = "completed";
    originalTask.completedAt = new Date();
    originalTask.updatedAt = new Date();
    this.state.completedToday++;
    await this.saveTasks();

    this.log(`Created verification task: ${verifyTask.subject} (${taskId})`);
    this.logActivity("brain", "verification_task_created", taskId, {
      originalTaskId: originalTask.id,
      issueCount: report.issues.length,
      testsStatus: report.testsStatus,
    });

    // Notify human
    await this.sendToHuman({
      subject: `[octopai] Verification needed: ${originalTask.subject}`,
      body: `Task "${originalTask.subject}" completed with issues. Created verification task.\n\n## Issues\n${report.issues.map(i => `- ${i}`).join("\n") || "No specific issues listed"}\n\n## Original Summary\n${report.summary}`,
      headers: {
        "X-Octopai-Task-Id": taskId,
        "X-Octopai-Type": "verification-task-created",
      },
    });

    return verifyTask;
  }

   /**
    * Handle a discovery from an arm
    */
   private async handleDiscovery(armId: string, discovery: Discovery): Promise<void> {
     const discoveryId = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
     
     // Store in database
     if (this.db) {
       const now = new Date().toISOString();
       this.db.run(`
         INSERT INTO discoveries (id, arm_id, arm_name, kind, title, details, file_path, line_number, severity, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
       `, [
         discoveryId,
         armId,
         armId, // arm_name is the same as arm_id for now
         discovery.kind,
         discovery.title,
         discovery.details,
         discovery.file || null,
         discovery.line || null,
         discovery.severity || "info",
         now,
         now,
       ]);
       
       this.log(`Stored discovery: ${discovery.title} (${discovery.kind})`);
     }
     
     // Also notify human for high-severity discoveries
     if (discovery.severity === "error" || discovery.severity === "warning") {
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
   }

   /**
    * Get discoveries relevant to an arm's domain and context
    */
   async getDiscoveriesForArm(armId: string, domain: string, options?: {
     limit?: number;
     severity?: string[];
     status?: string[];
     filePattern?: string;
   }): Promise<Array<{
     id: string;
     kind: string;
     title: string;
     details: string;
     filePath?: string;
     lineNumber?: number;
     severity: string;
     createdAt: string;
   }>> {
     if (!this.db) return [];
     
     const limit = options?.limit || 20;
     let query = `
       SELECT id, kind, title, details, file_path, line_number, severity, status, created_at
       FROM discoveries
       WHERE status = 'open'
     `;
     
      const params: (string | number)[] = [];
      
      // Filter by severity if specified
      if (options?.severity && options.severity.length > 0) {
        query += ` AND severity IN (${options.severity.map(() => '?').join(',')})`;
        params.push(...options.severity);
      }
      
      // Filter by file pattern if specified
      if (options?.filePattern) {
        query += ` AND (file_path LIKE ? OR file_path GLOB ?)`;
        params.push(`%${options.filePattern}%`, `*${options.filePattern}*`);
      }
      
      query += ` ORDER BY 
          CASE severity 
            WHEN 'error' THEN 1 
            WHEN 'warning' THEN 2 
            WHEN 'info' THEN 3 
          END,
          created_at DESC
        LIMIT ?`;
      params.push(limit);
      
      try {
        const stmt = this.db.query(query);
        const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Array<{
          id: string;
          kind: string;
          title: string;
          details: string;
          file_path: string | null;
          line_number: number | null;
          severity: string;
          status: string;
          created_at: string;
        }>;
       
       return rows.map(row => ({
         id: row.id,
         kind: row.kind,
         title: row.title,
         details: row.details,
         filePath: row.file_path || undefined,
         lineNumber: row.line_number || undefined,
         severity: row.severity,
         createdAt: row.created_at,
       }));
     } catch (err) {
       this.log(`Error querying discoveries: ${err}`);
       return [];
     }
   }

   /**
    * Search discoveries using full-text search
    */
    async searchDiscoveries(query: string, options?: {
      limit?: number;
      severity?: string[];
    }): Promise<Array<{
      id: string;
      kind: string;
      title: string;
      details: string;
      severity: string;
      createdAt: string;
    }>> {
      if (!this.db) return [];
      
      const limit = options?.limit || 20;
      
      try {
        // Build FTS query with parameters
        const ftsQuery = `
          SELECT d.id, d.kind, d.title, d.details, d.severity, d.created_at
          FROM discoveries d
          JOIN discoveries_fts fts ON d.rowid = fts.rowid
          WHERE discoveries_fts MATCH ?
          ${options?.severity ? `AND d.severity IN (${options.severity.map(() => '?').join(',')})` : ''}
          ORDER BY d.created_at DESC
          LIMIT ?
        `;
        
        const ftsParams: (string | number)[] = [query];
        if (options?.severity) {
          ftsParams.push(...options.severity);
        }
        ftsParams.push(limit);
        
        const stmt = this.db.query(ftsQuery);
        const rows = ftsParams.length > 0 ? stmt.all(...ftsParams) : stmt.all();
        const typedRows = rows as Array<{
          id: string;
          kind: string;
          title: string;
          details: string;
          severity: string;
          created_at: string;
        }>;
        
        return typedRows.map(row => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          details: row.details,
          severity: row.severity,
          createdAt: row.created_at,
        }));
      } catch (err) {
        // FTS might not be available, fall back to LIKE search
        this.log(`FTS search failed, falling back to LIKE: ${err}`);
        return this.getDiscoveriesForArm("system", "general", {
          limit,
          severity: options?.severity,
          filePattern: query,
        });
      }
    }

    /**
     * Get discoveries summary for context
    */
   async getDiscoveriesContext(armId: string, domain: string): Promise<string> {
     const discoveries = await this.getDiscoveriesForArm(armId, domain, { limit: 10 });
     
     if (discoveries.length === 0) {
       return "No prior discoveries recorded.";
     }
     
     const lines = [`## Prior Discoveries (${discoveries.length} open)`];
     
     for (const d of discoveries) {
       lines.push(`- **[${d.severity.toUpperCase()}] ${d.title}**`);
       lines.push(`  - Kind: ${d.kind}`);
       if (d.filePath) {
         lines.push(`  - File: ${d.filePath}${d.lineNumber ? `:${d.lineNumber}` : ""}`);
       }
       lines.push(`  - ${d.details.slice(0, 200)}${d.details.length > 200 ? "..." : ""}`);
     }
     
     return lines.join("\n");
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

    // Scan for running arm processes that aren't tracked
    await this.scanForRunningArms();

    // Check for stale arms (no heartbeat in timeout period)
    await this.checkStaleArms();

    this.state.activeArms = Array.from(this.arms.keys());
  }

  /**
    * Scan for running arm processes that aren't in our tracked list
    * This catches arms that were spawned before the brain started or whose
    * sessions were lost due to API server restart
    */
  private async scanForRunningArms(): Promise<void> {
    if (!this.db) {
      this.log("scanForRunningArms: no database");
      return;
    }

    // Get all known arms from database (including stopped ones)
    const knownArms = this.db.query(`
      SELECT id, name, pid, status, domain, harness
      FROM arms
    `).all() as Array<{ id: string; name: string; pid: number | null; status: string; domain: string; harness: string }>;

    this.log(`scanForRunningArms: found ${knownArms.length} known arms in database`);

    for (const arm of knownArms) {
      // Skip if already tracking this arm
      if (this.arms.has(arm.id)) {
        this.log(`  ${arm.name}: already tracked`);
        continue;
      }

      // Skip if no PID or already marked as stopped
      if (!arm.pid) {
        this.log(`  ${arm.name}: no PID`);
        continue;
      }

      if (arm.status === "stopped") {
        this.log(`  ${arm.name}: marked as stopped (PID ${arm.pid}), checking if alive...`);
      } else {
        this.log(`  ${arm.name}: status=${arm.status} (PID ${arm.pid}), checking...`);
      }

      // Check if process is running
      try {
        process.kill(arm.pid, 0);
        // Process is alive! Check if we can actually use it

        // For API harness arms, we need the API server to be available
        // Otherwise we can't communicate with the arm
        if (arm.harness === "opencode-api") {
          const apiAvailable = await this.isApiServerAvailable();
          if (!apiAvailable) {
            this.log(`  ${arm.name}: PROCESS ALIVE (PID ${arm.pid}), but API server unavailable - skipping`);
            continue;
          }
        }

        // Process is alive and usable! Add to tracked arms
        this.log(`  ${arm.name}: PROCESS ALIVE (PID ${arm.pid}), detecting...`);

        // Update database
        const now = new Date().toISOString();
        this.db.run(
          "UPDATE arms SET status = 'idle', last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [now, now, arm.id]
        );

        // Add to in-memory tracking
        const trackedArm: Arm = {
          id: arm.id,
          name: arm.name,
          agent: "opencode",
          status: "idle",
          pid: arm.pid,
          startedAt: new Date(),
        };
        (trackedArm as Arm & { domain?: string }).domain = arm.domain;
        this.arms.set(trackedArm.id, trackedArm);

        this.logActivity("brain", "arm_detected", arm.id, { pid: arm.pid, reason: "process_scan" });
      } catch {
        // Process dead
        if (arm.status !== "stopped") {
          this.log(`  ${arm.name}: process dead, marking as stopped`);
          this.db.run(
            "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
            [new Date().toISOString(), arm.id]
          );
        } else {
          this.log(`  ${arm.name}: already marked stopped, process confirmed dead`);
        }
      }
    }

    this.log(`scanForRunningArms: complete, now tracking ${this.arms.size} arms`);
  }

  /**
    * Mark arms as stopped if they haven't sent a heartbeat recently
    * NOTE: We check PID first because the API server may have restarted and lost
    * its in-memory sessions, but the arm processes might still be running.
    */
  private async checkStaleArms(): Promise<void> {
    for (const [armId, arm] of this.arms) {
      // First, check if the process is still running via PID
      // This works even if the API server restarted and lost its session tracking
      if (arm.pid) {
        try {
          process.kill(arm.pid, 0);
          // Process is alive - update status based on session if available
          const stateResult = await this.apiRequest<{ state: string; hasSession: boolean }>(`/api/arms/${armId}/state`);

          if (stateResult) {
            if (stateResult.hasSession && stateResult.state !== "stopped" && stateResult.state !== "dead") {
              // Arm is properly connected - sync status based on harness state
              const harnessStatus = stateResult.state === "processing" ? "busy" : "idle";
              if (arm.status !== harnessStatus) {
                this.log(`Arm ${armId}: syncing status from "${arm.status}" to "${harnessStatus}" based on harness state`);
                await this.syncArmStatus(armId, harnessStatus);
              } else {
                this.log(`Arm ${armId} is running (PID: ${arm.pid}, state: ${stateResult.state})`);
              }
              continue;
            } else if (!stateResult.hasSession) {
              // Process is running but API session was lost (server restart)
              // Keep the arm but prompt it to re-register
              this.log(`Arm ${armId} process alive but session lost (server restart), prompting to re-register...`);
              await this.sendPromptToArm(
                arm.name,
                "The API server restarted. Please re-register by calling the MCP tool octopai_register_session if available, or confirm you can still receive tasks."
              );
              continue;
            }
          } else {
            // API not available but process is running - keep the arm
            this.log(`Arm ${armId} is running (PID: ${arm.pid}, API unavailable)`);
            continue;
          }
        } catch {
          // Process is dead - mark as stopped
          this.log(`Arm ${armId} process dead (PID: ${arm.pid}), marking as stopped`);
          if (this.db) {
            this.db.run(
              "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
              [new Date().toISOString(), armId]
            );
          }
          this.arms.delete(armId);
          this.idleArmPromptTracker.delete(armId);
        }
      } else {
        // No PID - check via API session
        const stateResult = await this.apiRequest<{ state: string; hasSession: boolean }>(`/api/arms/${armId}/state`);

        if (stateResult && !stateResult.hasSession) {
          this.log(`Arm ${armId} has no session, marking as stopped`);
          await this.apiRequest(`/api/arms/${armId}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "stopped" }),
          });
          this.arms.delete(armId);
          this.idleArmPromptTracker.delete(armId);
        }
      }
    }

    // Also check DB for stale arms (heartbeat timeout)
    if (!this.db) return;

    // Get timeout from config (default 300 seconds = 5 minutes)
    let timeoutSeconds = 300;
    try {
      const row = this.db.query("SELECT value FROM config WHERE key = ?").get("arm_heartbeat_timeout_seconds") as { value: string } | null;
      if (row) {
        timeoutSeconds = parseInt(row.value, 10);
      }
    } catch {
      // Use default
    }

    const cutoffTime = new Date(Date.now() - timeoutSeconds * 1000).toISOString();

    // Find arms that haven't heartbeated recently and are not already in our in-memory list
    const armIds = Array.from(this.arms.keys());
    let staleQuery = `
      SELECT id, name, pid, last_heartbeat, status, harness
      FROM arms
      WHERE status NOT IN ('stopped', 'starting')
    `;

    if (armIds.length > 0) {
      staleQuery += ` AND id NOT IN (${armIds.map(() => "?").join(",")})`;
    }

    const staleArms = this.db.query(staleQuery).all(...armIds) as Array<{ id: string; name: string; pid: number | null; last_heartbeat: string | null; status: string; harness: string }>;

    for (const arm of staleArms) {
      // For API harness arms, skip if API server is unavailable
      // They can't communicate without the API server
      if (arm.harness === "opencode-api") {
        const apiAvailable = await this.isApiServerAvailable();
        if (!apiAvailable) {
          this.log(`Arm ${arm.id}: API harness, API server unavailable - skipping stale check`);
          continue;
        }
      }

      // Check if process is still running
      if (arm.pid) {
        try {
          process.kill(arm.pid, 0);
          // Process is alive but not in our arms map - may have been spawned externally
          // Keep it but don't add to active arms
          this.log(`Arm ${arm.id} has running process (PID: ${arm.pid}) but not tracked, marking as idle`);
          this.db.run(
            "UPDATE arms SET status = 'idle', updated_at = ? WHERE id = ?",
            [new Date().toISOString(), arm.id]
          );
          continue;
        } catch {
          // Process dead - mark as stopped
        }
      }

      // Process is dead or no PID - check heartbeat
      if (arm.last_heartbeat && new Date(arm.last_heartbeat) > new Date(cutoffTime)) {
        // Recently heartbeated, might be a race condition
        continue;
      }

      this.log(`Arm ${arm.id} is stale (last heartbeat: ${arm.last_heartbeat || "never"}), marking as stopped`);
      this.db.run(
        "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
        [new Date().toISOString(), arm.id]
      );
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
       
       // Get relevant discoveries for this arm
       const discoveries = await this.getDiscoveriesForArm(armId, domain, { limit: 10 });
       
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
         
         // Include discoveries context if any exist
         if (discoveries.length > 0) {
           task.context = {
             discoveries,
             notes: "Review these prior discoveries before starting work.",
           };
         }
         
         // Send to arm
         await this.sendToArm(armId, {
           type: "task_assignment",
           payload: task,
         });
         
         this.log(`Assigned initial task "${task.subject}" to ${armId} (domain: ${domain}, discoveries: ${discoveries.length})`);
         this.logActivity("brain", "task_assigned", task.id, { armId, domain, taskSubject: task.subject, discoveryCount: discoveries.length });
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
   * Prompt idle arms to check for tasks or wait for relevant file changes
   * This is called in the poll cycle to keep arms busy
   */
   private async promptIdleArms(): Promise<void> {
    const idleArms = Array.from(this.arms.values()).filter(arm => arm.status === "idle");

    if (idleArms.length === 0) {
      return;
    }

    // Check if API server is available for HTTP-based arm communication
    const apiAvailable = await this.isApiServerAvailable();

    this.log(`Checking ${idleArms.length} idle arm(s) for work...`);

    for (const arm of idleArms) {
      const armDomain = (arm as Arm & { domain?: string }).domain || "general";
      const isApi = await this.isApiHarness(arm.id);

      // Skip API harnesses if API server is unavailable
      if (isApi && !apiAvailable) {
        this.log(`Arm ${arm.id} [${armDomain}]: API harness, API server unavailable, skipping prompt`);
        continue;
      }

      // Get all unassigned pending tasks - any idle arm should be able to work on them
      // Domain is a preference, not a hard filter
      const availableTasks = this.tasks.filter(task => {
        if (task.status !== "pending") return false;
        if (task.assignedTo) return false; // Already assigned to someone
        return true; // Any unassigned pending task is fair game
      });

      // Also include tasks specifically assigned to this arm
      const myAssignedTasks = this.tasks.filter(task =>
        task.assignedTo === arm.id && task.status === "claimed"
      );

      const allTasks = [...myAssignedTasks, ...availableTasks];
      const uniqueTasks = allTasks.filter((task, index, self) =>
        index === self.findIndex(t => t.id === task.id)
      );

      if (uniqueTasks.length > 0) {
        // There are tasks available - prompt the arm to fetch its assignment
        const taskCount = uniqueTasks.length;
        const domainMatchCount = uniqueTasks.filter(t => !t.domain || t.domain === armDomain).length;
        
        this.log(`Arm ${arm.id} [${armDomain}]: ${taskCount} task(s) available (${domainMatchCount} domain match), prompting to check instructions...`);

        const promptSuccess = await this.sendPromptToArm(
          arm.name,
          `You have ${taskCount} task(s) available. Use the MCP tools to:\n` +
          `1. Call octopai_get_my_instructions to see your current assignment\n` +
          `2. If you have an active task, continue working on it\n` +
          `3. If no active task, call octopai_get_pending_tasks to see available tasks and claim one`
        );

        if (promptSuccess) {
          this.logActivity("brain", "arm_prompted", arm.id, {
            reason: "tasks_available",
            taskCount,
            domainMatchCount,
            domain: armDomain,
          });
        } else {
          this.log(`Failed to prompt arm ${arm.id} - API may not be running`);
        }
      } else {
        // No tasks available - arm should wait for file watcher notifications
        this.log(`Arm ${arm.id} [${armDomain}]: No pending tasks, waiting for file changes...`);

        // Log that arm is idle but monitoring
        this.logActivity("brain", "arm_waiting", arm.id, {
          reason: "no_pending_tasks",
          domain: armDomain,
          watchingPatterns: this.getDomainPatterns(armDomain),
        });
      }
    }
  }

  /**
   * Get file patterns an arm with a given domain would be interested in
   */
  private getDomainPatterns(domain: string): string[] {
    const patterns: Record<string, string[]> = {
      frontend: ["src/components/**", "src/web/**", "*.css", "*.scss", "*.tsx", "*.ts"],
      backend: ["src/api/**", "src/services/**", "src/db/**", "*.ts"],
      testing: ["**/*.test.*", "**/*.spec.*", "e2e/**", "__tests__/**"],
      docs: ["*.md", "docs/**", "README*"],
      architect: ["src/**", "*.toml", "*.json", "AGENTS.md", "docs/architecture/**"],
      devops: ["Dockerfile", ".github/**", "*.yml", "*.yaml", "infra/**"],
      general: ["src/**", "*.ts", "*.md"],
    };

    return patterns[domain] ?? patterns["general"] ?? [];
  }

  /**
   * Send a prompt to an arm via the API server
   */
  private async sendPromptToArm(armName: string, message: string, options?: { interrupt?: boolean }): Promise<boolean> {
    try {
      const url = `${this.apiBaseUrl}/api/arms/${armName}/prompt`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ prompt: message, interrupt: options?.interrupt }),
      });

      if (response.ok) {
        // Clear stuck state when we successfully send a prompt
        // (arm is now being actively interacted with)
        const arm = this.arms.get(armName);
        if (arm) {
          this.lastStuckState.delete(arm.id);
        }
      }

      return response.ok;
    } catch (err) {
      this.log(`Failed to send prompt to arm ${armName}: ${err}`);
      return false;
    }
  }

  /**
   * Get the harness state for an arm via the API server
   * This is more reliable than PTY log parsing for API harness arms
   */
  private async getArmHarnessState(armId: string): Promise<{ state: string; hasSession: boolean } | null> {
    try {
      return await this.apiRequest<{ state: string; hasSession: boolean }>(`/api/arms/${armId}/state`);
    } catch (err) {
      this.log(`Failed to get harness state for arm ${armId}: ${err}`);
      return null;
    }
  }

  /**
   * Sync an arm's status in the database and in-memory tracking
   * Used when harness state differs from database state
   */
   private async syncArmStatus(armId: string, status: "idle" | "busy" | "stopped"): Promise<void> {
     // Update in-memory
     const arm = this.arms.get(armId);
     if (arm) {
       arm.status = status;
       if (status === "stopped") {
         this.arms.delete(armId);
         this.idleArmPromptTracker.delete(armId);
       }
     }

    // Update database
    if (this.db) {
      const now = new Date().toISOString();
      this.db.run(
        "UPDATE arms SET status = ?, updated_at = ? WHERE id = ?",
        [status, now, armId]
      );
    }

    // Update via API (for broadcast)
    await this.apiRequest(`/api/arms/${armId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });

    this.log(`Synced arm ${armId} status to: ${status}`);
    this.logActivity("brain", "arm_status_synced", armId, { status, source: "harness_state" });
  }

  /**
   * Strip ANSI escape codes, TUI characters, and other non-content characters
   * This cleans up terminal output for analysis and display
   */
  private stripTerminalArtifacts(text: string): string {
    return text
      // ANSI escape sequences (colors, cursor movement, etc.)
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      // OSC sequences (terminal titles, hyperlinks, etc.)
      .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
      // CSI sequences that might be malformed
      .replace(/\x1B\[[\d;]*[A-Za-z]/g, "")
      // Other escape sequences
      .replace(/\x1B[PX^_].*?\x1B\\/g, "")
      // Control characters (keep \t \n \r)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      // Box-drawing and block characters (TUI borders)
      .replace(/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬]/g, "")
      // Block elements (used for progress bars, etc.)
      .replace(/[▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟■□▢▣▤▥▦▧▨▩▪▫▬▭▮▯]/g, "")
      // Geometric shapes (squares, diamonds, etc.)
      .replace(/[◆◇◈◉◊○◌◍◎●◐◑◒◓◔◕◖◗◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯⬝⬞⬟⬠⬡⬢⬣⬤⬥⬦⬧⬨⬩⬪⬫⬬⬭⬮⬯]/g, "")
      // More geometric and misc symbols
      .replace(/[⊙⊚⊛⊜⊝⊞⊟⊠⊡▰▱▲△▴▵▶▷▸▹►▻▼▽▾▿◀◁◂◃◄◅◆◇]/g, "")
      // Braille patterns (sometimes used for graphics)
      .replace(/[\u2800-\u28FF]/g, "")
      // Arrows and pointers
      .replace(/[←↑→↓↔↕↖↗↘↙↚↛↜↝↞↟↠↡↢↣↤↥↦↧↨↩↪↫↬↭↮↯↰↱↲↳↴↵↶↷↸↹↺↻↼↽↾↿⇀⇁⇂⇃⇄⇅⇆⇇⇈⇉⇊⇋⇌⇍⇎⇏⇐⇑⇒⇓⇔⇕⇖⇗⇘⇙⇚⇛⇜⇝⇞⇟⇠⇡⇢⇣⇤⇥⇦⇧⇨⇩⇪]/g, "")
      // Dashes and special punctuation used in TUIs
      .replace(/[—–·•‣⁃◦]/g, "")
      // Spinner and progress characters
      .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, "")
      // Clean up leftover punctuation artifacts (repeated quotes, etc.)
      .replace(/[']{2,}/g, "")
      .replace(/["]{2,}/g, "")
      // Collapse multiple spaces/newlines
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Check if an arm is using an API-based harness (opencode-api)
   * API harnesses don't have PTY output, so log analysis is unreliable
   */
  private async isApiHarness(armId: string): Promise<boolean> {
    if (!this.db) return false;
    try {
      const row = this.db.query("SELECT harness FROM arms WHERE id = ?").get(armId) as { harness: string } | null;
      return row?.harness === "opencode-api";
    } catch {
      return false;
    }
  }

  /**
   * Check if an arm has sent a recent heartbeat
   * Recent heartbeat indicates the arm is still active
   */
  private async hasRecentHeartbeat(armId: string, maxAgeSeconds = 60): Promise<boolean> {
    if (!this.db) return false;
    try {
      const row = this.db.query("SELECT last_heartbeat FROM arms WHERE id = ?").get(armId) as { last_heartbeat: string } | null;
      if (!row?.last_heartbeat) return false;
      const lastHeartbeat = new Date(row.last_heartbeat);
      const now = new Date();
      const secondsSinceHeartbeat = (now.getTime() - lastHeartbeat.getTime()) / 1000;
      return secondsSinceHeartbeat < maxAgeSeconds;
    } catch {
      return false;
    }
  }

  /**
   * Check if the API server is available
   * Used to determine if we can communicate with arms via HTTP
   */
  private async isApiServerAvailable(): Promise<boolean> {
    if (!this.apiBaseUrl) return false;
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/health`, {
        method: "GET",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Read recent logs for an arm from the log file
   * Returns cleaned output with TUI artifacts stripped
   */
  private async readArmLogs(armId: string, tailLines = 100): Promise<string> {
    const logPath = join(this.options.octopaiDir, "logs", `${armId}.log`);
    try {
      const content = await readFile(logPath, "utf-8");
      const lines = content.split("\n");
      const rawOutput = lines.slice(-tailLines).join("\n");
      return this.stripTerminalArtifacts(rawOutput);
    } catch {
      return "";
    }
  }

  /**
   * Check for stuck arms and help them
   * 
   * This method:
   * 1. First checks harness state via API (most reliable for API harness arms)
   * 2. Syncs harness state with database if they've drifted
   * 3. For arms that appear busy, uses LLM to analyze PTY logs for stuck state
   * 4. Takes appropriate action (answer question, approve, escalate, etc.)
   */
  private async checkStuckArms(): Promise<void> {
    // Get arms that are marked as busy (they should be working on something)
    const busyArms = Array.from(this.arms.values()).filter(arm => arm.status === "busy");

    if (busyArms.length === 0) {
      return;
    }

    this.log(`Checking ${busyArms.length} busy arm(s) for stuck state...`);

    for (const arm of busyArms) {
      const armDomain = (arm as Arm & { domain?: string }).domain || "general";
      
      // First, check harness state via API - this is more reliable than PTY log parsing
      // especially for API harness arms (opencode-api)
      const harnessState = await this.getArmHarnessState(arm.id);
      
      if (harnessState) {
        // Handle based on harness state
        if (harnessState.state === "idle") {
          // Harness says idle but DB says busy - sync them
          this.log(`Arm ${arm.name}: harness state is "idle" but DB says "busy", syncing...`);
          await this.syncArmStatus(arm.id, "idle");
          arm.status = "idle";
          continue;
         } else if (harnessState.state === "dead" || harnessState.state === "stopped") {
           // Arm is dead/stopped - update DB
           this.log(`Arm ${arm.name}: harness state is "${harnessState.state}", marking as stopped`);
           await this.syncArmStatus(arm.id, "stopped");
           continue;
        } else if (harnessState.state === "error") {
          // Arm is in error state - this might need intervention
          this.log(`Arm ${arm.name}: harness state is "error", will analyze logs`);
          // Fall through to log analysis
        } else if (harnessState.state === "processing") {
          // Arm is actively processing - check how long
          // If it's been processing for too long, it might be stuck
          this.log(`Arm ${arm.name}: harness confirms "processing" state`);
          // Fall through to log analysis to check if it's stuck
        }
        // Could not get harness state - decide how to proceed based on harness type
        const isApi = await this.isApiHarness(arm.id);
        if (isApi) {
          // For API harnesses, we can't reliably analyze logs
          // Instead, check if the arm is sending heartbeats (indicating it's active)
          const hasRecentHb = await this.hasRecentHeartbeat(arm.id, 60);
          if (hasRecentHb) {
            this.log(`Arm ${arm.name}: API harness with recent heartbeat, assuming active`);
            continue;
          } else {
            // No recent heartbeat - might be truly stuck or the API server is down
            this.log(`Arm ${arm.name}: API harness with no recent heartbeat, will analyze logs`);
            // Fall through to log analysis as a last resort
          }
        } else {
          this.log(`Arm ${arm.name}: could not get harness state, falling back to log analysis`);
        }
      }
      
      // Read recent logs for this arm
      const recentOutput = await this.readArmLogs(arm.name, 100);
      
      if (!recentOutput || recentOutput.trim().length < 50) {
        // No significant output - might be starting up or truly idle
        this.log(`Arm ${arm.name}: insufficient log output to analyze`);
        continue;
      }

      // Get current task description for context
      let currentTaskDescription: string | undefined;
      if (arm.currentTask) {
        const task = this.tasks.find(t => t.id === arm.currentTask);
        currentTaskDescription = task ? `${task.subject}: ${task.description?.slice(0, 200)}` : undefined;
      }

      // Analyze if the arm is stuck
      const analysis = await this.stuckArmAnalyzer.analyze(
        arm.name,
        armDomain,
        recentOutput,
        currentTaskDescription
      );

      if (!analysis.isStuck) {
        this.log(`Arm ${arm.name}: not stuck (${analysis.reasoning})`);
        continue;
      }

      // Arm is stuck - take action
      this.log(`Arm ${arm.name} is STUCK: ${analysis.stuckType} (confidence: ${analysis.confidence}) - ${analysis.reasoning}`);
      this.logActivity("brain", "arm_stuck_detected", arm.id, {
        stuckType: analysis.stuckType,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        suggestedAction: analysis.suggestedAction,
      });

      // Handle based on suggested action
      await this.handleStuckArm(arm, analysis);
    }
  }

  /**
   * Handle a stuck arm based on the analysis
   */
  private async handleStuckArm(arm: Arm, analysis: StuckAnalysis): Promise<void> {
    switch (analysis.suggestedAction) {
      case "answer":
        // Generate an answer to the arm's question
        if (analysis.suggestedResponse) {
          this.log(`Answering ${arm.name}'s question: "${analysis.suggestedResponse.slice(0, 50)}..."`);
          const success = await this.sendPromptToArm(arm.name, analysis.suggestedResponse);
          if (success) {
            this.logActivity("brain", "arm_unstuck", arm.id, {
              action: "answered",
              response: analysis.suggestedResponse.slice(0, 100),
            });
          }
        } else {
          // Need to generate an answer - escalate for now
          await this.escalateStuckArm(arm, analysis);
        }
        break;

      case "approve":
        // Auto-approve if confidence is high enough
        if (analysis.confidence >= 0.7) {
          const approvalResponse = analysis.suggestedResponse || "Yes, proceed.";
          this.log(`Auto-approving for ${arm.name}: "${approvalResponse}"`);
          const success = await this.sendPromptToArm(arm.name, approvalResponse);
          if (success) {
            this.logActivity("brain", "arm_unstuck", arm.id, {
              action: "auto_approved",
              response: approvalResponse,
            });
          }
        } else {
          // Not confident enough - escalate to human
          await this.escalateStuckArm(arm, analysis);
        }
        break;

      case "compact":
        // Arm is looping - send /compact command and retry
        this.log(`Sending /compact to ${arm.name} due to looping`);
        await this.sendPromptToArm(arm.name, "/compact");
        
        // Wait a bit then send a nudge to continue
        setTimeout(async () => {
          await this.sendPromptToArm(
            arm.name,
            "You were stuck in a loop. I've compacted your context. Please review the current state and try a different approach to complete your task."
          );
        }, 2000);
        
        this.logActivity("brain", "arm_unstuck", arm.id, {
          action: "compacted",
          reason: analysis.reasoning,
        });
        break;

      case "restart":
        // Arm has unrecoverable error - mark task as blocked
        this.log(`Arm ${arm.name} needs restart due to error`);
        if (arm.currentTask) {
          const task = this.tasks.find(t => t.id === arm.currentTask);
          if (task) {
            task.status = "blocked";
            task.updatedAt = new Date();
            await this.saveTasks();
          }
        }
        await this.escalateStuckArm(arm, analysis);
        break;

      case "prompt":
        // Send a generic nudge to continue
        const nudgeMessage = analysis.suggestedResponse || 
          "Please continue with your current task. If you're waiting for input, make a reasonable decision and proceed.";
        this.log(`Prompting ${arm.name} to continue: "${nudgeMessage.slice(0, 50)}..."`);
        await this.sendPromptToArm(arm.name, nudgeMessage);
        this.logActivity("brain", "arm_unstuck", arm.id, {
          action: "prompted",
          response: nudgeMessage.slice(0, 100),
        });
        break;

      case "escalate":
      default:
        // Can't handle automatically - escalate to human
        await this.escalateStuckArm(arm, analysis);
        break;
    }
  }

  /**
   * Escalate a stuck arm to the human
   * Skips if the arm was already escalated for the same stuck type recently
   */
  private async escalateStuckArm(arm: Arm, analysis: StuckAnalysis): Promise<void> {
    const stuckType = analysis.stuckType || "unknown";
    
    // Check if we already escalated for this same stuck type
    const lastStuck = this.lastStuckState.get(arm.id);
    if (lastStuck && lastStuck.stuckType === stuckType) {
      // Already escalated for this stuck type - don't spam the human
      const minutesSinceEscalation = (Date.now() - lastStuck.escalatedAt.getTime()) / 1000 / 60;
      this.log(`Arm ${arm.name} still stuck (${stuckType}) - already escalated ${Math.round(minutesSinceEscalation)}m ago, skipping duplicate notification`);
      return;
    }

    const recentOutput = await this.readArmLogs(arm.name, 30);
    const taskInfo = arm.currentTask
      ? this.tasks.find(t => t.id === arm.currentTask)?.subject || arm.currentTask
      : "unknown";

    await this.sendToHuman({
      subject: `[octopai] Arm ${arm.name} needs help (${analysis.stuckType})`,
      body: `The arm "${arm.name}" appears to be stuck and needs human intervention.

**Stuck Type:** ${analysis.stuckType}
**Confidence:** ${Math.round(analysis.confidence * 100)}%
**Reasoning:** ${analysis.reasoning}

**Current Task:** ${taskInfo}

**Recent Output:**
\`\`\`
${recentOutput.slice(-2000)}
\`\`\`

**Suggested Action:** ${analysis.suggestedAction || "manual intervention"}

To help this arm, reply to this email with instructions, or use:
\`\`\`
octopai arm prompt ${arm.name} "your message here"
\`\`\``,
      headers: {
        "X-Octopai-Type": "arm-stuck",
        "X-Octopai-Arm": arm.name,
        "X-Octopai-Stuck-Type": analysis.stuckType || "unknown",
        "Priority": "high",
      },
    });

    // Track that we escalated this stuck state
    this.lastStuckState.set(arm.id, { stuckType, escalatedAt: new Date() });

    this.logActivity("brain", "arm_stuck_escalated", arm.id, {
      stuckType: analysis.stuckType,
      confidence: analysis.confidence,
    });
  }

  /**
   * Check for idle arms that are stuck in a prompt-response loop
   * 
   * This detects a specific pattern where:
   * 1. Brain sends prompts to idle arms (prompt_received events)
   * 2. Arm responds with status_changed to "idle" 
   * 3. No productive activity (no heartbeat, task claims, etc.)
   * 4. Repeats indefinitely
   */
  private async checkIdleArmStuckLoops(): Promise<void> {
    if (!this.db) return;
    
    const idleArms = Array.from(this.arms.values()).filter(arm => arm.status === "idle");
    if (idleArms.length === 0) return;
    
    this.log(`Checking ${idleArms.length} idle arm(s) for stuck loops...`);
    
    for (const arm of idleArms) {
      // Get recent activity for this arm
      const recentActivity = await this.getRecentArmActivity(arm.id, 15);
      if (!recentActivity || recentActivity.length < 5) continue;
      
      // Analyze the pattern
      const pattern = this.analyzePromptResponsePattern(arm.id, recentActivity);
      
      if (!pattern.hasPrompt) continue;
      
      // Update or create tracker for this arm
      let tracker = this.idleArmPromptTracker.get(arm.id);
      if (!tracker) {
        tracker = {
          promptCount: 0,
          lastPromptAt: new Date(),
          lastProductiveAt: null,
          escalationLevel: 0,
        };
        this.idleArmPromptTracker.set(arm.id, tracker);
      }
      
      // Check for productive activity since last prompt
      const hasProductiveActivity = recentActivity.some(a => 
        this.isProductiveAction(a.action) && 
        new Date(a.timestamp) > tracker!.lastPromptAt
      );
      
      if (hasProductiveActivity) {
        // Arm is doing real work - reset tracking
        tracker.promptCount = 0;
        tracker.lastProductiveAt = new Date();
        continue;
      }
      
       // No productive activity - increment prompt count
      if (pattern.justReceivedPrompt) {
        tracker.promptCount++;
        tracker.lastPromptAt = new Date();
      }
      
       // Determine if arm is stuck based on prompt count and time
      // If lastProductiveAt is null, use the oldest activity timestamp as reference
      let stuckMinutes = 0;
      if (tracker.lastProductiveAt) {
        stuckMinutes = (Date.now() - tracker.lastProductiveAt.getTime()) / 1000 / 60;
      } else if (recentActivity.length > 0) {
        // No known productive activity - use oldest activity in window as reference
        const oldestTimestamp = recentActivity[recentActivity.length - 1]?.timestamp;
        if (oldestTimestamp) {
          stuckMinutes = (Date.now() - new Date(oldestTimestamp).getTime()) / 1000 / 60;
        } else {
          stuckMinutes = 15; // Default to triggering detection
        }
      } else {
        stuckMinutes = 15; // Default to triggering detection
      }
      
      const promptInterval = (Date.now() - tracker.lastPromptAt.getTime()) / 1000;
      
      this.log(`Arm ${arm.id}: promptCount=${tracker.promptCount}, stuckMinutes=${stuckMinutes.toFixed(1)}, interval=${promptInterval.toFixed(0)}s`);
      
      // Check if stuck based on pattern
      // Pattern: 3+ prompts without productive response, or 5+ minutes with no real work
      if (tracker.promptCount >= 3 || stuckMinutes >= 5) {
        await this.handleIdleArmStuck(arm, tracker, stuckMinutes);
      }
    }
  }
  
  /**
   * Analyze recent activity to detect prompt-response patterns
   */
  private async getRecentArmActivity(armId: string, minutes: number): Promise<Array<{timestamp: string; action: string; details: string}> | null> {
    if (!this.db) return null;
    
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    try {
      return this.db.query(`
        SELECT timestamp, action, details FROM activity
        WHERE actor = ? AND timestamp > ?
        ORDER BY timestamp DESC
      `).all(armId, cutoff) as Array<{timestamp: string; action: string; details: string}>;
    } catch {
      return null;
    }
  }
  
  /**
   * Detect prompt-response patterns in activity stream
   */
  private analyzePromptResponsePattern(
    armId: string,
    activity: Array<{timestamp: string; action: string; details: string}>
  ): { hasPrompt: boolean; justReceivedPrompt: boolean; promptCount: number } {
    let promptCount = 0;
    let justReceivedPrompt = false;
    let hasPrompt = false;
    
    // Count prompt_received events and check for prompt -> idle patterns
    for (const entry of activity) {
      if (entry.action === "prompt_received") {
        hasPrompt = true;
        promptCount++;
        
        // Check if this is very recent (within last 60 seconds)
        const entryTime = new Date(entry.timestamp).getTime();
        if (Date.now() - entryTime < 60 * 1000) {
          justReceivedPrompt = true;
        }
      }
    }
    
    return { hasPrompt, justReceivedPrompt, promptCount };
  }
  
  /**
   * Check if an action represents productive work
   */
  private isProductiveAction(action: string): boolean {
    const productiveActions = [
      "heartbeat",
      "claim_task",
      "acknowledge_task", 
      "complete_task",
      "get_my_instructions",
      "task_progress",
      "file_changed",
      "file_created",
      "file_deleted",
      "tool_call",
    ];
    return productiveActions.includes(action);
  }
  
  /**
   * Handle a detected stuck idle arm with escalating interventions
   */
  private async handleIdleArmStuck(
    arm: Arm,
    tracker: { promptCount: number; lastPromptAt: Date; lastProductiveAt: Date | null; escalationLevel: number },
    stuckMinutes: number
  ): Promise<void> {
    // Determine intervention level based on escalation level
    switch (tracker.escalationLevel) {
      case 0: // First detection - send interrupt + different prompt
        this.log(`Arm ${arm.id} appears stuck (${stuckMinutes.toFixed(1)}m, ${tracker.promptCount} prompts). Sending interrupt...`);
        this.logActivity("brain", "idle_arm_stuck", arm.id, {
          stuckMinutes: stuckMinutes.toFixed(1),
          promptCount: tracker.promptCount,
          intervention: "interrupt",
        });
        await this.sendPromptToArm(arm.name, "/interrupt", { interrupt: true });
        tracker.escalationLevel = 1;
        tracker.promptCount = 0; // Reset after intervention
        break;
        
      case 1: // Second detection - send /compact
        this.log(`Arm ${arm.id} still stuck after interrupt. Sending /compact...`);
        this.logActivity("brain", "idle_arm_stuck", arm.id, {
          stuckMinutes: stuckMinutes.toFixed(1),
          promptCount: tracker.promptCount,
          intervention: "compact",
        });
        await this.sendPromptToArm(arm.name, "/compact");
        tracker.escalationLevel = 2;
        tracker.promptCount = 0;
        break;
        
      case 2: // Third detection - escalate to human
        this.log(`Arm ${arm.id} still stuck after compact. Escalating to human...`);
        this.logActivity("brain", "idle_arm_stuck", arm.id, {
          stuckMinutes: stuckMinutes.toFixed(1),
          promptCount: tracker.promptCount,
          intervention: "escalate",
        });
        await this.sendToHuman({
          subject: `[octopai] Arm ${arm.name} stuck in idle loop`,
          body: `The arm "${arm.name}" has been stuck in an idle prompt loop for ${stuckMinutes.toFixed(1)} minutes.

**Pattern Detected:**
- Brain sends prompts to check for tasks
- Arm responds with "idle" but doesn't do productive work
- ${tracker.promptCount} prompts sent without response
- No heartbeat, task claims, or real work detected

**Interventions Tried:**
1. Sent interrupt command
2. Sent /compact command

**Recommended Action:**
Please check the arm and either:
- Kill it: octopai arm kill ${arm.name}
- Or send a direct response to get it unstuck

Current arm status: ${arm.status}
Last productive activity: ${tracker.lastProductiveAt?.toISOString() || "never"}
`,
        });
        tracker.escalationLevel = 3;
        break;
        
      case 3: // Already escalated - may need kill
        if (stuckMinutes >= 15) {
          this.log(`Arm ${arm.id} stuck for 15+ minutes after escalation. Consider killing.`);
          this.logActivity("brain", "arm_stuck_long", arm.id, {
            stuckMinutes,
            promptCount: tracker.promptCount,
            action: "may_need_kill",
          });
        }
        break;
    }
    
    // Reset prompt count after any intervention (we'll re-detect if still stuck)
    tracker.promptCount = 0;
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
       const armDomain = bestArm ? ((bestArm as Arm & { domain?: string }).domain || "general") : "general";
       
       if (task.domain) {
         // Look for an arm with matching domain
         const matchingArm = idleArms.find(arm => {
           const aDomain = (arm as Arm & { domain?: string }).domain || "general";
           return aDomain === task.domain || aDomain === "general";
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
       
       // Get relevant discoveries for this arm
       const discoveries = await this.getDiscoveriesForArm(bestArm.id, armDomain, { limit: 10 });
       
       // Include discoveries context if any exist
       if (discoveries.length > 0) {
         task.context = {
           discoveries,
           notes: "Review these prior discoveries before starting work.",
         };
       }
       
       // Write task assignment to arm's queue
       await this.sendToArm(bestArm.id, {
         type: "task_assignment",
         payload: task,
       });
       
       const domainMatch = task.domain ? ` (domain: ${task.domain})` : "";
       this.log(`Assigned task "${task.subject}" to ${bestArm.id}${domainMatch}, discoveries: ${discoveries.length}`);
       this.logActivity("brain", "task_assigned", task.id, { armId: bestArm.id, domain: task.domain, taskSubject: task.subject, discoveryCount: discoveries.length });
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
      subject: this.stripTerminalArtifacts(message.subject),
      date: new Date(),
      body: this.stripTerminalArtifacts(message.body),
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

  /**
   * Sync tasks from project plan files into the database
   */
  private async syncPlanTasks(): Promise<void> {
    if (!this.db) {
      this.log("Cannot sync tasks: database not initialized");
      return;
    }

    try {
      // Get project root (current working directory or configured)
      const projectRoot = process.env.OCTOPAI_PROJECT_ROOT || process.cwd();
      
      // Check if task auto-discover is enabled
      const autoDiscover = this.db.query("SELECT value FROM config WHERE key = ?")
        .get("task_auto_discover") as { value: string } | undefined;
      
      if (autoDiscover?.value !== "true") {
        return; // Task sync disabled
      }

      // Find and parse all plan files
      const planFiles = await findPlanFiles(projectRoot);
      
      if (planFiles.length === 0) {
        return; // No plan files found
      }

      let newTasksCount = 0;
      let updatedTasksCount = 0;

      for (const filePath of planFiles) {
        const result = await parsePlanFile(filePath);
        
        if (result.errors.length > 0) {
          this.log(`Plan parse errors in ${filePath}: ${result.errors.join(", ")}`);
          continue;
        }

        // Check if we should update this file
        const existingFile = this.db.query("SELECT id, last_hash FROM plan_files WHERE file_path = ?")
          .get(filePath) as { id: number; last_hash: string } | undefined;

        if (existingFile?.last_hash === result.fileHash) {
          // File hasn't changed, skip
          continue;
        }

        // Import tasks from plan
        const dbTasks = tasksToDatabaseFormat(result.tasks);
        
        for (const task of dbTasks) {
          // Check if task exists
          const existing = this.db.query("SELECT id, status FROM tasks WHERE id = ?").get(task.id) as { id: string; status: string } | undefined;
          
          if (!existing) {
            // Insert new task
            this.db.run(`
              INSERT INTO tasks (id, subject, description, status, priority, source_type, source_ref, phase, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [task.id, task.subject, task.description, task.status, task.priority, task.source_type, task.source_ref, task.phase, task.metadata]);
            newTasksCount++;
          } else if (existing.status === "pending" && task.status === "completed") {
            // Only update if not already worked on
            this.db.run(`
              UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
            `, [task.status, new Date().toISOString(), task.id]);
            updatedTasksCount++;
          }
        }

        // Update plan file tracking
        const now = new Date().toISOString();
        if (existingFile) {
          this.db.run(`
            UPDATE plan_files SET last_parsed_at = ?, last_hash = ?, updated_at = ? WHERE id = ?
          `, [now, result.fileHash, now, existingFile.id]);
        } else {
          this.db.run(`
            INSERT INTO plan_files (file_path, last_parsed_at, last_hash, updated_at)
            VALUES (?, ?, ?, ?)
          `, [filePath, now, result.fileHash, now]);
        }
      }

      if (newTasksCount > 0 || updatedTasksCount > 0) {
        this.log(`Synced tasks from plans: ${newTasksCount} new, ${updatedTasksCount} updated`);
        this.logActivity("brain", "tasks_synced", undefined, { newTasks: newTasksCount, updated: updatedTasksCount });
      }
    } catch (err) {
      this.log(`Failed to sync plan tasks: ${err}`);
    }
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
          // For API harness arms, skip if API server is unavailable
          // We can't communicate with them without the API server
          if (row.harness === "opencode-api") {
            const apiAvailable = await this.isApiServerAvailable();
            if (!apiAvailable) {
              this.log(`  ${row.name}: API harness, API server unavailable - skipping`);
              continue;
            }
          }

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

  /**
   * Check if documentation update should be triggered
   */
  private async checkDocUpdateTrigger(): Promise<void> {
    if (!this.docTracker) return;

    const trigger = await this.docTracker.checkDocUpdateTrigger();
    if (trigger) {
      this.log(`Doc update trigger: ${trigger.trigger} - ${trigger.reason}`);
      await this.handleDocUpdateTrigger(trigger.trigger);
    }
  }

  /**
   * Handle documentation update trigger
   */
  private async handleDocUpdateTrigger(trigger: "threshold" | "periodic"): Promise<void> {
    if (!this.docTracker || !this.db) return;

    const context = await this.docTracker.getDocUpdateContext();
    
    // Only create task if there are actual changes to review
    if (context.changedFilesCount === 0) {
      this.log("No files changed since last doc update, skipping");
      return;
    }

    // Build task description
    const description = this.buildDocUpdateDescription(context);
    
    // Create documentation task
    const taskId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const task: Task = {
      id: taskId,
      subject: "Documentation Sync: Feature Docs Alignment",
      description,
      status: "pending",
      priority: "normal",
      domain: "docs",
      createdAt: new Date(),
      updatedAt: new Date(),
      context: {
        notes: JSON.stringify({
          triggerType: trigger,
          filesChanged: context.filesChanged,
          featureDocsToUpdate: context.featureDocsToUpdate,
          changedFilesCount: context.changedFilesCount,
        }),
      },
    };

    this.tasks.push(task);
    await this.saveTasks();

    // Create doc update record
    const docUpdateId = await this.docTracker.createDocUpdate(taskId, trigger);
    this.docTracker.startDocUpdate(docUpdateId);

    this.log(`Created doc update task: ${taskId} (trigger: ${trigger})`);
    this.logActivity("brain", "doc_update_task_created", taskId, {
      trigger,
      filesChanged: context.changedFilesCount,
      docsToUpdate: context.featureDocsToUpdate.length,
    });
  }

  /**
   * Build description for documentation update task
   */
  private buildDocUpdateDescription(context: {
    filesChanged: string[];
    changedFilesCount: number;
    featureDocsToUpdate: string[];
    planDocument?: string;
  }): string {
    let desc = `## Documentation Update Task

This task ensures feature documentation remains aligned with actual code implementation.

### Files Changed Since Last Update
${context.changedFilesCount} files have been modified:
${context.filesChanged.slice(0, 10).map(f => `- ${f}`).join("\n")}
${context.filesChanged.length > 10 ? `- ... and ${context.filesChanged.length - 10} more` : ""}

### Feature Docs to Review
${context.featureDocsToUpdate.length > 0 
  ? context.featureDocsToUpdate.map(d => `- ${d}`).join("\n")
  : "No specific feature docs identified - review general docs for accuracy."}

### Your Tasks

1. **Review changed files** - Understand what code changes were made
2. **Update feature docs** - Ensure docs/features/, docs/api/, and docs/capabilities/ match implementation
3. **Add "Future Work" notes** - For features documented but not yet implemented:
   - Mark as "Planned for Phase N"
   - Reference the plan document
4. **Do NOT update** - Conceptual docs, architecture decisions, or requirements

### Output
When complete, report:
- Which docs were updated
- Any "Future Work" notes added
- Any features that need attention

`;

    if (context.planDocument) {
      desc += `### Reference\nSee \`${context.planDocument}\` for planned features that may need "Future Work" notes.\n`;
    }

    return desc;
  }
}

/**
 * LLM-based Mail Processor
 * Uses OpenAI to understand human messages and determine actions
 */

interface ProcessedIntent {
  type: "new_task" | "doc_update" | "approval_response" | "query" | "prompt_arm" | "arm_instruction" | "escalate";
  subject?: string;
  body?: string;
  targetDoc?: string;
  originalId?: string;
  approved?: boolean;
  comment?: string;
  query?: string;
  armName?: string;
  instruction?: string;
  priority?: "critical" | "high" | "normal" | "low";
  domain?: string;
  reasoning?: string;
}

export class MailProcessor {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private logger: (message: string) => void;

  constructor(logger: (message: string) => void) {
    this.logger = logger;
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  }

  async processMessage(
    subject: string,
    body: string,
    context: {
      availableArms: Array<{ name: string; domain: string; status: string }>;
      pendingTasks: number;
      recentActivity: string[];
    }
  ): Promise<ProcessedIntent> {
    if (!this.apiKey) {
      return this.fallbackParse(subject, body);
    }

    const systemPrompt = `You are the Octopai Brain, an AI agent orchestrator. Your job is to process messages from a human and determine the appropriate action.

## Available Actions
1. **new_task** - Create a new task for arms to work on
2. **doc_update** - Update documentation based on human feedback
3. **approval_response** - Human responded to an approval request
4. **query** - Human is asking a question about system status
5. **prompt_arm** - Directly prompt a specific arm with instructions
6. **escalate** - Requires human attention or cannot be automated

## Context
Available arms: ${context.availableArms.map(a => `${a.name}[${a.domain}]`).join(", ") || "none"}
Pending tasks: ${context.pendingTasks}
Recent activity: ${context.recentActivity.slice(0, 5).join("; ") || "none"}

## Response Format
Respond with a JSON object (no markdown):
{"type": "...", "reasoning": "...", ...other fields based on type}

For new_task: include subject, body, priority (default: normal), domain (optional)
For prompt_arm: include armName and instruction
For query: include the query type
For approval_response: include originalId, approved (boolean), comment`;

    const userMessage = `Subject: ${subject}

Body:
${body}`;

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        this.logger(`[mail-processor] OpenAI API error: ${err.substring(0, 200)}`);
        return this.fallbackParse(subject, body);
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0]?.message?.content || "";

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as ProcessedIntent;
        result.reasoning = result.reasoning || "LLM parsed intent";
        this.logger(`[mail-processor] LLM intent: ${result.type} - ${result.reasoning}`);
        return result;
      }

      return this.fallbackParse(subject, body);
    } catch (err) {
      this.logger(`[mail-processor] LLM processing error: ${err}`);
      return this.fallbackParse(subject, body);
    }
  }

  private fallbackParse(subject: string, body: string): ProcessedIntent {
    const lowerSubject = subject.toLowerCase();
    const lowerBody = body.toLowerCase();

    if (lowerSubject.includes("re:") && lowerSubject.includes("approval")) {
      const approved = lowerBody.includes("approve") || lowerBody.includes("yes") || lowerBody.includes("ok");
      const originalIdMatch = subject.match(/\[([^\]]+)\]/);
      return {
        type: "approval_response",
        originalId: originalIdMatch?.[1] || "",
        approved,
        comment: body,
        reasoning: "Fallback: detected approval response",
      };
    }

    const docPatterns = [/update (?:the )?docs?/i, /update (?:the )?requirements/i, /update (?:the )?plans?/i];
    for (const pattern of docPatterns) {
      if (pattern.test(subject) || pattern.test(body)) {
        const docMatch = body.match(/docs\/([^\s\n]+)/i);
        return {
          type: "doc_update",
          subject: subject.replace(/^(update|revise|change|clarify)\s*(?:the\s*)?/i, "").trim(),
          body,
          targetDoc: docMatch?.[1],
          reasoning: "Fallback: detected doc update request",
        };
      }
    }

    if (lowerSubject.includes("status") || lowerBody.includes("what's happening")) {
      return { type: "query", query: "status", reasoning: "Fallback: detected status query" };
    }

    return {
      type: "new_task",
      subject: subject.replace(/^(new task:|task:)\s*/i, "").trim() || subject,
      body,
      priority: "normal",
      reasoning: "Fallback: treated as new task",
    };
  }
}

// Types for parsing human intent
type HumanIntent =
  | { type: "new_task"; subject: string; body: string }
  | { type: "doc_update"; subject: string; body: string; targetDoc?: string }
  | { type: "approval_response"; originalId: string; approved: boolean; comment: string }
  | { type: "query"; query: string };

/**
 * Stuck Arm Analysis Result
 */
interface StuckAnalysis {
  isStuck: boolean;
  stuckType?: "asking_question" | "waiting_approval" | "looping" | "error" | "idle_too_long" | "unknown";
  reasoning: string;
  suggestedAction?: "answer" | "approve" | "restart" | "compact" | "escalate" | "prompt";
  suggestedResponse?: string;
  confidence: number; // 0-1
}

/**
 * LLM-based Stuck Arm Analyzer
 * Analyzes PTY output to determine if an arm is stuck and suggests actions
 */
export class StuckArmAnalyzer {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private logger: (message: string) => void;

  constructor(logger: (message: string) => void) {
    this.logger = logger;
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  }

  /**
   * Analyze arm output to determine if it's stuck
   */
  async analyze(
    armName: string,
    armDomain: string,
    recentOutput: string,
    currentTask?: string
  ): Promise<StuckAnalysis> {
    // Quick heuristics first (avoid LLM calls when possible)
    const quickResult = this.quickAnalysis(recentOutput);
    if (quickResult) {
      return quickResult;
    }

    // Use LLM for deeper analysis
    if (!this.apiKey) {
      return this.fallbackAnalysis(recentOutput);
    }

    const systemPrompt = `You are analyzing the terminal output of an AI coding agent (arm) to determine if it's stuck and needs help.

## Arm Info
- Name: ${armName}
- Domain: ${armDomain}
- Current Task: ${currentTask || "unknown"}

## Signs the arm is STUCK:
1. **asking_question** - Output ends with a question mark or "?" and is waiting for user input
2. **waiting_approval** - Asking for confirmation/approval (y/n, yes/no, approve)
3. **looping** - Same error or action repeated 3+ times
4. **error** - Stuck on an error it can't resolve
5. **idle_too_long** - No meaningful activity, just waiting

## Signs the arm is NOT stuck:
- Actively writing/editing code
- Running tests or builds
- Making progress on a task
- Recently completed an action

## Response Format (JSON only, no markdown):
{
  "isStuck": boolean,
  "stuckType": "asking_question" | "waiting_approval" | "looping" | "error" | "idle_too_long" | "unknown" | null,
  "reasoning": "brief explanation",
  "suggestedAction": "answer" | "approve" | "restart" | "compact" | "escalate" | "prompt" | null,
  "suggestedResponse": "what to tell the arm if action is 'answer' or 'prompt'",
  "confidence": 0.0 to 1.0
}`;

    const userMessage = `Recent terminal output (last ~100 lines):
\`\`\`
${recentOutput.slice(-8000)}
\`\`\`

Is this arm stuck? If so, what should we do?`;

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.2,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        this.logger(`[stuck-analyzer] OpenAI API error: ${err.substring(0, 200)}`);
        return this.fallbackAnalysis(recentOutput);
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0]?.message?.content || "";

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as StuckAnalysis;
        this.logger(`[stuck-analyzer] LLM analysis for ${armName}: stuck=${result.isStuck}, type=${result.stuckType}, confidence=${result.confidence}`);
        return result;
      }

      return this.fallbackAnalysis(recentOutput);
    } catch (err) {
      this.logger(`[stuck-analyzer] LLM analysis error: ${err}`);
      return this.fallbackAnalysis(recentOutput);
    }
  }

  /**
   * Quick heuristic analysis (avoids LLM call)
   */
  private quickAnalysis(output: string): StuckAnalysis | null {
    const lines = output.trim().split("\n");
    const lastLines = lines.slice(-20).join("\n").toLowerCase();

    // Check for obvious question patterns
    // Only match patterns that indicate the arm is truly waiting for input, not just
    // generating text that happens to contain question-like phrases
    const questionPatterns = [
      /\?\s*$/m,  // Line ends with ?
      /\(y\/n\)\s*$/mi,  // (y/n) at end of line
      /\[y\/n\]\s*$/mi,  // [y/n] at end of line
      /yes or no\?/i,
      /please (choose|select|confirm|specify)\b/i,
      // Only match "enter:" at the very end of output, preceded by a prompt-like pattern
      /[>$\#]\s*enter\s*:/i,
      /^\s*enter\s*:/im,  // "Enter:" at start of a line (after whitespace)
    ];

    for (const pattern of questionPatterns) {
      if (pattern.test(lastLines)) {
        return {
          isStuck: true,
          stuckType: "asking_question",
          reasoning: `Output matches question pattern: ${pattern}`,
          suggestedAction: "answer",
          confidence: 0.8,
        };
      }
    }

    // Check for approval patterns
    const approvalPatterns = [
      /approve.*\?/i,
      /proceed.*\?/i,
      /continue.*\?/i,
      /confirm.*\?/i,
    ];

    for (const pattern of approvalPatterns) {
      if (pattern.test(lastLines)) {
        return {
          isStuck: true,
          stuckType: "waiting_approval",
          reasoning: `Output matches approval pattern: ${pattern}`,
          suggestedAction: "approve",
          suggestedResponse: "Yes, proceed.",
          confidence: 0.85,
        };
      }
    }

    // Check for repeated errors (looping)
    const errorCounts = new Map<string, number>();
    for (const line of lines.slice(-50)) {
      if (/error|failed|exception/i.test(line)) {
        const normalized = line.toLowerCase().replace(/\d+/g, "N").trim();
        errorCounts.set(normalized, (errorCounts.get(normalized) || 0) + 1);
      }
    }

    for (const [error, count] of errorCounts) {
      if (count >= 3) {
        return {
          isStuck: true,
          stuckType: "looping",
          reasoning: `Same error repeated ${count} times: ${error.slice(0, 50)}...`,
          suggestedAction: "compact",
          confidence: 0.75,
        };
      }
    }

    return null; // Need deeper analysis
  }

  /**
   * Fallback analysis when LLM is unavailable
   */
  private fallbackAnalysis(output: string): StuckAnalysis {
    const lines = output.trim().split("\n");
    const lastLine = lines[lines.length - 1] || "";

    // Very basic heuristics
    if (lastLine.includes("?") || lastLine.toLowerCase().includes("input")) {
      return {
        isStuck: true,
        stuckType: "asking_question",
        reasoning: "Last line appears to be a question (fallback)",
        suggestedAction: "escalate",
        confidence: 0.5,
      };
    }

    // If output is very short or empty, might be idle
    if (output.trim().length < 100) {
      return {
        isStuck: false,
        reasoning: "Output too short to determine (fallback)",
        confidence: 0.3,
      };
    }

    return {
      isStuck: false,
      reasoning: "No obvious stuck patterns detected (fallback)",
      confidence: 0.4,
    };
  }
}
