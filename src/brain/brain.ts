/**
 * Brain - The central coordinator for Coleo
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
import nunjucks from "nunjucks";
import { Maildir } from "../mail";
import { initDatabase, Database } from "../db";
import { updateInfrastructureHealth, assignTaskToArm, updateArmStatusWithActivity } from "../db/transactions";
import { spawnArm, type SpawnOptions } from "../arm/spawner";
import {
  queueMessage,
  getPendingBrainMessages,
  markMessageProcessing,
  markMessageCompleted,
  markMessageFailed,
  cleanupOldMessages,
  upsertTool,
  createNote
} from "../db/state";
import { DocWatcher, getDocWatcher, stopDocWatcher } from "../docs/watcher";
import { parsePlanFile, findPlanFiles, tasksToDatabaseFormat, type PlanParseResult } from "./plan-parser";
import { parseInbox, clearInbox, deduplicateItems } from "./inbox-parser";
import { DocUpdateTracker } from "./doc-tracker";
import { NatsClient, TOPICS, type BrainMessage } from "../nats";
import { eventStore } from "../nats/jetstream";
import { ArmStateMachine, type ArmState, type ArmEvent, type SideEffect, stateToLegacyStatus } from "./arm-state-machine";
import { ArmHealthMonitor, type HealthMonitorCallbacks } from "./health-monitor";
import type { BrainState, Task, QueueMessage, Arm, Discovery, MessageType } from "../types";

export interface BrainOptions {
  coleoDir: string;
  pollIntervalMs: number;
  verbose: boolean;
  apiBaseUrl?: string;
  apiKey?: string;
}



export class Brain {
  private options: BrainOptions;
  private state: BrainState;
  private inbox: Maildir;
  private sent: Maildir;
  private tasks: Task[] = [];
  private arms: Map<string, Arm> = new Map();
  // seenArmIds removed - now derived from database via hasReceivedInitialTasks()
  private running = false;
  private shuttingDown = false;
  private abortController: AbortController | null = null;
  private db: Database | null = null;
  private apiBaseUrl: string;
  private apiKey: string;
  private natsUrl!: string;
  private natsClient: NatsClient | null = null;
  private mailProcessor: MailProcessor;
  private stuckArmAnalyzer: StuckArmAnalyzer;
  private docTracker: DocUpdateTracker | null = null;
  private armStateMachine: ArmStateMachine | null = null;
  private healthMonitor: ArmHealthMonitor | null = null;

  /**
   * Load and render a template with optional context
   */
  private async renderTemplate(
    templateName: string,
    context?: Record<string, unknown>
  ): Promise<string> {
    const templatePath = join(this.options.coleoDir, "src", "brain", "templates", templateName);
    try {
      const templateContent = await readFile(templatePath, "utf-8");
      return context ? nunjucks.renderString(templateContent, context) : templateContent;
    } catch (err) {
      this.log(`Failed to load template ${templateName}: ${err}`);
      return `Template missing: ${templateName}`;
    }
  }

  /**
   * Load and render the mail processor system prompt template
   */
  private async loadMailProcessorSystemPrompt(context: {
    availableArms: Array<{ name: string; domain: string; status: string }>;
    pendingTasks: number;
    recentActivity: string[];
  }): Promise<string> {
    const availableArms = context.availableArms.map(a => `${a.name} (${a.status})`).join(", ") || "none";
    const recentActivity = context.recentActivity.slice(0, 5).join("; ") || "none";
    return this.renderTemplate("mail-processor-system-prompt.jinja", {
      available_arms: availableArms,
      pending_tasks: context.pendingTasks,
      recent_activity: recentActivity,
    });
  }
      /**
     * Load the initial arm prompt template
     */
    private async loadInitialArmPrompt(): Promise<string> {
      return this.renderTemplate("initial-arm-prompt.jinja");
    }

        /**
     * Load and render the bug assignment prompt template
     */
    private async loadBugAssignmentPrompt(context: {
      bugId: string;
      title: string;
      assignedBy: string;
      reason: string;
    }): Promise<string> {
      return this.renderTemplate("bug-assignment-prompt.jinja", {
        bug_id: context.bugId,
        bug_title: context.title,
        assigned_by: context.assignedBy,
        reason: context.reason,
      });
    }

    /**
     * Ensure template files exist, creating them from source if needed
     */
    private async ensureTemplatesExist(): Promise<void> {
      const templateDir = join(this.options.coleoDir, "src", "brain", "templates");
      const templates = [
        { name: "mail-processor-system-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "mail-processor-system-prompt.jinja") },
        { name: "initial-arm-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "initial-arm-prompt.jinja") },
        { name: "bug-assignment-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "bug-assignment-prompt.jinja") },
        { name: "arm-api-restart-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "arm-api-restart-prompt.jinja") },
        { name: "arm-tasks-available-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "arm-tasks-available-prompt.jinja") },
        { name: "arm-loop-compact-nudge.jinja", source: join(process.cwd(), "src", "brain", "templates", "arm-loop-compact-nudge.jinja") },
        { name: "arm-generic-nudge.jinja", source: join(process.cwd(), "src", "brain", "templates", "arm-generic-nudge.jinja") },
        { name: "stuck-analyzer-system-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "stuck-analyzer-system-prompt.jinja") },
        { name: "stuck-analyzer-user-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "stuck-analyzer-user-prompt.jinja") },
        { name: "human-task-queued-busy.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-queued-busy.jinja") },
        { name: "human-mail-escalate.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-mail-escalate.jinja") },
        { name: "human-bug-report-confirmation.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-bug-report-confirmation.jinja") },
        { name: "human-task-completed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-completed.jinja") },
        { name: "human-task-deferred.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-deferred.jinja") },
        { name: "human-task-blocked.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-blocked.jinja") },
        { name: "human-issues-found.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-issues-found.jinja") },
        { name: "human-review-needed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-review-needed.jinja") },
        { name: "human-verification-needed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-verification-needed.jinja") },
        { name: "human-discovery.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-discovery.jinja") },
        { name: "human-approval-request.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-approval-request.jinja") },
        { name: "human-status-report.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-status-report.jinja") },
        { name: "human-tool-discovered.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-tool-discovered.jinja") },
        { name: "human-doc-updated.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-doc-updated.jinja") },
        { name: "human-bug-high-priority.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-bug-high-priority.jinja") },
        { name: "human-task-resumed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-resumed.jinja") },
        { name: "human-bug-medium-escalation.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-bug-medium-escalation.jinja") },
        { name: "human-file-change.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-file-change.jinja") },
        { name: "human-infra-issues.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-infra-issues.jinja") },
        { name: "human-arm-stuck.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-arm-stuck.jinja") },
        { name: "human-arm-idle-loop.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-arm-idle-loop.jinja") },
        { name: "human-arm-zombie-killed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-arm-zombie-killed.jinja") },
        { name: "human-task-blocked-by-bugs.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-blocked-by-bugs.jinja") },
      ];

      for (const template of templates) {
        const destPath = join(templateDir, template.name);
        try {
          await readFile(destPath, "utf-8");
          // Template exists, skip
        } catch {
          // Template doesn't exist, try to create from source
          try {
            const sourceContent = await readFile(template.source, "utf-8");
            await mkdir(templateDir, { recursive: true });
            await writeFile(destPath, sourceContent, "utf-8");
            this.log(`Created template: ${template.name}`);
          } catch (sourceErr) {
            this.log(`Could not create template ${template.name}: ${sourceErr}`);
          }
        }
      }
    }

    // Track last stuck state per arm to avoid duplicate escalations
  // DEPRECATED: Now tracked by ArmHealthMonitor - kept for backward compatibility during transition
  private lastStuckState: Map<string, { stuckType: string; escalatedAt: Date }> = new Map();
  // Track idle arm prompt-response patterns to detect stuck loops
  // DEPRECATED: Now tracked by ArmHealthMonitor - kept for backward compatibility during transition
  private idleArmPromptTracker: Map<string, {
    promptCount: number;           // How many prompts sent without productive response
    lastPromptAt: Date;            // When we last prompted this arm
    lastProductiveAt: Date | null; // When arm last did real work
    escalationLevel: number;       // 0 = none, 1 = interrupt, 2 = compact, 3 = kill
  }> = new Map();
  // Track when each arm was first detected (for grace period)
  private armDetectionTimes: Map<string, Date> = new Map();
  // Track recent activity from event stream (for real-time busy detection)
  private lastArmEventTime: Map<string, Date> = new Map();

  // Infrastructure health tracking
  private infrastructureHealth: {
    database: { healthy: boolean; lastCheck: Date | null; error?: string };
    apiServer: { healthy: boolean; lastCheck: Date | null; error?: string };
    nats: { healthy: boolean; lastCheck: Date | null; error?: string; optional: boolean };
    maildir: { healthy: boolean; lastCheck: Date | null; error?: string };
  } = {
    database: { healthy: false, lastCheck: null },
    apiServer: { healthy: false, lastCheck: null },
    nats: { healthy: false, lastCheck: null, optional: true },
    maildir: { healthy: false, lastCheck: null },
  };
  private lastInfraFailureNotification: Date | null = null;

  /**
   * Log an activity entry to JetStream
   * This replaces the old SQLite activity table - JetStream is now the single source of truth
   */
  private logActivity(actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
    // Skip logging during shutdown to avoid connection errors
    if (this.shuttingDown) {
      return;
    }

    // Publish to JetStream if initialized
    if (eventStore.isInitialized()) {
      const subject = target
        ? `octopai.events.arm.${target}.${action}`
        : `octopai.events.brain.${action}`;

      eventStore.publishEvent(subject, {
        type: action,
        armId: target,
        data: { actor, ...details },
        timestamp: new Date().toISOString(),
      }).catch(err => {
        // Only log if not shutting down
        if (!this.shuttingDown) {
          console.error(`[brain] Failed to publish activity event: ${err}`);
        }
      });
    }
  }

  /**
   * Handle side effects from the arm state machine
   */
  private async handleStateMachineSideEffect(effect: SideEffect): Promise<void> {
    // Skip side effects during shutdown to avoid accessing closed resources
    if (this.shuttingDown) {
      return;
    }

    switch (effect.type) {
      case "LOG":
        this.log(effect.message);
        break;

      case "NOTIFY_ARM":
        await this.sendPromptToArm(effect.armId, effect.message);
        break;

      case "UPDATE_TASK_STATUS":
        if (this.db && !this.shuttingDown) {
          const now = new Date().toISOString();
          if (effect.status === "completed") {
            this.db.run(
              "UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?",
              [effect.status, now, now, effect.taskId]
            );
          } else {
            this.db.run(
              "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
              [effect.status, now, effect.taskId]
            );
          }
        }
        break;

      case "RELEASE_TASK":
        if (this.db && !this.shuttingDown) {
          const now = new Date().toISOString();
          this.db.run(
            "UPDATE tasks SET status = 'pending', assigned_to = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?",
            [now, effect.taskId]
          );
          this.log(`Released task ${effect.taskId} back to pending`);
        }
        break;

      case "MARK_ARM_STOPPED":
        if (this.db && !this.shuttingDown) {
          const now = new Date().toISOString();
          this.db.run(
            "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
            [now, effect.armId]
          );
          this.arms.delete(effect.armId);
          this.idleArmPromptTracker.delete(effect.armId);
        }
        break;

      // SCHEDULE_TIMEOUT is handled internally by ArmStateMachine
    }
  }

  constructor(options: BrainOptions) {
    this.options = options;
    this.apiBaseUrl = options.apiBaseUrl || process.env.COLEO_API_URL || "http://localhost:8080";
    this.apiKey = options.apiKey || process.env.COLEO_API_KEY || "";
    this.natsUrl = process.env.COLEO_NATS_URL || "nats://localhost:4222";
    this.state = {
      status: "stopped",
      pollIntervalMs: options.pollIntervalMs,
      activeArms: [],
      pendingTasks: 0,
      completedToday: 0,
    };

    // Set up mail directories
    this.inbox = new Maildir(join(options.coleoDir, "mail", "inbox"));
    this.sent = new Maildir(join(options.coleoDir, "mail", "sent"));

    // Initialize mail processor
    this.mailProcessor = new MailProcessor((msg) => this.log(msg), "");

    // Initialize stuck arm analyzer
    this.stuckArmAnalyzer = new StuckArmAnalyzer((msg) => this.log(msg), this.options.coleoDir);
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

        // Subscribe to arm events for real-time activity tracking
        this.natsClient.subscribe<{ armId: string; type: string }>(TOPICS.BROADCAST_ARMS, async (event) => {
          if (event.armId) {
            this.lastArmEventTime.set(event.armId, new Date());
            // Log to JetStream for history
            this.logActivity("brain", `event-${event.type}`, event.armId, event as unknown as Record<string, unknown>);
          }
        });

        // Subscribe to individual arm events to update status based on session changes
        this.natsClient.subscribe<{ armId: string; type: string; properties: Record<string, unknown> }>(`arm.>`, async (event) => {
          await this.handleArmEvent(event.armId, event.type, event.properties);
        });

       this.log("Subscribed to brain messages and arm events on NATS");
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
   * Handle individual arm events to update status
   */
  private async handleArmEvent(armId: string, eventType: string, properties: Record<string, unknown>): Promise<void> {
    // Skip event handling during shutdown
    if (!this.db || this.shuttingDown) return;

    // Update arm status based on session status events
    if (eventType === 'session.status') {
      const status = properties.status as { type: string } | undefined;
      if (status?.type) {
        let dbStatus: string;
        switch (status.type) {
          case 'busy':
            dbStatus = 'busy';
            break;
          case 'idle':
            dbStatus = 'idle';
            break;
          case 'error':
            dbStatus = 'error';
            break;
          default:
            return; // Don't update for unknown statuses
        }

        try {
          const now = new Date().toISOString();
          this.db.run(
            "UPDATE arms SET status = ?, updated_at = ?, last_activity_at = ? WHERE id = ?",
            [dbStatus, now, now, armId]
          );

          this.log(`Updated arm ${armId} status to ${dbStatus} based on session.status event`);

          // Broadcast status change to API/WebSocket
          if (this.natsClient) {
            await this.natsClient.publish(TOPICS.BROADCAST_ARMS, {
              armId,
              type: 'arm.status_changed',
              status: dbStatus,
              source: 'session_event'
            });
          }
        } catch (err) {
          this.log(`Failed to update arm status: ${err}`);
        }
      }
    }
  }

  /**
   * Handle brain messages from arms
   */
  private async handleBrainMessage(message: BrainMessage): Promise<void> {
    // Skip message handling during shutdown
    if (this.shuttingDown) return;

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
    const dbPath = join(this.options.coleoDir, "coleo.db");
    this.db = await initDatabase(dbPath);

    // Initialize doc update tracker
    this.docTracker = new DocUpdateTracker(this.db, this.options.coleoDir, process.cwd());

    // Initialize arm state machine
    this.armStateMachine = new ArmStateMachine(this.db, (effect) => this.handleStateMachineSideEffect(effect));

    // Initialize health monitor with callbacks
    const healthCallbacks: HealthMonitorCallbacks = {
      getActiveArmIds: async () => {
        if (!this.db) return [];
        const rows = this.db.query(
          "SELECT id FROM arms WHERE status NOT IN ('stopped', 'error')"
        ).all() as Array<{ id: string }>;
        return rows.map((r) => r.id);
      },
      sendPromptToArm: async (armId, message) => {
        await this.sendPromptToArm(armId, message);
      },
      interruptArm: async (armId) => {
        // Send /compact to try to recover the arm
        await this.sendPromptToArm(armId, "/compact");
      },
      killArm: async (armId, reason) => {
        this.log(`Health monitor requested kill for arm ${armId}: ${reason}`);
        // Mark arm as stopped in database
        if (this.db) {
          const now = new Date().toISOString();
          this.db.run(
            "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
            [now, armId]
          );
        }
        this.arms.delete(armId);
        this.logActivity("brain", "arm_killed", armId, { reason, source: "health_monitor" });
      },
      notifyHuman: async (subject, body) => {
        await this.sendToHuman({ subject, body });
      },
      replyToPermission: async (armId, _requestId, approved) => {
        const response = approved ? "Yes, proceed." : "No, do not proceed.";
        await this.sendPromptToArm(armId, response);
      },
    };

    this.healthMonitor = new ArmHealthMonitor(healthCallbacks, {
      db: this.db,
      log: (msg) => this.log(msg),
      config: {
        checkIntervalMs: 30 * 1000, // 30 seconds
        eventWindowMs: 10 * 60 * 1000, // 10 minutes
        autoInterventionEnabled: true,
      },
    });

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
      "src/brain/templates",
    ];

    for (const dir of dirs) {
      await mkdir(join(this.options.coleoDir, dir), { recursive: true });
    }

    // Ensure template files exist
    await this.ensureTemplatesExist();

    // Initialize maildirs
    await this.inbox.init();
    await this.sent.init();

    // Load existing state (but reset activeArms - they'll be populated from DB)
    await this.loadState();
    this.state.activeArms = []; // Reset - get from database on first poll

    await this.loadTasks();
    await this.loadArms();
    // seenArmIds removed - now derived from database (hasReceivedInitialTasks)

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
    // Skip polling if shutdown has been requested
    if (this.shuttingDown) {
      return;
    }

    this.state.lastPollAt = new Date().toISOString();

    // Step 0: Infrastructure health check - verify the "body" is healthy before arms
    const infraHealth = await this.checkInfrastructureHealth();

    if (!infraHealth.healthy) {
      // Attempt recovery
      const recovered = await this.attemptInfrastructureRecovery();
      if (recovered) {
        // Re-check after recovery attempt
        const recheckHealth = await this.checkInfrastructureHealth();
        if (!recheckHealth.healthy) {
          await this.notifyInfrastructureIssues(recheckHealth.issues);
        }
      } else {
        await this.notifyInfrastructureIssues(infraHealth.issues);
      }
    }

    // If database is down, we can't do anything meaningful
    if (!infraHealth.components.database.healthy) {
      this.log("CRITICAL: Database unhealthy, skipping poll cycle");
      return;
    }

    // Step 1: Check for new human messages (works even if API is down)
    if (infraHealth.components.maildir.healthy) {
      await this.processHumanMail();
    }

    // Step 2: Process arm messages (works even if API is down - uses queue files)
    await this.processArmQueue();

    // Step 2.5: Check for resolved bugs and resume blocked tasks
    await this.checkResolvedBugsAndResumeTasks();

    // Steps 3-7 require API server for arm communication
    if (infraHealth.canWorkWithArms) {
      // Step 3: Check arm health and detect new arms
      await this.checkArms();

      // Step 4: Use unified health monitor for stuck detection
      // This replaces checkStuckArms() and checkIdleArmStuckLoops()
      if (this.healthMonitor) {
        // Health monitor runs on its own interval, but we can trigger a check here
        // if it's not already running (e.g., first poll or after restart)
        if (!this.healthMonitor.isMonitoring()) {
          this.healthMonitor.start();
        }
        // Optionally run an immediate check during poll for faster response
        // This is in addition to the periodic checks the monitor runs on its own
        // await this.healthMonitor.runHealthCheck();
      } else {
        // Fallback to legacy methods if health monitor not initialized
        await this.checkStuckArms();
        await this.checkIdleArmStuckLoops();
      }

      // Step 5: Assign pending tasks to idle arms first
      await this.assignTasks();

      // Step 6: Assign initial tasks to arms that are still idle
      await this.assignInitialTasks();

      // Step 7: Prompt idle arms to check for work or file changes
      await this.promptIdleArms();
    } else {
      this.log("API server unavailable - skipping arm operations");
    }

    // Step 8: Sync tasks from plan files (database only, no API needed)
    await this.syncPlanTasks();

    // Step 8a: Process inbox items (convert to tasks, clear inbox)
    await this.processInbox();

    // Step 8b: Check for documentation update triggers
    await this.checkDocUpdateTrigger();

    // Step 8c: Re-evaluate plan progress (progressive planning)
    // Creates verification tasks for completed work with issues
    await this.reEvaluatePlanProgress();

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
     this.shuttingDown = false;
     this.abortController = new AbortController();
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
     while (this.running && !this.shuttingDown) {
       await this.sleep(this.options.pollIntervalMs);
       if (this.running && !this.shuttingDown) {
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
    * Stop the brain - signals to exit the polling loop
    */
   stop(): void {
     this.running = false;
     this.shuttingDown = true;

     // Abort any pending sleep operations to wake up immediately
     if (this.abortController) {
       this.abortController.abort();
     }

     this.log("Stop requested");
   }

   /**
    * Shutdown the brain and clean up resources
    * This should be called after run() or runOnce() completes
    */
   async shutdown(): Promise<void> {
     // Mark as shutting down to prevent new operations
     this.shuttingDown = true;

     // Stop the health monitor first (it may be using callbacks)
     if (this.healthMonitor) {
       this.healthMonitor.stop();
     }

     // Stop the doc watcher
     stopDocWatcher();

     // Shutdown arm state machine BEFORE closing database
     // This clears pending timeouts that might try to use the DB
     if (this.armStateMachine) {
       this.armStateMachine.shutdown();
       this.armStateMachine = null;
     }

     // Disconnect from NATS (with timeout to avoid hanging)
     await this.stopNats();

     // Now safe to close the database
     if (this.db) {
       this.db.close();
       this.db = null;
     }

     // Clear abort controller
     this.abortController = null;

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

    // Get recent activity from JetStream for LLM context
    let recentActivity: string[] = [];
    if (eventStore.isInitialized()) {
      try {
        const events = await eventStore.getRecentEvents(5);
        recentActivity = events.map(e => `${e.data.actor || e.armId || 'brain'} ${e.type}`);
      } catch {
        // Fall back to empty if JetStream query fails
      }
    }
    const systemPrompt = await this.loadMailProcessorSystemPrompt({
      availableArms: armContexts,
      pendingTasks: this.tasks.filter(t => t.status === "pending").length,
      recentActivity,
  });
    for (const message of messages) {
      this.log(`Processing: ${message.subject}`);

      // Use LLM to determine intent
      const intent = await this.mailProcessor.processMessage(
        message.subject,
        message.body,
        systemPrompt
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

        case "bug_report":
          await this.createHumanBugReport(
            intent.title || message.subject,
            intent.description || message.body,
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

        case "prompt_arm": {
          if (intent.armName && intent.instruction) {
            // Check if arm exists and its status
            const targetArm = this.arms.get(intent.armName);
            if (!targetArm) {
              this.log(`Arm ${intent.armName} not found, creating task instead`);
              await this.createTask(
                `Task for ${intent.armName}: ${message.subject}`,
                intent.instruction,
                message.id,
                intent.priority
              );
            } else if (targetArm.status === "busy" || targetArm.status === "running" || targetArm.status === "starting") {
              // Arm is busy - create a task instead of interrupting
              this.log(`Arm ${intent.armName} is ${targetArm.status}, creating task instead of interrupting`);
              await this.createTask(
                message.subject,
                intent.instruction,
                message.id,
                intent.priority
              );
              const body = await this.renderTemplate("human-task-queued-busy.jinja", {
                arm_name: intent.armName,
                arm_status: targetArm.status,
                subject: message.subject,
              });
              await this.sendToHuman({
                subject: `[coleo] Task queued (${intent.armName} is busy)`,
                body,
              });
            } else {
              // Arm is idle, can prompt directly
              await this.sendPromptToArm(intent.armName, intent.instruction);
              this.log(`Prompted arm ${intent.armName} directly`);
              this.logActivity("brain", "arm_prompted", intent.armName, {
                reason: "human_mail",
                instruction: intent.instruction.slice(0, 100),
              });
            }
          }
          break;
        }

        case "escalate": {
          this.log(`Escalating message to human: ${message.subject}`);
          const body = await this.renderTemplate("human-mail-escalate.jinja", {
            subject: message.subject,
            body: message.body,
          });
          await this.sendToHuman({
            subject: `[coleo] Cannot process: ${message.subject}`,
            body,
          });
          break;
        }

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
   * Process messages from arms (SQLite-based with file fallback)
   */
  private async processArmQueue(): Promise<void> {
    // Process messages from SQLite (primary)
    if (this.db) {
      const messages = getPendingBrainMessages(this.db);
      for (const message of messages) {
        try {
          markMessageProcessing(this.db, message.id);

          await this.handleArmMessage({
            id: message.id,
            from: message.from,
            to: message.to,
            type: message.type as MessageType,
            payload: message.payload,
            timestamp: message.createdAt,
          });

          markMessageCompleted(this.db, message.id);
        } catch (err) {
          this.log(`Error processing queue message ${message.id}: ${err}`);
          markMessageFailed(this.db, message.id, String(err));
        }
      }

      // Periodically cleanup old messages (once per hour via modulo check)
      if (Date.now() % 3600000 < this.options.pollIntervalMs) {
        cleanupOldMessages(this.db, 7);
      }
    }

    // Also check file queue for legacy/fallback messages
    const queueDir = join(this.options.coleoDir, "queue", "brain", "pending");
    const processedDir = join(this.options.coleoDir, "queue", "brain", "processed");

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

      case "bug_report": {
        const payload = message.payload as {
          id: string;
          title: string;
          description: string;
          source: "arm_reported" | "human_reported" | "system_detected";
          sourceTaskId?: string;
          errorDetails?: string;
        };
        await this.handleBugReport(message.from, payload);
        break;
      }

      case "bug_assignment": {
        const payload = message.payload as {
          bugId: string;
          title: string;
          assignedBy: string;
          reason: string;
        };
        await this.handleBugAssignment(message.to, payload);
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

      case "dependency_discovery": {
        // Arm discovered a dependency during task execution
        const payload = message.payload as {
          taskId: string;
          dependsOn: string;
          type: string;
          description: string;
          severity?: string;
        };
        await this.handleDependencyDiscovery(message.from, payload);
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
   * Handle dependency discovery from an arm
   */
  private async handleDependencyDiscovery(
    armId: string,
    payload: { taskId: string; dependsOn: string; type: string; description: string; severity?: string }
  ): Promise<void> {
    this.log(`Arm ${armId} discovered dependency: ${payload.dependsOn} (${payload.type}) for task ${payload.taskId}`);

    // Publish to JetStream instead of SQLite
    if (eventStore.isInitialized()) {
      eventStore.publishEvent(`coleo.events.arm.${armId}.dependency_discovered`, {
        type: "dependency_discovered",
        armId,
        data: {
          taskId: payload.taskId,
          dependsOn: payload.dependsOn,
          dependencyType: payload.type,
          description: payload.description,
          severity: payload.severity,
        },
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }

    // TODO: Store dependency relationships in database for future task planning
    // For now, just log it
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
   * Create a bug report from human email
   */
  private async createHumanBugReport(
    title: string,
    description: string,
    mailThreadId?: string
  ): Promise<void> {
    if (!this.db) {
      this.log(`Cannot create human bug report: database not available`);
      return;
    }

    const bugPayload = {
      id: `bug-human-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      description,
      source: "human_reported" as const,
      sourceTaskId: undefined, // Human reports don't have associated tasks
      errorDetails: undefined,
    };

    await this.handleBugReport("human", bugPayload);

    this.log(`Created human bug report: ${title}`);
    this.logActivity("brain", "bug_created", bugPayload.id, { title, source: "human_reported", mailThreadId });

    // Send confirmation to human
    const body = await this.renderTemplate("human-bug-report-confirmation.jinja", {
      bug_id: bugPayload.id,
      title,
    });
    await this.sendToHuman({
      subject: `[coleo] Bug Report Received: ${title}`,
      body,
      headers: {
        "X-Coleo-Type": "bug-confirmation",
        "X-Coleo-Bug-Id": bugPayload.id,
      },
    });
  }

  /**
   * Ensure an arm exists in the database (for manual arms that call MCP tools)
   * This prevents FK constraint failures when assigning tasks to arms
   */
  private ensureArmExists(armId: string): void {
    if (!this.db) return;

    const now = new Date().toISOString();
    const armName = armId.startsWith("arm-") ? armId : `manual-${armId}`;

    // Use INSERT OR IGNORE to create if not exists
    this.db.run(`
      INSERT OR IGNORE INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      armId,
      armName,
      "general",
      "manual",
      "running",
      100000,
      0,
      now,
      now,
      now,
    ]);

    // Update last_activity_at for existing arms
    this.db.run(`
      UPDATE arms SET last_activity_at = ?, updated_at = ? WHERE id = ?
    `, [now, now, armId]);
  }

  /**
   * Handle an arm claiming a task
   * Updates the database to assign the task to the arm
   */
  private async claimTaskForArm(armId: string, taskId: string): Promise<void> {
    this.log(`Arm ${armId} claiming task ${taskId}`);

    try {
      if (!this.db) {
        this.log(`Database not initialized, cannot claim task`);
        return;
      }

      // Ensure the arm exists in the database (prevents FK constraint failure)
      this.ensureArmExists(armId);

      // Use transaction for task assignment
      const result = await assignTaskToArm(this.db, taskId, armId, 'primary', true);

      if (!result.success) {
        this.log(`Error claiming task ${taskId} for arm ${armId}: ${result.error}`);
        return;
      }

      // Check if we need to spawn additional arms for watchers
      if (result.success && result.data && result.data.needsMoreArms) {
        // Only spawn if there's only 1 non-stopped arm total (the primary one)
        const nonStoppedArms = Array.from(this.arms.values()).filter(arm => arm.status !== 'stopped');
        if (nonStoppedArms.length === 1) {
          await this.spawnWatcherArmForTask(taskId, armId);
        }
      }

      // Also update the in-memory tasks array
      const task = this.tasks.find(t => t.id === taskId);
      if (task) {
        task.assignedTo = armId;
        task.status = task.status === "pending" ? "claimed" : task.status;
        task.updatedAt = new Date();
      }

      this.log(`Task ${taskId} claimed by arm ${armId}`);
    } catch (err) {
      this.log(`Error claiming task ${taskId} for arm ${armId}: ${err}`);
    }
  }

  /**
   * Spawn an additional arm to act as a watcher for a task when no other arms are available
   */
  private async spawnWatcherArmForTask(taskId: string, primaryArmId: string): Promise<void> {
    try {
      this.log(`Spawning additional arm as watcher for task ${taskId}`);

      // Generate a unique name for the new arm
      const timestamp = Date.now();
      const armName = `watcher-${timestamp}`;

      // Get the task details for context
      const task = this.tasks.find(t => t.id === taskId);
      if (!task) {
        this.log(`Task ${taskId} not found, cannot spawn watcher arm`);
        return;
      }

      // Spawn arm with default settings
      const spawnOptions: SpawnOptions = {
        name: armName,
        agent: 'opencode-tui', // Default agent
        workdir: process.cwd(), // Use current working directory
        coleoDir: this.options.coleoDir,
        terminal: 'auto'
      };

      const newArm = await spawnArm(spawnOptions);
      this.log(`Spawned watcher arm ${newArm.id} for task ${taskId}`);

      // Add to our in-memory tracking immediately
      this.arms.set(newArm.id, newArm);

      // Wait for the arm to become idle before assigning it
      const maxWaitTime = 30000; // 30 seconds
      const checkInterval = 1000; // Check every 1 second
      let waited = 0;

      while (waited < maxWaitTime) {
        // Check if arm is idle via state machine
        if (this.armStateMachine) {
          const ctx = this.armStateMachine.getContext(newArm.id);
          if (ctx?.state === 'idle') {
            break;
          }
        }

        // Also check database status as fallback
        if (this.db) {
          const armRow = this.db.query("SELECT status FROM arms WHERE id = ?").get(newArm.id) as { status: string } | null;
          if (armRow?.status === 'idle') {
            break;
          }
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
        waited += checkInterval;
      }

      if (waited >= maxWaitTime) {
        this.log(`Timeout waiting for watcher arm ${newArm.id} to become idle (waited ${waited}ms)`);
        return;
      }

      this.log(`Watcher arm ${newArm.id} is now idle, assigning to task ${taskId}`);

      // Assign the new arm as a watcher to the task
      const result = await assignTaskToArm(this.db!, taskId, newArm.id, 'watcher');
      if (!result.success) {
        this.log(`Failed to assign spawned arm ${newArm.id} as watcher: ${result.error}`);
        return;
      }

      this.log(`Watcher arm ${newArm.id} assigned to task ${taskId}`);

    } catch (err) {
      this.log(`Failed to spawn watcher arm for task ${taskId}: ${err}`);
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

      // Ensure the arm exists in the database (prevents FK constraint failure)
      this.ensureArmExists(armId);

      // Map incoming status to valid task status
      let dbStatus = status;
      if (status === "in_progress") {
        dbStatus = "in_progress";

        // This is a task acknowledgment - transition state machine
        if (this.armStateMachine) {
          await this.armStateMachine.transition(armId, {
            type: "TASK_ACKNOWLEDGED",
            taskId,
          });
        }
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
            started_at = CASE WHEN ? = 'in_progress' AND started_at IS NULL THEN ? ELSE started_at END,
            updated_at = ?
        WHERE id = ?
      `, [dbStatus, armId, armId, armId, armId, armId, dbStatus, now, now, taskId]);

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

    // Find the arm that was working on this task and transition its state
    if (task?.assignedTo && this.armStateMachine) {
      await this.armStateMachine.transition(task.assignedTo, {
        type: "TASK_COMPLETED",
        taskId,
      });

      // Also update the legacy in-memory arm status
      const arm = this.arms.get(task.assignedTo);
      if (arm) {
        arm.status = "idle";
        arm.currentTask = undefined;
      }
    }

    // Check for status reports with issues for this task
    const statusReportsWithIssues = await this.getStatusReportsWithIssues(taskId);

    if (statusReportsWithIssues.length > 0) {
      // There are issues - create a verification task instead of just completing
      const latestReport = statusReportsWithIssues[0]!; // Most recent report (guaranteed by length check)
      this.log(`Task ${taskId} has ${statusReportsWithIssues.length} status reports with issues. Creating verification task.`);

      if (task) {
        await this.createVerificationTask(task, {
          id: latestReport.id,
          summary: latestReport.summary,
          issues: latestReport.issues,
          nextSteps: latestReport.nextSteps,
          testsStatus: latestReport.testsStatus,
        });
      }

      // The verification task creation also completes the original task
      return;
    }

    // Update in-memory task if found
    if (task) {
      task.status = "completed";
      task.completedAt = new Date();
      task.updatedAt = new Date();
      task.artifacts = artifacts;
      await this.saveTasks();
    }

    // Always update database
    if (this.db) {
      const now = new Date().toISOString();
      const result = this.db.run(`
        UPDATE tasks
        SET status = 'completed',
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `, [now, now, taskId]);

      if (result.changes === 0) {
        this.log(`[completeTask] WARNING: Task ${taskId} not found in database (0 rows updated)`);
      }

      // Update arm status in database
      if (task?.assignedTo) {
        this.db.run(`
          UPDATE arms
          SET status = 'idle',
              current_task_id = NULL,
              current_task_subject = NULL,
              last_activity_at = ?,
              updated_at = ?
          WHERE id = ?
        `, [now, now, task.assignedTo]);
      }
    }

    this.state.completedToday++;

    // Get task info for logging (from memory or database)
    const taskSubject = task?.subject || await this.getTaskSubjectFromDb(taskId);

    // Log activity
    this.logActivity("brain", "task_completed", taskId, { subject: taskSubject, artifacts });

    // Check for tasks that were blocked on this task and unblock them
    await this.unblockDependentTasks(taskId);

    // Notify human
    const body = await this.renderTemplate("human-task-completed.jinja", {
      subject: taskSubject,
      summary,
      artifacts_list: artifacts.map(a => `- ${a}`).join("\n") || "None",
    });
    await this.sendToHuman({
      subject: `[coleo] Task completed: ${taskSubject}`,
      body,
      headers: {
        "X-Coleo-Task-Id": taskId,
        "X-Coleo-Type": "task-complete",
      },
    });

    this.log(`Completed task: ${taskSubject}`);
  }

  /**
   * Get task subject from database (fallback when not in memory)
   */
  private async getTaskSubjectFromDb(taskId: string): Promise<string> {
    if (!this.db) return taskId;
    try {
      const row = this.db.query("SELECT subject FROM tasks WHERE id = ?").get(taskId) as { subject: string } | null;
      return row?.subject || taskId;
    } catch {
      return taskId;
    }
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
   * Determine if a status report should be forwarded to the human user
   *
   * Decision factors:
   * 1. Report status type - some always forward, some conditional
   * 2. Other arms working on same task - if yes, maybe wait
   * 3. Idle arms available - if another arm can pick up immediately, don't notify yet
   * 4. Completion states - if work is done and no follow-up assigned, notify
   * 5. Blocked/stuck - if brain decides to move arm to new task, notify user task is deferred
   *
   * Returns: {
   *   shouldForward: boolean,
   *   reason: string,
   *   assignedToArm?: string,
   *   action?: 'notify' | 'defer_task' | 'reassign'
   * }
   */
  private async shouldForwardStatusReportToUser(
    report: {
      taskId: string;
      armId: string;
      status: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
      summary: string;
      blockers?: string[];
    },
    task: Task
  ): Promise<{
    shouldForward: boolean;
    reason: string;
    assignedToArm?: string;
    action?: 'notify' | 'defer_task' | 'reassign';
  }> {
    // on_track - never forward, just progress updates
    if (report.status === "on_track") {
      return { shouldForward: false, reason: "Progress update - no user action needed" };
    }

    // Always forward needs_review - explicit request for human attention
    if (report.status === "needs_review") {
      return { shouldForward: true, reason: "Arm explicitly requested human review", action: 'notify' };
    }

    // For blocked status, check if:
    // 1. Another arm can take over the task
    // 2. The brain should defer the task and move the arm to new work
    // 3. User needs to be notified immediately
    if (report.status === "blocked") {
      if (!this.db) {
        return { shouldForward: true, reason: "Task is blocked - no DB to check alternatives", action: 'notify' };
      }

      // Check if another arm (different expertise/domain) could help
      const alternativeArms = this.db.query(`
        SELECT id, name, domain, status
        FROM arms
        WHERE id != ?
        AND status IN ('idle', 'busy')
        AND (domain != ? OR domain IS NULL)
        ORDER BY
          CASE status WHEN 'idle' THEN 0 ELSE 1 END,
          last_activity_at DESC
        LIMIT 1
      `).all(report.armId, task.domain || '') as Array<{ id: string; name: string; domain: string | null; status: string }>;

      const idleAlternative = alternativeArms.find(a => a.status === 'idle');

      if (idleAlternative) {
        // Another arm with different expertise can take over
        this.log(`Task ${task.subject} blocked - can reassign to ${idleAlternative.name}`);
        return {
          shouldForward: false,
          reason: `Blocked task can be reassigned to arm with different expertise: ${idleAlternative.name}`,
          assignedToArm: idleAlternative.id,
          action: 'reassign',
        };
      }

      // Check if there are other pending tasks this arm could work on instead
      const pendingTasks = this.db.query(`
        SELECT COUNT(*) as count
        FROM tasks
        WHERE status = 'pending'
        AND id != ?
      `).get(task.id) as { count: number } | null;

      if (pendingTasks && pendingTasks.count > 0) {
        // There's other work to do - defer this task and notify user
        this.log(`Task ${task.subject} blocked - deferring and moving arm to other work`);
        return {
          shouldForward: true,
          reason: `Task blocked and deferred. Arm will be assigned to other pending work. User notified.`,
          action: 'defer_task',
        };
      }

      // No alternatives, must notify user
      return { shouldForward: true, reason: "Task is blocked and requires human intervention", action: 'notify' };
    }

    // For issues_found and completed_with_issues, check if another arm can handle it
    if (!this.db) {
      // No database, default to forwarding
      return { shouldForward: true, reason: "No database connection - defaulting to forward", action: 'notify' };
    }

    // Check how many arms are currently working on this task
    const armsOnTask = this.db.query(`
      SELECT a.id, a.name, a.status
      FROM arms a
      WHERE a.current_task_id = ?
      AND a.status = 'busy'
      AND a.id != ?
    `).all(task.id, report.armId) as Array<{ id: string; name: string; status: string }>;

    if (armsOnTask.length > 0) {
      // Other arms are still working on this task
      this.log(`Status report for task ${task.subject}: ${armsOnTask.length} other arms still working`);
      return {
        shouldForward: false,
        reason: `${armsOnTask.length} other arm(s) still working on this task: ${armsOnTask.map(a => a.name).join(", ")}`
      };
    }

    // Check for available idle arms that could pick up verification work
    const idleArms = this.db.query(`
      SELECT id, name, domain
      FROM arms
      WHERE status = 'idle'
      AND id != ?
      ORDER BY last_activity_at DESC
      LIMIT 1
    `).all(report.armId) as Array<{ id: string; name: string; domain: string | null }>;

    if (report.status === "completed_with_issues" && idleArms.length > 0) {
      // An idle arm could pick up the verification task
      const idleArm = idleArms[0]!;
      this.log(`Verification task for ${task.subject} can be assigned to idle arm: ${idleArm.name}`);
      return {
        shouldForward: false,
        reason: `Verification task will be assigned to idle arm: ${idleArm.name}`,
        assignedToArm: idleArm.id,
        action: 'reassign',
      };
    }

    if (report.status === "issues_found" && idleArms.length > 0) {
      // Could assign investigation to another arm, but might still want to notify human
      // For issues_found, we typically continue working, so check if the arm is continuing
      const idleArm = idleArms[0]!;
      this.log(`Issues found in ${task.subject} - idle arm available: ${idleArm.name}`);
      // Still forward issues to user, but note that another arm could help
      return {
        shouldForward: true,
        reason: `Issues found - user should be aware. Idle arm ${idleArm.name} available if needed.`,
        action: 'notify',
      };
    }

    // No other arms available, forward to user
    return {
      shouldForward: true,
      reason: "No other arms available to continue work - user should be notified",
      action: 'notify',
    };
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

    // Determine if we should forward this status report to the user
    const forwardDecision = await this.shouldForwardStatusReportToUser(report, task);
    this.log(`Status report forward decision: ${forwardDecision.shouldForward ? "FORWARD" : "HOLD"} - ${forwardDecision.reason}`);

    // Log the decision for transparency
    this.logActivity("brain", "status_report_forward_decision", report.taskId, {
      reportId: report.id,
      shouldForward: forwardDecision.shouldForward,
      reason: forwardDecision.reason,
      assignedToArm: forwardDecision.assignedToArm,
    });

    // Handle based on status
    switch (report.status) {
      case "blocked": {
        // Update task status based on brain's decision
        task.updatedAt = new Date();

        if (forwardDecision.action === 'reassign' && forwardDecision.assignedToArm) {
          // Another arm can take over - reassign without bothering the user
          task.status = "pending"; // Reset to pending for reassignment
          await this.saveTasks();
          await this.claimTaskForArm(forwardDecision.assignedToArm, task.id);
          this.log(`Task ${task.subject} blocked by ${report.armId}, reassigned to ${forwardDecision.assignedToArm}`);

          // Log but don't notify user
          this.logActivity("brain", "task_reassigned_on_block", task.id, {
            fromArm: report.armId,
            toArm: forwardDecision.assignedToArm,
            reason: forwardDecision.reason,
          });
        } else if (forwardDecision.action === 'defer_task') {
          // Defer the task and notify user - arm will move to other work
          task.status = "blocked";
          await this.saveTasks();

          // Update database to mark task as deferred
          if (this.db) {
            this.db.run(`
              UPDATE tasks
              SET status = 'blocked',
                  metadata = json_set(COALESCE(metadata, '{}'), '$.deferred', true, '$.deferredAt', ?),
                  updated_at = ?
              WHERE id = ?
            `, [new Date().toISOString(), new Date().toISOString(), task.id]);
          }

          const body = await this.renderTemplate("human-task-deferred.jinja", {
            task_subject: task.subject,
            summary: report.summary,
            blockers_list: report.blockers.map(b => `- ${b}`).join("\n") || "No specific blockers listed",
            next_steps: report.nextSteps || "None specified",
          });
          await this.sendToHuman({
            subject: `[coleo] Task deferred: ${task.subject}`,
            body,
            headers: {
              "X-Coleo-Task-Id": report.taskId,
              "X-Coleo-Type": "task-deferred",
            },
          });
          this.log(`Task ${task.subject} deferred. Arm ${report.armId} will be assigned to other work.`);
        } else {
          // Standard blocked handling - notify user immediately
          task.status = "blocked";
          await this.saveTasks();

          const body = await this.renderTemplate("human-task-blocked.jinja", {
            task_subject: task.subject,
            arm_id: report.armId,
            summary: report.summary,
            blockers_list: report.blockers.map(b => `- ${b}`).join("\n") || "No specific blockers listed",
            next_steps: report.nextSteps || "None specified",
          });
          await this.sendToHuman({
            subject: `[coleo] Task blocked: ${task.subject}`,
            body,
            headers: {
              "X-Coleo-Task-Id": report.taskId,
              "X-Coleo-Type": "task-blocked",
            },
          });
          this.log(`Task ${task.subject} blocked. Notified human.`);
        }
        break;
      }

      case "issues_found": {
        // Log issues but don't change task status yet
        this.log(`Issues found in task ${task.subject}: ${report.issues.length} issues`);

        // Only notify human if decision says to forward
        if (forwardDecision.shouldForward && report.issues.length > 0) {
          const body = await this.renderTemplate("human-issues-found.jinja", {
            arm_id: report.armId,
            task_subject: task.subject,
            issues_list: report.issues.map(i => `- ${i}`).join("\n"),
            summary: report.summary,
            next_steps: report.nextSteps || "Continuing work...",
            forward_reason: forwardDecision.reason,
          });
          await this.sendToHuman({
            subject: `[coleo] Issues found: ${task.subject}`,
            body,
            headers: {
              "X-Coleo-Task-Id": report.taskId,
              "X-Coleo-Type": "issues-found",
            },
          });
        } else if (!forwardDecision.shouldForward) {
          this.log(`Issues found but not forwarding to user: ${forwardDecision.reason}`);
        }
        break;
      }

      case "needs_review": {
        // Task needs human or other arm review - always forward
        this.log(`Task ${task.subject} needs review`);
        const body = await this.renderTemplate("human-review-needed.jinja", {
          arm_id: report.armId,
          task_subject: task.subject,
          summary: report.summary,
          files_list: report.filesChanged.map(f => `- ${f}`).join("\n") || "None listed",
          tests_status: report.testsStatus || "Not run",
        });
        await this.sendToHuman({
          subject: `[coleo] Review needed: ${task.subject}`,
          body,
          headers: {
            "X-Coleo-Task-Id": report.taskId,
            "X-Coleo-Type": "needs-review",
          },
        });
        break;
      }

      case "completed_with_issues": {
        // Create a verification task for follow-up
        const verifyTask = await this.createVerificationTask(task, report, !forwardDecision.shouldForward);

        // If we decided not to forward because an idle arm can handle it, assign the task
        if (!forwardDecision.shouldForward && forwardDecision.assignedToArm) {
          await this.claimTaskForArm(forwardDecision.assignedToArm, verifyTask.id);
          this.log(`Assigned verification task ${verifyTask.id} to ${forwardDecision.assignedToArm} instead of notifying human`);
        }
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
   * @param skipNotification - If true, don't send notification to human (e.g., when assigning to another arm)
   */
  private async createVerificationTask(
    originalTask: Task,
    report: {
      id: string;
      summary: string;
      issues: string[];
      nextSteps?: string;
      testsStatus?: "passing" | "failing" | "not_run";
    },
    skipNotification: boolean = false
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

    // Insert verification task into database
    if (this.db) {
      const now = new Date().toISOString();
      this.db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [verifyTask.id, verifyTask.subject, verifyTask.description, verifyTask.status, verifyTask.priority, now, now]);
    }

    await this.saveTasks();

    // Mark original task as completed (with issues noted)
    originalTask.status = "completed";
    originalTask.completedAt = new Date();
    originalTask.updatedAt = new Date();

    // Update original task in database
    if (this.db) {
      const now = new Date().toISOString();
      this.db.run(`
        UPDATE tasks
        SET status = 'completed',
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `, [now, now, originalTask.id]);
    }

    this.state.completedToday++;
    await this.saveTasks();

    this.log(`Created verification task: ${verifyTask.subject} (${taskId})`);
    this.logActivity("brain", "verification_task_created", taskId, {
      originalTaskId: originalTask.id,
      issueCount: report.issues.length,
      testsStatus: report.testsStatus,
      skipNotification,
    });

    // Notify human unless explicitly skipped (e.g., when assigning to another arm)
    if (!skipNotification) {
      const body = await this.renderTemplate("human-verification-needed.jinja", {
        task_subject: originalTask.subject,
        issues_list: report.issues.map(i => `- ${i}`).join("\n") || "No specific issues listed",
        summary: report.summary,
      });
      await this.sendToHuman({
        subject: `[coleo] Verification needed: ${originalTask.subject}`,
        body,
        headers: {
          "X-Coleo-Task-Id": taskId,
          "X-Coleo-Type": "verification-task-created",
        },
      });
    } else {
      this.log(`Skipping human notification for verification task ${taskId} - will be assigned to another arm`);
    }

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
        const body = await this.renderTemplate("human-discovery.jinja", {
          arm_id: armId,
          kind: discovery.kind,
          severity: discovery.severity || "info",
          details: discovery.details,
          file_info: discovery.file
            ? `**File:** ${discovery.file}${discovery.line ? `:${discovery.line}` : ""}`
            : "",
        });
        await this.sendToHuman({
          subject: `[coleo] Discovery: ${discovery.title}`,
         body,
          headers: {
            "X-Coleo-Type": "discovery",
            "X-Coleo-From": armId,
            "X-Coleo-Severity": discovery.severity || "info",
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

    const body = await this.renderTemplate("human-approval-request.jinja", {
      arm_id: armId,
      action: request.action,
      context: request.context,
      options: request.options.join(" | "),
    });
    await this.sendToHuman({
      subject: `[coleo] [${requestId}] Approval needed: ${request.action}`,
      body,
      headers: {
        "X-Coleo-Type": "approval-request",
        "X-Coleo-From": armId,
        "X-Coleo-Request-Id": requestId,
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

      const body = await this.renderTemplate("human-status-report.jinja", {
        arms_active: this.arms.size,
        pending_count: pendingTasks.length,
        in_progress_count: inProgress.length,
        completed_today: completedToday,
        pending_list: pendingTasks.map(t => `- ${t.subject}`).join("\n") || "None",
        in_progress_list: inProgress.map(t => `- ${t.subject} (${t.assignedTo})`).join("\n") || "None",
      });
      await this.sendToHuman({
        subject: "[coleo] Status Report",
        body,
        headers: {
          "X-Coleo-Type": "status",
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
    const noteId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Save to SQLite notes table
    if (this.db) {
      createNote(this.db, {
        id: noteId,
        author,
        title: note.title,
        content: note.content,
        category: "shared",
        tags: note.tags,
      });
    }

    this.log(`Saved shared note: ${note.title} from ${author}`);
  }

  /**
   * Handle a tool discovery (stored in SQLite tools table)
   */
  private async handleToolDiscovery(
    armId: string,
    tool: { name: string; command: string; description: string }
  ): Promise<void> {
    // Save to SQLite tools table
    if (this.db) {
      upsertTool(this.db, {
        name: tool.name,
        command: tool.command,
        description: tool.description,
        discoveredBy: armId,
      });
    }

    // Notify human
    const body = await this.renderTemplate("human-tool-discovered.jinja", {
      arm_id: armId,
      tool_name: tool.name,
      command: tool.command,
      description: tool.description,
    });
    await this.sendToHuman({
      subject: `[coleo] Tool discovered: ${tool.name}`,
      body,
      headers: {
        "X-Coleo-Type": "tool-discovery",
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

    // Update state machine with heartbeat event
    if (this.armStateMachine) {
      await this.armStateMachine.transition(armId, { type: "HEARTBEAT" });
    }

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
    const body = await this.renderTemplate("human-doc-updated.jinja", {
      arm_id: armId,
      path: payload.path,
      reason: payload.reason,
    });
    await this.sendToHuman({
      subject: `[coleo] Documentation updated: ${payload.path}`,
      body,
      headers: {
        "X-Coleo-Type": "doc-update",
        "X-Coleo-Path": payload.path,
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
   * Handle bug report from an arm or system
   */
  private async handleBugReport(
    armId: string,
    payload: {
      id: string;
      title: string;
      description: string;
      source: "arm_reported" | "human_reported" | "system_detected";
      sourceTaskId?: string;
      errorDetails?: string;
    }
  ): Promise<void> {
    if (!this.db) {
      this.log(`Bug report received but database not available: ${payload.title}`);
      return;
    }

    try {
      const now = new Date().toISOString();
      const bugId = payload.id || `bug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Determine priority based on source and content
      let priority: "low" | "medium" | "high" | "critical" = "medium";
      if (payload.source === "system_detected") {
        priority = "high"; // System issues are usually high priority
      } else if (payload.title.toLowerCase().includes("crash") ||
                  payload.title.toLowerCase().includes("fail") ||
                  payload.description.toLowerCase().includes("block")) {
        priority = "high";
      }
      // Critical priority for system-wide blocking issues
      if (payload.source === "system_detected" &&
          (payload.title.toLowerCase().includes("down") ||
           payload.description.toLowerCase().includes("unavailable"))) {
        priority = "critical";
      }
      // Low priority for minor issues
      if (payload.source === "human_reported" &&
          !payload.title.toLowerCase().includes("crash") &&
          !payload.title.toLowerCase().includes("fail") &&
          !payload.description.toLowerCase().includes("block")) {
        priority = "low";
      }

      // Insert bug report
      this.db.run(`
        INSERT OR REPLACE INTO bugs (
          id, title, description, source, source_arm_id, source_task_id,
          status, priority, error_details, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `, [
        bugId,
        payload.title,
        payload.description,
        payload.source,
        payload.source === "arm_reported" ? armId : null,
        payload.sourceTaskId || null,
        priority,
        payload.errorDetails || null,
        now,
        now
      ]);

      this.log(`Bug reported: ${payload.title} (${priority} priority) by ${payload.source}`);

      // Notify human for critical/high priority bugs
      if (priority === "critical" || priority === "high") {
        const body = await this.renderTemplate("human-bug-high-priority.jinja", {
          priority,
          title: payload.title,
          description: payload.description,
          source: payload.source,
          reported_by: armId,
        });
        await this.sendToHuman({
          subject: `[coleo] ${priority.toUpperCase()} Priority Bug: ${payload.title}`,
          body,
          headers: {
            "X-Coleo-Type": "bug-report",
            "X-Coleo-Bug-Id": bugId,
            "X-Coleo-Priority": priority,
          },
        });

        // Mark as human notified
        this.db.run(`UPDATE bugs SET human_notified = TRUE WHERE id = ?`, [bugId]);
      }

      // Handle escalation based on priority and impact
      if (priority === "medium") {
        // For medium priority bugs, reassign affected tasks and log for resolution
        await this.handleMediumPriorityBugEscalation(bugId, payload);
      } else if (priority === "low") {
        // For low priority bugs, continue work but track for later resolution
        this.log(`Low priority bug ${bugId} logged for later resolution`);
      }

      // If bug blocks a task, try to assign an arm to investigate
      if (payload.sourceTaskId) {
        const task = this.tasks.find(t => t.id === payload.sourceTaskId);
        if (task && task.status !== "completed" && task.status !== "failed") {
          // Create investigation task
          await this.createBugInvestigationTask(bugId, payload);
        }
      }

    } catch (err) {
      this.log(`Error handling bug report: ${err}`);
    }
  }

  /**
   * Check for recently resolved bugs and resume any tasks they were blocking
   */
  private async checkResolvedBugsAndResumeTasks(): Promise<void> {
    if (!this.db) return;

    try {
      // Find bugs that were resolved/closed since last check
      const recentlyResolvedBugs = this.db.query(`
        SELECT id, title, blockers, resolved_at
        FROM bugs
        WHERE status IN ('resolved', 'closed')
          AND resolved_at IS NOT NULL
          AND resolved_at > datetime('now', '-1 hour')  -- Check last hour
          AND json_array_length(blockers) > 0
      `).all() as Array<{ id: string; title: string; blockers: string; resolved_at: string }>;

      for (const bug of recentlyResolvedBugs) {
        const blockedTaskIds = JSON.parse(bug.blockers) as string[];

        for (const taskId of blockedTaskIds) {
          // Find the task in our local cache
          const task = this.tasks.find(t => t.id === taskId);
          if (task && task.status === "blocked") {
            // Resume the blocked task
            task.status = "pending";
            task.updatedAt = new Date();

            this.log(`Resuming blocked task ${taskId} after bug ${bug.id} resolution`);

            // Update task in database
            this.db.run(`
              UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?
            `, [new Date().toISOString(), taskId]);

            // Notify human about task resumption
            const body = await this.renderTemplate("human-task-resumed.jinja", {
              task_id: taskId,
              task_subject: task.subject,
              bug_id: bug.id,
              bug_title: bug.title,
              resolved_at: bug.resolved_at,
            });
            await this.sendToHuman({
              subject: `[coleo] Task Resumed: ${task.subject}`,
              body,
              headers: {
                "X-Coleo-Type": "task-resumed",
                "X-Coleo-Task-Id": taskId,
                "X-Coleo-Bug-Id": bug.id,
              },
            });

            // Log activity
            this.logActivity("brain", "task_resumed", taskId, {
              reason: "blocking_bug_resolved",
              bugId: bug.id,
            });
          }
        }
      }
    } catch (err) {
      this.log(`Error checking resolved bugs: ${err}`);
    }
  }

  /**
   * Handle escalation for medium priority bugs
   */
  private async handleMediumPriorityBugEscalation(
    bugId: string,
    bugPayload: {
      title: string;
      description: string;
      source: string;
      sourceTaskId?: string;
    }
  ): Promise<void> {
    // For medium priority bugs, reassign any currently assigned tasks that might be affected
    // and log for resolution
    this.log(`Medium priority bug ${bugId} - checking for task reassignment needs`);

    // If this bug came from a specific task, consider reassigning that task to a different arm
    if (bugPayload.sourceTaskId) {
      const task = this.tasks.find(t => t.id === bugPayload.sourceTaskId);
      if (task && task.assignedTo && task.status === "in_progress") {
        // Task is in progress, check if we should reassign
        const assignedArm = Array.from(this.arms.values()).find(a => a.id === task.assignedTo);
        if (assignedArm) {
          this.log(`Considering reassignment of task ${task.id} due to bug ${bugId}`);

          // For now, just log - could implement reassignment logic here
          // In a more sophisticated system, we might check if the arm is still suitable
        }
      }
    }

    // Log the escalation for human review
    const body = await this.renderTemplate("human-bug-medium-escalation.jinja", {
      title: bugPayload.title,
      description: bugPayload.description,
      source: bugPayload.source,
      bug_id: bugId,
    });
    await this.sendToHuman({
      subject: `[coleo] Medium Priority Bug Escalation: ${bugPayload.title}`,
      body,
      headers: {
        "X-Coleo-Type": "bug-escalation",
        "X-Coleo-Bug-Id": bugId,
        "X-Coleo-Priority": "medium",
      },
    });
  }

  /**
   * Handle bug assignment notification to an arm
   */
   private async handleBugAssignment(
    armId: string,
    payload: {
      bugId: string;
      title: string;
      assignedBy: string;
      reason: string;
    }
  ): Promise<void> {
    // Load and render the bug assignment prompt template
    const prompt = await this.loadBugAssignmentPrompt({
      bugId: payload.bugId,
      title: payload.title,
      assignedBy: payload.assignedBy,
      reason: payload.reason,
    });

    // Send notification to the assigned arm via their MCP session
    await this.sendPromptToArm(armId, prompt);

    this.log(`Bug ${payload.bugId} assigned to arm ${armId} by ${payload.assignedBy}`);
  }

  /**
    * Create a task to investigate a bug
    */
  private async createBugInvestigationTask(
    bugId: string,
    bugPayload: {
      title: string;
      description: string;
      source: string;
      sourceTaskId?: string;
    }
  ): Promise<void> {
    const taskId = `bug-investigate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const task: Task = {
      id: taskId,
      subject: `Investigate Bug: ${bugPayload.title}`,
      description: `Investigate and diagnose the reported bug.

**Bug Details:**
- Title: ${bugPayload.title}
- Description: ${bugPayload.description}
- Source: ${bugPayload.source}
${bugPayload.sourceTaskId ? `- Related Task: ${bugPayload.sourceTaskId}` : ''}

**Investigation Steps:**
1. Reproduce the issue
2. Identify root cause
3. Determine impact on other tasks
4. Propose fix or workaround
5. Update bug status

Report findings using bug resolution workflow.`,
      status: "pending",
      priority: "high",
      classification: "development",
      createdAt: new Date(),
      updatedAt: new Date(),
      context: {
        notes: JSON.stringify({
          bugId,
          investigationRequired: true,
        }),
      },
    };

    this.tasks.push(task);
    await this.saveTasks();

    this.log(`Created bug investigation task: ${taskId} for bug ${bugId}`);
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
      const body = await this.renderTemplate("human-file-change.jinja", {
        arm_id: armId,
        file_path: payload.filePath,
        change_type: payload.changeType,
        summary: payload.summary,
        impact_line: payload.impact ? `**Impact:** ${payload.impact}` : "",
      });
      await this.sendToHuman({
        subject: `[coleo] File change detected: ${payload.filePath}`,
        body,
        headers: {
          "X-Coleo-Type": "file-change",
          "X-Coleo-Path": payload.filePath,
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

        // Initialize state machine for this arm
        if (this.armStateMachine) {
          const existingContext = this.armStateMachine.getContext(arm.id);
          if (!existingContext) {
            // New arm to state machine - initialize as idle (already running)
            this.armStateMachine.initializeArm(arm.id, "idle");
            this.log(`  ${arm.name}: initialized state machine as idle`);
          } else if (existingContext.state === "disconnected") {
            // Was disconnected, now reconnected - emit CONNECTION_RESTORED
            await this.armStateMachine.transition(arm.id, { type: "CONNECTION_RESTORED" });
            this.log(`  ${arm.name}: state machine transition from disconnected to ${this.armStateMachine.getContext(arm.id)?.state}`);
          } else if (existingContext.state === "stopped" || existingContext.state === "error") {
            // Was stopped/error, now running again - re-initialize as idle
            this.armStateMachine.initializeArm(arm.id, "idle");
            this.log(`  ${arm.name}: re-initialized state machine as idle (was ${existingContext.state})`);
          }
        }

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
        // Record detection time for grace period calculation
        this.armDetectionTimes.set(trackedArm.id, new Date());

        this.logActivity("brain", "arm_detected", arm.id, { pid: arm.pid, reason: "process_scan" });
      } catch {
        // Process dead
        if (arm.status !== "stopped") {
          this.log(`  ${arm.name}: process dead, transitioning to stopped via state machine`);

          if (this.armStateMachine) {
            // Emit STOP event - this will handle releasing tasks and cleanup via side effects
            await this.armStateMachine.transition(arm.id, { type: "STOP", reason: "process_dead_on_scan" });
          } else {
            this.db.run(
              "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
              [new Date().toISOString(), arm.id]
            );
          }
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
              // Arm is properly connected - check state machine instead of ad-hoc grace period
              const harnessStatus = stateResult.state === "processing" ? "busy" : "idle";

              // Use state machine to determine if we should sync status
              if (this.armStateMachine) {
                const smContext = this.armStateMachine.getContext(armId);

                // If state machine says arm is in task_assigned or working state,
                // don't sync to idle - the state machine handles this with proper timeouts
                if (smContext && (smContext.state === "task_assigned" || smContext.state === "working")) {
                  if (harnessStatus === "idle") {
                    // Harness reports idle but state machine knows we have a task
                    // This is the race condition the state machine is designed to handle
                    this.log(`Arm ${armId}: harness reports idle but state machine is in "${smContext.state}" - keeping current state (task: "${smContext.currentTaskSubject}")`);
                    continue;
                  }
                }

                // If harness says processing but state machine is idle, the harness may be
                // working on something without a brain task - leave it alone
                if (smContext && smContext.state === "idle" && harnessStatus === "busy") {
                  this.log(`Arm ${armId}: harness reports busy but state machine is idle - arm may be working on non-brain task`);
                  continue;
                }
              }

              if (arm.status !== harnessStatus) {
                this.log(`Arm ${armId}: syncing status from "${arm.status}" to "${harnessStatus}" based on harness state`);
                await this.syncArmStatus(armId, harnessStatus);
              } else {
                this.log(`Arm ${armId} is running (PID: ${arm.pid}, state: ${stateResult.state})`);
              }
              continue;
            } else if (!stateResult.hasSession) {
              // Process is running but API session was lost (server restart)
              // Emit CONNECTION_LOST to state machine - it will set up reconnect timeout
              this.log(`Arm ${armId} process alive but session lost (server restart), emitting CONNECTION_LOST`);

              if (this.armStateMachine) {
                await this.armStateMachine.transition(armId, { type: "CONNECTION_LOST" });
              }

              // Also prompt the arm to re-register
              const prompt = await this.renderTemplate("arm-api-restart-prompt.jinja");
              await this.sendPromptToArm(arm.name, prompt);
              continue;
            }
          } else {
            // API not available but process is running - keep the arm
            this.log(`Arm ${armId} is running (PID: ${arm.pid}, API unavailable)`);
            continue;
          }
        } catch {
          // Process is dead - transition through state machine
          this.log(`Arm ${armId} process dead (PID: ${arm.pid}), transitioning to stopped via state machine`);

          if (this.armStateMachine) {
            // Emit STOP event - this will handle releasing tasks and cleanup via side effects
            await this.armStateMachine.transition(armId, { type: "STOP", reason: "process_dead" });
          } else {
            // Fallback if state machine not initialized
            if (this.db) {
              this.db.run(
                "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
                [new Date().toISOString(), armId]
              );
            }
          }
          this.arms.delete(armId);
          this.idleArmPromptTracker.delete(armId);
        }
      } else {
        // No PID - check via API session
        const stateResult = await this.apiRequest<{ state: string; hasSession: boolean }>(`/api/arms/${armId}/state`);

        if (stateResult && !stateResult.hasSession) {
          this.log(`Arm ${armId} has no session and no PID, transitioning to stopped via state machine`);

          if (this.armStateMachine) {
            // Emit STOP event - this will handle releasing tasks and cleanup via side effects
            await this.armStateMachine.transition(armId, { type: "STOP", reason: "no_session" });
          } else {
            await this.apiRequest(`/api/arms/${armId}`, {
              method: "PATCH",
              body: JSON.stringify({ status: "stopped" }),
            });
          }
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
     * Send initial prompt to newly spawned arms
     */
    private async assignInitialTasks(): Promise<void> {
      for (const [armId, arm] of this.arms) {
        // Skip if we've already sent initial prompt to this arm (check database)
        if (await this.hasReceivedInitialTasks(armId)) continue;

        // Skip if arm is not idle
        if (arm.status !== "idle") continue;

        // Verify arm exists in database before proceeding (foreign key constraint)
        if (this.db) {
          const armExists = this.db.query("SELECT 1 FROM arms WHERE id = ?").get(armId);
          if (!armExists) {
            this.log(`Arm ${armId} not found in database, skipping initial prompt`);
            continue;
          }
        }

        // Send the common initial prompt to the arm
        const prompt = await this.loadInitialArmPrompt();
        const success = await this.sendPromptToArm(armId, prompt);

        if (success) {
          this.log(`Sent initial prompt to ${armId}`);
          this.logActivity("brain", "arm_initialized", armId, {
            source: "initial_prompt_sent"
          });
        } else {
          this.log(`Failed to send initial prompt to ${armId}`);
        }

        // Create a placeholder task record so hasReceivedInitialTasks returns true next time
        // This prevents sending the prompt multiple times
        if (this.db) {
          const now = new Date().toISOString();
          this.db.run(
            `INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at)
             VALUES (?, ?, ?, 'completed', 'normal', ?, ?)`,
            [`init-${armId}`, `Arm ${armId} initialized`, `Initial prompt sent to arm`, now, now]
          );
        }
      }
    }

  /**
   * Check if an arm has already received the initial prompt (derived from database)
   */
  private async hasReceivedInitialTasks(armId: string): Promise<boolean> {
    if (!this.db) return false;

    // Check if the initialization placeholder task exists
    const result = this.db.query(`
      SELECT COUNT(*) as count FROM tasks WHERE id = ?
    `).get(`init-${armId}`) as { count: number } | null;

    return (result?.count ?? 0) > 0;
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

      // Grace period: skip prompting arms that were just detected
      // This prevents interrupting arms that were working autonomously before brain came online
      const detectionTime = this.armDetectionTimes.get(arm.id);
      if (detectionTime) {
        const gracePeriod = await this.getBrainConfigNumber("brain_arm_grace_period_minutes", 5);
        const detectedMinutesAgo = (Date.now() - detectionTime.getTime()) / 1000 / 60;
        if (detectedMinutesAgo < gracePeriod) {
          this.log(`Arm ${arm.id} [${armDomain}]: recently detected (${detectedMinutesAgo.toFixed(1)}m ago, grace period: ${gracePeriod}m), skipping prompt`);
          continue;
        }
      }

      // Health check: verify the arm's harness is actually responsive
      if (isApi) {
        const harnessState = await this.getArmHarnessState(arm.id);
        if (!harnessState) {
          this.log(`Arm ${arm.id} [${armDomain}]: Cannot get harness state, skipping prompt`);
          continue;
        }
        if (!harnessState.hasSession) {
          this.log(`Arm ${arm.id} [${armDomain}]: No active session (zombie?), marking as stopped`);
          await this.syncArmStatus(arm.id, "stopped");
          continue;
        }
        if (harnessState.state === "stopped" || harnessState.state === "dead") {
          this.log(`Arm ${arm.id} [${armDomain}]: Harness state is ${harnessState.state}, marking as stopped`);
          await this.syncArmStatus(arm.id, "stopped");
          continue;
        }
      }

       // Double-check state machine - don't prompt if it knows the arm has work
       if (this.armStateMachine) {
         const smContext = this.armStateMachine.getContext(arm.id);
         if (smContext && (smContext.state === "task_assigned" || smContext.state === "working")) {
           this.log(`Arm ${arm.id} [${armDomain}]: state machine says "${smContext.state}", skipping prompt`);
           continue;
         }
       }

       // Check for recent event stream activity - arms emit events when actively working
       const lastEventTime = this.lastArmEventTime.get(arm.id);
       if (lastEventTime) {
         const secondsSinceEvent = (Date.now() - lastEventTime.getTime()) / 1000;
         if (secondsSinceEvent < 160) {
           // Arm had activity in the last 160 seconds - it's likely processing
           this.log(`Arm ${arm.id} [${armDomain}]: recent event ${secondsSinceEvent.toFixed(1)}s ago, skipping prompt`);
           continue;
         }
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

        const prompt = await this.renderTemplate("arm-tasks-available-prompt.jinja", {
          task_count: taskCount,
        });

        const promptSuccess = await this.sendPromptToArm(
          arm.name,
          prompt
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
    * Reset an arm's OpenCode session to clear stale context.
    * This is called before assigning a new task to ensure the arm
    * doesn't have old task IDs in its conversation history.
    *
    * @returns true if reset was successful, false otherwise
    */
   private async resetArmSession(armId: string): Promise<boolean> {
     try {
       const result = await this.apiRequest<{ success: boolean; newSessionId?: string }>(
         `/api/arms/${armId}/reset-session`,
         { method: "POST" }
       );
       if (result?.success) {
         this.log(`Reset session for arm ${armId}: new session ${result.newSessionId}`);
         return true;
       }
       return false;
     } catch (err) {
       this.log(`Failed to reset session for arm ${armId}: ${err}`);
       return false;
     }
   }

   /**
    * Get a numeric config value from the database config table
    */
   private async getBrainConfigNumber(key: string, defaultValue: number): Promise<number> {
     if (!this.db) return defaultValue;
     try {
       const row = this.db.query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
       if (row) {
         return parseInt(row.value, 10);
       }
       return defaultValue;
     } catch {
       return defaultValue;
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
      .replace(new RegExp("\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])", "g"), "")
      // OSC sequences (terminal titles, hyperlinks, etc.)
      .replace(new RegExp("\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)", "g"), "")
      // CSI sequences that might be malformed
      .replace(new RegExp("\\u001B\\[[\\d;]*[A-Za-z]", "g"), "")
      // Other escape sequences
      .replace(new RegExp("\\u001B[PX^_].*?\\u001B\\\\", "g"), "")
      // Control characters (keep \t \n \r)
      .replace(new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g"), "")
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
   * Check all infrastructure components and return health status
   * This should be called at the start of each poll cycle to ensure
   * the brain's "body" is healthy before working with arms.
   *
   * @returns Object with overall health status and details per component
   */
  private async checkInfrastructureHealth(): Promise<{
    healthy: boolean;
    canWorkWithArms: boolean;
    components: {
      database: { healthy: boolean; lastCheck: Date | null; error?: string };
      apiServer: { healthy: boolean; lastCheck: Date | null; error?: string };
      nats: { healthy: boolean; lastCheck: Date | null; error?: string; optional: boolean };
      maildir: { healthy: boolean; lastCheck: Date | null; error?: string };
    };
    issues: string[];
  }> {
    const now = new Date();
    const issues: string[] = [];

    // 1. Check Database (CRITICAL - required for everything)
    try {
      if (!this.db) {
        this.infrastructureHealth.database = { healthy: false, lastCheck: now, error: "Database not initialized" };
        issues.push("Database not initialized");
      } else {
        // Try a simple query to verify connection
        this.db.query("SELECT 1").get();
        this.infrastructureHealth.database = { healthy: true, lastCheck: now };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.infrastructureHealth.database = { healthy: false, lastCheck: now, error: errorMsg };
      issues.push(`Database error: ${errorMsg}`);
    }

    // 2. Check API Server (CRITICAL for arm communication)
    try {
      const apiHealthy = await this.isApiServerAvailable();
      if (apiHealthy) {
        this.infrastructureHealth.apiServer = { healthy: true, lastCheck: now };
      } else {
        this.infrastructureHealth.apiServer = { healthy: false, lastCheck: now, error: "API server not responding" };
        issues.push("API server not responding at " + this.apiBaseUrl);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.infrastructureHealth.apiServer = { healthy: false, lastCheck: now, error: errorMsg };
      issues.push(`API server error: ${errorMsg}`);
    }

    // 3. Check NATS (OPTIONAL - degrades functionality but not critical)
    try {
      if (this.natsClient) {
        const connected = this.natsClient.connected();
        if (connected) {
          this.infrastructureHealth.nats = { healthy: true, lastCheck: now, optional: true };
        } else {
          this.infrastructureHealth.nats = { healthy: false, lastCheck: now, error: "NATS disconnected", optional: true };
          // Not a critical issue - we can work without NATS
        }
      } else {
        this.infrastructureHealth.nats = { healthy: false, lastCheck: now, error: "NATS client not initialized", optional: true };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.infrastructureHealth.nats = { healthy: false, lastCheck: now, error: errorMsg, optional: true };
    }

    // 4. Check Maildir (IMPORTANT for human communication but not blocking)
    try {
      // Try to list inbox to verify maildir is accessible
      await this.inbox.list("new");
      this.infrastructureHealth.maildir = { healthy: true, lastCheck: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.infrastructureHealth.maildir = { healthy: false, lastCheck: now, error: errorMsg };
      issues.push(`Maildir error: ${errorMsg}`);
    }

    // Determine overall health
    // Critical: database must be healthy
    // For arm work: API server must be healthy
    const databaseHealthy = this.infrastructureHealth.database.healthy;
    const apiHealthy = this.infrastructureHealth.apiServer.healthy;
    const canWorkWithArms = databaseHealthy && apiHealthy;
    const healthy = databaseHealthy && apiHealthy && this.infrastructureHealth.maildir.healthy;

    // Log health status
    if (!healthy) {
      this.log(`Infrastructure health check: ${issues.length} issue(s)`);
      for (const issue of issues) {
        this.log(`  - ${issue}`);
      }
    }

    // Persist infrastructure health to database for API server to read
    if (this.db) {
      try {
        const components = [
          {
            component: 'database',
            healthy: this.infrastructureHealth.database.healthy,
            optional: false,
            error: this.infrastructureHealth.database.error,
          },
          {
            component: 'nats',
            healthy: this.infrastructureHealth.nats.healthy,
            optional: true,
            error: this.infrastructureHealth.nats.error,
          },
          {
            component: 'maildir',
            healthy: this.infrastructureHealth.maildir.healthy,
            optional: false,
            error: this.infrastructureHealth.maildir.error,
          },
          {
            component: 'api_server',
            healthy: this.infrastructureHealth.apiServer.healthy,
            optional: false,
            error: this.infrastructureHealth.apiServer.error,
          },
        ];

        const result = await updateInfrastructureHealth(this.db, components);
        if (!result.success) {
          this.log(`Failed to persist infrastructure health: ${result.error}`);
        }
      } catch (err) {
        this.log(`Failed to persist infrastructure health: ${err}`);
      }
    }

    return {
      healthy,
      canWorkWithArms,
      components: this.infrastructureHealth,
      issues,
    };
  }

  /**
   * Attempt to recover from infrastructure failures
   * Returns true if recovery was successful
   */
  private async attemptInfrastructureRecovery(): Promise<boolean> {
    let recovered = false;

    // Try to reconnect database if needed
    if (!this.infrastructureHealth.database.healthy && !this.db) {
      try {
        const dbPath = join(this.options.coleoDir, "coleo.db");
        this.db = await initDatabase(dbPath);
        this.log("Recovered database connection");
        recovered = true;
      } catch (err) {
        this.log(`Failed to recover database: ${err}`);
      }
    }

    // Try to reconnect NATS if needed
    if (!this.infrastructureHealth.nats.healthy && !this.natsClient) {
      try {
        this.natsClient = new NatsClient({
          serverUrl: this.natsUrl,
          clientId: `brain-${process.pid}`,
        });
        await this.natsClient.connect();
        this.log("Recovered NATS connection");
        recovered = true;
      } catch {
        // NATS is optional, don't log as error
      }
    }

    return recovered;
  }

  /**
   * Notify human about infrastructure issues (rate-limited)
   */
  private async notifyInfrastructureIssues(issues: string[]): Promise<void> {
    // Rate limit: only notify once per 15 minutes
    if (this.lastInfraFailureNotification) {
      const minutesSince = (Date.now() - this.lastInfraFailureNotification.getTime()) / 1000 / 60;
      if (minutesSince < 15) {
        return;
      }
    }

    this.lastInfraFailureNotification = new Date();

    // Create a system-detected bug report for critical infrastructure issues
    const criticalIssues = issues.filter(issue =>
      issue.includes("Database") || issue.includes("API Server") || issue.includes("Maildir")
    );
    if (criticalIssues.length > 0) {
      const bugPayload = {
        id: `bug-system-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: "Critical Infrastructure Issues Detected",
        description: `The brain detected critical infrastructure failures that may prevent normal operation:\n\n${criticalIssues.map(i => `- ${i}`).join("\n")}\n\nComponent Status:\n- Database: ${this.infrastructureHealth.database.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.database.error || "Unhealthy")}\n- API Server: ${this.infrastructureHealth.apiServer.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.apiServer.error || "Unhealthy")}\n- NATS: ${this.infrastructureHealth.nats.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.nats.error || "Unhealthy")} (optional)\n- Maildir: ${this.infrastructureHealth.maildir.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.maildir.error || "Unhealthy")}`,
        source: "system_detected" as const,
        sourceTaskId: undefined,
        errorDetails: JSON.stringify({
          infrastructureHealth: this.infrastructureHealth,
          issues,
          timestamp: new Date().toISOString(),
        }),
      };

      await this.handleBugReport("system", bugPayload);
      this.log(`Created system-detected bug report for infrastructure issues`);
    }

    const body = await this.renderTemplate("human-infra-issues.jinja", {
      issues_list: issues.map(i => `- ${i}`).join("\n"),
      db_status: this.infrastructureHealth.database.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.database.error || "Unhealthy"),
      api_status: this.infrastructureHealth.apiServer.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.apiServer.error || "Unhealthy"),
      nats_status: this.infrastructureHealth.nats.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.nats.error || "Unhealthy"),
      maildir_status: this.infrastructureHealth.maildir.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.maildir.error || "Unhealthy"),
    });
    await this.sendToHuman({
      subject: "[coleo] Infrastructure health issues detected",
      body,
      headers: {
        "X-Coleo-Type": "infrastructure-alert",
        "Priority": "high",
      },
    });

    this.logActivity("brain", "infrastructure_alert", undefined, { issues });
  }

  /**
   * Read recent logs for an arm from the log file
   * Returns cleaned output with TUI artifacts stripped
   */
  private async readArmLogs(armId: string, tailLines = 100): Promise<string> {
    const logPath = join(this.options.coleoDir, "logs", `${armId}.log`);
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
          // Harness says idle but DB says busy - check state machine first
          // The state machine is the source of truth for task assignment state
          if (this.armStateMachine) {
            const smContext = this.armStateMachine.getContext(arm.id);
            if (smContext && (smContext.state === "task_assigned" || smContext.state === "working")) {
              // State machine knows arm has a task - don't sync to idle
              // The harness reporting idle is expected during task acknowledgment
              this.log(`Arm ${arm.name}: harness reports idle but state machine is in "${smContext.state}" - keeping busy (task: "${smContext.currentTaskSubject}")`);
              continue;
            }
          }
           // No state machine or state machine agrees it's idle - sync them
           // But first check if arm has recent event activity (might be processing)
           const lastEventTime = this.lastArmEventTime.get(arm.id);
           if (lastEventTime) {
             const secondsSinceEvent = (Date.now() - lastEventTime.getTime()) / 1000;
             if (secondsSinceEvent < 60) {
               // Arm had activity in the last 60 seconds - don't sync to idle yet
               this.log(`Arm ${arm.name}: recent event ${secondsSinceEvent.toFixed(1)}s ago, keeping busy`);
               continue;
             }
           }
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
          const prompt = await this.renderTemplate("arm-loop-compact-nudge.jinja");
          await this.sendPromptToArm(arm.name, prompt);
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

      case "prompt": {
        // Send a generic nudge to continue
        const defaultNudge = await this.renderTemplate("arm-generic-nudge.jinja");
        const nudgeMessage = analysis.suggestedResponse || defaultNudge;
        this.log(`Prompting ${arm.name} to continue: "${nudgeMessage.slice(0, 50)}..."`);
        await this.sendPromptToArm(arm.name, nudgeMessage);
        this.logActivity("brain", "arm_unstuck", arm.id, {
          action: "prompted",
          response: nudgeMessage.slice(0, 100),
        });
        break;
      }

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

    const body = await this.renderTemplate("human-arm-stuck.jinja", {
      arm_name: arm.name,
      stuck_type: analysis.stuckType,
      confidence_percent: Math.round(analysis.confidence * 100),
      reasoning: analysis.reasoning,
      task_info: taskInfo,
      recent_output: recentOutput.slice(-2000),
      suggested_action: analysis.suggestedAction || "manual intervention",
    });
    await this.sendToHuman({
      subject: `[coleo] Arm ${arm.name} needs help (${analysis.stuckType})`,
      body,
      headers: {
        "X-Coleo-Type": "arm-stuck",
        "X-Coleo-Arm": arm.name,
        "X-Coleo-Stuck-Type": analysis.stuckType || "unknown",
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
        // New tracker for this arm - check if it has recent productive activity
        // This handles arms that were working autonomously before brain came online
        const recentActivity = await this.getRecentArmActivity(arm.id, 60); // Check last 60 minutes
        const lastProductiveActivity = recentActivity?.find(a => this.isProductiveAction(a.action));

        tracker = {
          promptCount: 0,
          lastPromptAt: new Date(),
          lastProductiveAt: lastProductiveActivity ? new Date(lastProductiveActivity.timestamp) : null,
          escalationLevel: 0,
        };
        this.idleArmPromptTracker.set(arm.id, tracker);

        // If the arm has recent productive activity, skip stuck loop detection for now
        // This prevents the brain from interrupting arms that were working autonomously
        if (tracker.lastProductiveAt) {
          const idleMinutes = (Date.now() - tracker.lastProductiveAt.getTime()) / 1000 / 60;
          this.log(`Arm ${arm.id}: has recent productive activity (${idleMinutes.toFixed(1)}m ago), skipping stuck loop check`);
          continue;
        }
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
   * Now reads from JetStream instead of SQLite
   */
  private async getRecentArmActivity(armId: string, minutes: number): Promise<Array<{timestamp: string; action: string; details: string}> | null> {
    if (!eventStore.isInitialized()) return null;

    const since = new Date(Date.now() - minutes * 60 * 1000);
    try {
      const events = await eventStore.getArmEvents(armId, 100);

      // Filter to events within the time window and transform to expected format
      return events
        .filter(e => new Date(e.timestamp) > since)
        .map(e => ({
          timestamp: e.timestamp,
          action: e.type,
          details: JSON.stringify(e.data),
        }))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
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
        const body = await this.renderTemplate("human-arm-idle-loop.jinja", {
          arm_name: arm.name,
          stuck_minutes: stuckMinutes.toFixed(1),
          prompt_count: tracker.promptCount,
          arm_status: arm.status,
          last_productive: tracker.lastProductiveAt?.toISOString() || "never",
        });
        await this.sendToHuman({
          subject: `[coleo] Arm ${arm.name} stuck in idle loop`,
          body,
        });
        tracker.escalationLevel = 3;
        break;

      case 3: // Already escalated - auto-kill after 20+ minutes
        if (stuckMinutes >= 20) {
          this.log(`Arm ${arm.id} stuck for 20+ minutes after escalation. Auto-killing zombie arm...`);
          this.logActivity("brain", "arm_zombie_killed", arm.id, {
            stuckMinutes,
            promptCount: tracker.promptCount,
            action: "auto_kill",
          });
          await this.killZombieArm(arm);
        } else if (stuckMinutes >= 15) {
          this.log(`Arm ${arm.id} stuck for 15+ minutes. Will auto-kill at 20 minutes.`);
        }
        break;
    }

    // Reset prompt count after any intervention (we'll re-detect if still stuck)
    tracker.promptCount = 0;
  }

  /**
   * Kill a zombie arm that has been unresponsive for too long
   * Terminates the process and cleans up database state
   */
  private async killZombieArm(arm: Arm): Promise<void> {
    try {
      // First try to kill via API (graceful shutdown)
      try {
        await this.apiRequest(`/api/arms/${arm.id}/kill`, {
          method: "POST",
          body: JSON.stringify({ reason: "zombie_detection" }),
        });
        this.log(`Sent kill request to API for arm ${arm.name}`);
      } catch {
        this.log(`API kill failed for arm ${arm.name}, trying direct kill...`);
      }

      // Direct process kill if we have a PID
      if (arm.pid) {
        try {
          process.kill(arm.pid, "SIGKILL");
          this.log(`Killed arm ${arm.name} process (PID: ${arm.pid})`);
        } catch (err) {
          this.log(`Failed to kill PID ${arm.pid}: ${err}`);
        }
      }

      // Update database status
      if (this.db) {
        const now = new Date().toISOString();
        this.db.run(
          "UPDATE arms SET status = 'stopped', updated_at = ? WHERE id = ?",
          [now, arm.id]
        );
      }

      // Remove from in-memory tracking
      this.arms.delete(arm.id);
      this.idleArmPromptTracker.delete(arm.id);
      this.lastStuckState.delete(arm.id);

      // Notify human
      const body = await this.renderTemplate("human-arm-zombie-killed.jinja", {
        arm_name: arm.name,
      });
      await this.sendToHuman({
        subject: `[coleo] Auto-killed zombie arm: ${arm.name}`,
        body,
      });

      // Mark any current task as blocked
      if (arm.currentTask) {
        const task = this.tasks.find(t => t.id === arm.currentTask);
        if (task) {
          task.status = "blocked";
          task.updatedAt = new Date();
          await this.saveTasks();
          this.log(`Marked task ${task.id} as blocked due to zombie arm kill`);
        }
      }

      this.logActivity("brain", "arm_killed", arm.id, {
        reason: "zombie_detection",
        pid: arm.pid,
      });
    } catch (err) {
      this.log(`Error killing zombie arm ${arm.name}: ${err}`);
    }
  }

   /**
    * Assign pending tasks to available arms
    * Considers task domain preferences when assigning
    */
    private async assignTasks(): Promise<void> {
      const pendingTasks = this.tasks.filter(t => t.status === "pending");
      let idleArms = Array.from(this.arms.values()).filter(t => t.status === "idle");

     // Filter out arms that don't exist in the database (prevents foreign key constraint failures)
     if (this.db) {
       idleArms = idleArms.filter(arm => {
         const armExists = this.db!.query("SELECT 1 FROM arms WHERE id = ?").get(arm.id);
         if (!armExists) {
           this.log(`Arm ${arm.id} not found in database, excluding from task assignment`);
           return false;
         }
         return true;
       });
     }

     // Also filter by state machine state - only arms in 'idle' state can accept tasks
     if (this.armStateMachine) {
       idleArms = idleArms.filter(arm => {
         return this.armStateMachine!.canAcceptTask(arm.id);
       });
     }

      for (const task of pendingTasks) {
        // Check for blocking bugs before assigning
        if (this.db) {
          const blockingBugs = this.db.query(`
            SELECT id, title, priority, blockers
            FROM bugs
            WHERE status NOT IN ('resolved', 'closed')
              AND json_array_length(blockers) > 0
              AND EXISTS (
                SELECT 1 FROM json_each(blockers) WHERE json_each.value = ?
              )
          `).all(task.id) as Array<{ id: string; title: string; priority: string; blockers: string }>;

          if (blockingBugs.length > 0) {
            // Task is blocked by unresolved bugs
            this.log(`Task ${task.id} blocked by ${blockingBugs.length} unresolved bug(s)`);

            // Update task status to blocked
            task.status = "blocked";
            task.updatedAt = new Date();

            // Notify human about blocked task for critical/high priority bugs
            const criticalBugs = blockingBugs.filter(b => b.priority === 'critical');
            const highBugs = blockingBugs.filter(b => b.priority === 'high');

            if (criticalBugs.length > 0 || highBugs.length > 0) {
              const body = await this.renderTemplate("human-task-blocked-by-bugs.jinja", {
                task_id: task.id,
                task_subject: task.subject,
                blocking_bugs_list: blockingBugs.map(b => `- ${b.title} (${b.priority} priority)`).join("\n"),
              });
              await this.sendToHuman({
                subject: `[coleo] Task Blocked by ${criticalBugs.length + highBugs.length} Critical/High Priority Bug(s)`,
                body,
                headers: {
                  "X-Coleo-Type": "task-blocked",
                  "X-Coleo-Task-Id": task.id,
                },
              });
            }

            continue; // Skip this task, it's blocked
          }
        }

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

       // Reset the arm's OpenCode session to clear stale context before assigning new task
       // This prevents the arm from trying to work on old task IDs from previous sessions
       const sessionReset = await this.resetArmSession(bestArm.id);
       if (!sessionReset) {
         this.log(`Warning: Could not reset session for ${bestArm.id} before task assignment (arm may have stale context)`);
         // Continue anyway - the arm might still work correctly
       }

       // Use state machine to transition arm to task_assigned state
       if (this.armStateMachine) {
         const result = await this.armStateMachine.transition(bestArm.id, {
           type: "TASK_ASSIGNED",
           taskId: task.id,
           taskSubject: task.subject,
         });

         if (!result.success) {
           this.log(`Failed to assign task to ${bestArm.id}: ${result.error}`);
           continue;
         }
       }

        task.assignedTo = bestArm.id;
         task.updatedAt = new Date();

        // Assign task to arm in database
        if (this.db) {
          const result = await assignTaskToArm(this.db, task.id, bestArm.id, 'primary', false);

          // Update arm status in database
          const now = new Date().toISOString();
          this.db.run(`
            UPDATE arms
            SET status = 'busy',
                current_task_id = ?,
                current_task_subject = ?,
                last_activity_at = ?,
                updated_at = ?
            WHERE id = ?
          `, [task.id, task.subject, now, now, bestArm.id]);
        }

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
   * Send a message to an arm's queue (SQLite-based)
   */
  private async sendToArm(
    armId: string,
    message: { type: string; payload: unknown }
  ): Promise<void> {
    if (!this.db) {
      this.log(`Cannot send to arm ${armId}: database not initialized`);
      return;
    }

    const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    queueMessage(this.db, {
      id: messageId,
      from: "brain",
      to: armId,
      type: message.type,
      payload: message.payload,
    });
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
      from: "brain@coleo.local",
      to: "human@local",
      subject: this.stripTerminalArtifacts(message.subject),
      date: new Date(),
      body: this.stripTerminalArtifacts(message.body),
      headers: message.headers || {},
    });
  }

  // State persistence methods - use SQLite instead of file storage

  private async loadState(): Promise<void> {
    if (!this.db) return;

    try {
      const row = this.db.query("SELECT * FROM brain_state WHERE id = 1").get() as {
        status: string;
        poll_interval_ms: number;
        started_at: string | null;
        last_poll_at: string | null;
        pending_tasks: number;
        completed_today: number;
      } | null;

      if (row) {
        this.state = {
          status: row.status as BrainState["status"],
          pollIntervalMs: row.poll_interval_ms,
          activeArms: [],
          startedAt: row.started_at || undefined,
          lastPollAt: row.last_poll_at || undefined,
          pendingTasks: row.pending_tasks,
          completedToday: row.completed_today,
        };
      }
    } catch (err) {
      // Table might not exist yet
      console.error(`Failed to load brain state from database: ${err}`);
    }
  }

  private async saveState(): Promise<void> {
    if (!this.db) return;

    try {
      this.db.run(`
        INSERT OR REPLACE INTO brain_state (
          id, status, poll_interval_ms, started_at, last_poll_at, pending_tasks, completed_today, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        1,
        this.state.status,
        this.state.pollIntervalMs,
        this.state.startedAt || null,
        this.state.lastPollAt || null,
        this.state.pendingTasks,
        this.state.completedToday,
        new Date().toISOString(),
      ]);
    } catch (err) {
      console.error(`Failed to save brain state to database: ${err}`);
    }
  }

  private async loadTasks(): Promise<void> {
    // Load tasks from SQLite only (single source of truth)
    if (!this.db) {
      this.log("Cannot load tasks: database not initialized");
      this.tasks = [];
      return;
    }

    try {
      const dbTasks = this.db.query(`
        SELECT id, subject, description, status, priority, domain, classification,
               assigned_to, created_at, updated_at, completed_at, artifacts,
               mail_thread_id, context
        FROM tasks
        WHERE status IN ('pending', 'claimed', 'in_progress', 'blocked')
      `).all() as Array<{
        id: string;
        subject: string;
        description: string;
        status: string;
        priority: string;
        domain: string | null;
        classification: string | null;
        assigned_to: string | null;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
        artifacts: string | null;
        mail_thread_id: string | null;
        context: string | null;
      }>;

      this.tasks = dbTasks.map(dbTask => ({
        id: dbTask.id,
        subject: dbTask.subject,
        description: dbTask.description,
        status: dbTask.status as Task["status"],
        priority: dbTask.priority as Task["priority"],
        domain: dbTask.domain || undefined,
        classification: dbTask.classification || undefined,
        assignedTo: dbTask.assigned_to || undefined,
        createdAt: new Date(dbTask.created_at),
        updatedAt: new Date(dbTask.updated_at),
        completedAt: dbTask.completed_at ? new Date(dbTask.completed_at) : undefined,
        artifacts: dbTask.artifacts ? JSON.parse(dbTask.artifacts) : undefined,
        mailThreadId: dbTask.mail_thread_id || undefined,
        context: dbTask.context ? JSON.parse(dbTask.context) : undefined,
      }));
    } catch (err) {
      this.log(`Error loading tasks from database: ${err}`);
      this.tasks = [];
    }

    this.state.pendingTasks = this.tasks.filter(t => t.status === "pending").length;
  }

  private async saveTasks(): Promise<void> {
    // Sync in-memory tasks to SQLite (single source of truth)
    if (!this.db) {
      this.log("Cannot save tasks: database not initialized");
      return;
    }

    const now = new Date().toISOString();

    // Get valid arm IDs to avoid foreign key constraint failures
    // The tasks table has a FK constraint: FOREIGN KEY (assigned_to) REFERENCES arms(id)
    const validArmIds = new Set<string>();
    try {
      const armRows = this.db.query("SELECT id FROM arms").all() as Array<{ id: string }>;
      for (const row of armRows) {
        validArmIds.add(row.id);
      }
    } catch (err) {
      this.log(`Error getting arm IDs for task save: ${err}`);
    }

    for (const task of this.tasks) {
      // Clear assignedTo if the arm doesn't exist (avoids FK constraint failure)
      const assignedTo = task.assignedTo && validArmIds.has(task.assignedTo)
        ? task.assignedTo
        : null;

      // Also update in-memory task if we cleared the assignment
      if (task.assignedTo && !validArmIds.has(task.assignedTo)) {
        this.log(`Clearing invalid assignment for task ${task.id}: arm ${task.assignedTo} not found`);
        task.assignedTo = undefined;
        // Reset status if it was claimed/in_progress but arm is gone
        if (task.status === "claimed" || task.status === "in_progress") {
          task.status = "pending";
        }
      }

      this.db.run(
        `INSERT INTO tasks (id, subject, description, status, priority, domain, classification,
                           assigned_to, created_at, updated_at, completed_at, artifacts,
                           mail_thread_id, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           subject = excluded.subject,
           description = excluded.description,
           status = excluded.status,
           priority = excluded.priority,
           domain = excluded.domain,
           classification = excluded.classification,
           assigned_to = excluded.assigned_to,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at,
           artifacts = excluded.artifacts,
           mail_thread_id = excluded.mail_thread_id,
           context = excluded.context`,
        [
          task.id,
          task.subject,
          task.description,
          task.status,
          task.priority,
          task.domain || null,
          task.classification || null,
          assignedTo,
          task.createdAt.toISOString(),
          now,
          task.completedAt?.toISOString() || null,
          task.artifacts ? JSON.stringify(task.artifacts) : null,
          task.mailThreadId || null,
          task.context ? JSON.stringify(task.context) : null,
        ]
      );
    }

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

  /**
   * Process inbox items
   *
   * Reads .project/inbox.md, creates tasks from items, clears the inbox.
   * Items are deduplicated against existing tasks.
   */
  private async processInbox(): Promise<void> {
    if (!this.db) return;

    try {
      const projectRoot = process.env.OCTOPAI_PROJECT_ROOT || process.cwd();

      // Parse inbox
      const result = await parseInbox(projectRoot);

      if (result.wasEmpty) {
        return; // Nothing to process
      }

      if (result.errors.length > 0) {
        this.log(`Inbox parse errors: ${result.errors.join(", ")}`);
        return;
      }

      // Get existing tasks with their comments for deduplication
      // Join task_comments to get all text associated with each task
      const existingTasks = this.db.query(`
        SELECT
          t.id,
          t.subject,
          t.description,
          GROUP_CONCAT(tc.content, ' ') as comments_text
        FROM tasks t
        LEFT JOIN task_comments tc ON t.id = tc.task_id
        WHERE t.status IN ('pending', 'claimed', 'in_progress', 'blocked')
        GROUP BY t.id, t.subject, t.description
      `).all() as Array<{
        id: string;
        subject: string;
        description: string;
        comments_text: string | null;
      }>;

      // Map to format expected by deduplicateItems, combining all text
      const tasksForDeduplication = existingTasks.map(task => ({
        subject: task.subject,
        description: `${task.description} ${task.comments_text || ''}`.trim(),
      }));

      // Deduplicate
      const newItems = deduplicateItems(result.items, tasksForDeduplication);

      if (newItems.length === 0) {
        // All items were duplicates, clear inbox anyway
        await clearInbox(projectRoot);
        this.log(`Inbox: ${result.items.length} items were duplicates, cleared inbox`);
        return;
      }

      // Create tasks from inbox items
      let created = 0;
      for (const item of newItems) {
        const taskId = `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        this.db.run(`
          INSERT INTO tasks (id, subject, description, status, priority, source_type, source_ref, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', ?, 'inbox', '.project/inbox.md', datetime('now'), datetime('now'))
        `, [taskId, item.subject, item.description, item.priority]);

        created++;
      }

      // Clear the inbox
      await clearInbox(projectRoot);

      this.log(`Inbox: created ${created} tasks, cleared inbox`);
      this.logActivity("brain", "inbox_processed", undefined, {
        itemsFound: result.items.length,
        duplicates: result.items.length - newItems.length,
        tasksCreated: created
      });

    } catch (err) {
      this.log(`Failed to process inbox: ${err}`);
    }
  }

  /**
   * Re-evaluate plan progress (Progressive Planning)
   *
   * This method implements the core progressive planning logic:
   * 1. Check recently completed tasks for status reports with issues
   * 2. Create "verify & polish" tasks for work that needs follow-up
   * 3. Unblock tasks whose dependencies are now satisfied
   * 4. Log re-evaluation activity for observability
   *
   * Called periodically during the poll cycle.
   */
  private async reEvaluatePlanProgress(): Promise<void> {
    if (!this.db) return;

    try {
      // Step 1: Find recently completed tasks that have status reports with issues
      // but don't yet have verification tasks created
      const tasksNeedingVerification = this.db.query(`
        SELECT DISTINCT
          t.id,
          t.subject,
          t.classification,
          t.domain,
          t.priority,
          sr.id as report_id,
          sr.summary,
          sr.issues,
          sr.tests_status
        FROM tasks t
        INNER JOIN status_reports sr ON t.id = sr.task_id
        LEFT JOIN tasks vt ON vt.subject LIKE 'Verify & Polish: ' || t.subject
        WHERE t.status = 'completed'
          AND sr.status IN ('issues_found', 'completed_with_issues', 'needs_review')
          AND vt.id IS NULL
          AND sr.created_at > datetime('now', '-24 hours')
        ORDER BY sr.created_at DESC
        LIMIT 5
      `).all() as Array<{
        id: string;
        subject: string;
        classification: string | null;
        domain: string | null;
        priority: string | null;
        report_id: string;
        summary: string;
        issues: string;
        tests_status: string | null;
      }>;

      let verificationTasksCreated = 0;

      for (const row of tasksNeedingVerification) {
        const issues = JSON.parse(row.issues || "[]") as string[];

        // Create a verify & polish task
        const verifyTask = await this.createVerificationTaskFromReEval(
          {
            id: row.id,
            subject: row.subject,
            classification: row.classification || "development",
            domain: row.domain || undefined,
            priority: row.priority || "normal",
          },
          {
            id: row.report_id,
            summary: row.summary,
            issues,
            testsStatus: row.tests_status as "passing" | "failing" | "not_run" | undefined,
          }
        );

        if (verifyTask) {
          verificationTasksCreated++;
          this.log(`Re-evaluation: Created verification task for "${row.subject}"`);
        }
      }

      // Step 2: Check for blocked tasks whose dependencies are now complete
      const unblockedTasks = this.db.query(`
        SELECT t.id, t.subject
        FROM tasks t
        WHERE (t.status = 'blocked' OR t.dependency_blocked = 1)
          AND NOT EXISTS (
            SELECT 1
            FROM task_dependencies td
            WHERE td.task_id = t.id
              AND NOT EXISTS (
                SELECT 1 FROM tasks dep
                WHERE dep.id = td.depends_on_task_id
                  AND dep.status = 'completed'
              )
          )
        LIMIT 10
      `).all() as Array<{ id: string; subject: string }>;

      let unblockedCount = 0;
      const now = new Date().toISOString();

      for (const row of unblockedTasks) {
        // Unblock the task
        this.db.run(`
          UPDATE tasks SET dependency_blocked = 0, status = 'pending', updated_at = ?
          WHERE id = ?
        `, [now, row.id]);

        // Update in-memory task list
        const task = this.tasks.find(t => t.id === row.id);
        if (task) {
          task.status = "pending";
          task.updatedAt = new Date();
        }

        unblockedCount++;
        this.log(`Re-evaluation: Unblocked task "${row.subject}"`);
        this.logActivity("brain", "task_unblocked", row.id, {
          reason: "dependencies_satisfied",
          subject: row.subject,
        });
      }

      // Log summary if any actions were taken
      if (verificationTasksCreated > 0 || unblockedCount > 0) {
        this.logActivity("brain", "plan_reevaluated", undefined, {
          verificationTasksCreated,
          tasksUnblocked: unblockedCount,
        });
      }
    } catch (err) {
      this.log(`Failed to re-evaluate plan progress: ${err}`);
    }
  }

  /**
   * Create a verification task during re-evaluation
   * Similar to createVerificationTask but called from re-evaluation context
   */
  private async createVerificationTaskFromReEval(
    originalTask: {
      id: string;
      subject: string;
      classification: string;
      domain?: string;
      priority: string;
    },
    report: {
      id: string;
      summary: string;
      issues: string[];
      testsStatus?: "passing" | "failing" | "not_run";
    }
  ): Promise<Task | null> {
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
Review and polish the implementation, addressing any issues found.

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

    // Add to in-memory list
    this.tasks.push(verifyTask);

    // Save to database
    if (this.db) {
      const now = new Date().toISOString();
      this.db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, classification, domain, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        verifyTask.id,
        verifyTask.subject,
        verifyTask.description,
        verifyTask.status,
        verifyTask.priority,
        verifyTask.classification || "qa",
        verifyTask.domain || null,
        now,
        now,
      ]);
    }

    this.logActivity("brain", "verification_task_created", taskId, {
      originalTaskId: originalTask.id,
      issueCount: report.issues.length,
      testsStatus: report.testsStatus,
      source: "re_evaluation",
    });

    return verifyTask;
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

          // Ensure arm has state machine entry
          if (this.armStateMachine) {
            const ctx = this.armStateMachine.getContext(arm.id);
            if (!ctx) {
              // Initialize state based on current arm status
              const initialState = row.status === "busy" ? "working" :
                                   row.status === "idle" ? "idle" :
                                   row.status === "starting" ? "starting" : "idle";
              this.armStateMachine.initializeArm(arm.id, initialState as ArmState);
            }
          }
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

          // Ensure arm has state machine entry
          if (this.armStateMachine) {
            const ctx = this.armStateMachine.getContext(arm.id);
            if (!ctx) {
              // Initialize state based on current arm status
              const initialState = status === "busy" ? "working" :
                                   status === "idle" ? "idle" :
                                   status === "starting" ? "starting" : "idle";
              this.armStateMachine.initializeArm(arm.id, initialState as ArmState);
            }
          }
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
    const logPath = join(this.options.coleoDir, "logs", "brain.log");
    const { appendFile } = await import("fs/promises");
    await appendFile(logPath, line + "\n", "utf-8");
  }

  /**
   * Sleep for a given number of milliseconds, but can be interrupted by abort signal
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.abortController || this.abortController.signal.aborted) {
        resolve();
        return;
      }

      const timeoutId = setTimeout(resolve, ms);

      // Listen for abort signal to wake up early
      const abortHandler = () => {
        clearTimeout(timeoutId);
        resolve();
      };

      this.abortController.signal.addEventListener('abort', abortHandler, { once: true });
    });
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
  type: "new_task" | "doc_update" | "bug_report" | "approval_response" | "query" | "prompt_arm" | "arm_instruction" | "escalate";
  subject?: string;
  body?: string;
  title?: string;
  description?: string;
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
  private systemPrompt: string;

  constructor(logger: (message: string) => void, systemPrompt: string) {
    this.logger = logger;
    this.systemPrompt = systemPrompt;
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.model = process.env.OPENAI_MODEL || "gpt-5-mini";
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  }

  async processMessage(
    subject: string,
    body: string,
    systemPrompt: string,
  ): Promise<ProcessedIntent> {
    if (!this.apiKey) {
      return this.fallbackParse(subject, body);
    }



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
  private templateDir: string;

  constructor(logger: (message: string) => void, coleoDir: string = process.cwd()) {
    this.logger = logger;
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.model = process.env.OPENAI_MODEL || "gpt-5-mini";
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    this.templateDir = join(coleoDir, "src", "brain", "templates");
  }

  private async renderTemplate(
    templateName: string,
    context: Record<string, unknown>
  ): Promise<string | null> {
    const templatePath = join(this.templateDir, templateName);
    try {
      const templateContent = await readFile(templatePath, "utf-8");
      return nunjucks.renderString(templateContent, context);
    } catch (err) {
      this.logger(`[stuck-analyzer] Failed to load template ${templateName}: ${err}`);
      return null;
    }
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

    const systemPrompt = await this.renderTemplate("stuck-analyzer-system-prompt.jinja", {
      arm_name: armName,
      arm_domain: armDomain,
      current_task: currentTask || "unknown",
    });

    const userMessage = await this.renderTemplate("stuck-analyzer-user-prompt.jinja", {
      recent_output: recentOutput.slice(-8000),
    });

    if (!systemPrompt || !userMessage) {
      return this.fallbackAnalysis(recentOutput);
    }

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
