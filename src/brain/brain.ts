/**
 * Brain - The central coordinator for Coleo
 *
 * Runs a polling loop that:
 * 1. Reads human mail from sent/
 * 2. Processes arm messages from queue/ and NATS
 * 3. Assigns tasks to arms
 * 4. Sends status updates to human inbox
 */

import { readdir, readFile, mkdir, rename } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { Maildir } from "../mail";
import { spawnArm, type SpawnOptions } from "../arm/spawner";
import { getDocWatcher, stopDocWatcher } from "../docs/watcher";
import {
	parsePlanFile,
	findPlanFiles,
	tasksToDatabaseFormat,
	type PlanParseResult,
} from "./plan-parser";
import { parseInbox, clearInbox, deduplicateItems } from "./inbox-parser";
import { DocUpdateTracker } from "./doc-tracker";
import { NatsClient, TOPICS, type BrainMessage } from "../nats";
import { eventStore } from "../nats/jetstream";
import { loadConfig } from "../config";
import {
	ArmStateMachine,
	type ArmState,
	type SideEffect,
} from "./arm-state-machine";
import {
	ArmHealthMonitor,
	type HealthCheckResult,
	type HealthMonitorCallbacks,
} from "./health-monitor";
import { BrainTemplateManager } from "./template-manager";
import { MailProcessor } from "./mail-processor";
import { StuckArmAnalyzer, type StuckAnalysis } from "./activity-analyzer";
import { TerminalDashboard, type ArmStatusRow } from "./terminal-dashboard";
import { createArmStateApiDatabase } from "./arm-state-api-db";
import { findLargeFiles as findLargeFilesUtil } from "./utils/find-large-files";
import type { ArmStateStore } from "./db-client";
import type {
	BrainState,
	Task,
	QueueMessage,
	Arm,
	Discovery,
	MessageType,
} from "../types";

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
	private initializedArmIds: Set<string> = new Set();
	private initializedArmIdsLoaded = false;
	private running = false;
	private shuttingDown = false;
	private abortController: AbortController | null = null;
	private armStateDb: ArmStateStore | null = null;
	private apiBaseUrl: string;
	private apiKey: string;
	private natsUrl!: string;
	private refactorFileThresholdLines = 400;
	private natsClient: NatsClient | null = null;
	private templates: BrainTemplateManager;
	private mailProcessor: MailProcessor;
	private stuckArmAnalyzer: StuckArmAnalyzer;
	private docTracker: DocUpdateTracker | null = null;
	private armStateMachine: ArmStateMachine | null = null;
	private healthMonitor: ArmHealthMonitor | null = null;
	private lastHealthCheck: HealthCheckResult | null = null;
	private dashboard: TerminalDashboard | null = null;

	// Track last stuck state per arm to avoid duplicate escalations
	// DEPRECATED: Now tracked by ArmHealthMonitor - kept for backward compatibility during transition
	private lastStuckState: Map<
		string,
		{ stuckType: string; escalatedAt: Date }
	> = new Map();
	// Track idle arm prompt-response patterns to detect stuck loops
	// DEPRECATED: Now tracked by ArmHealthMonitor - kept for backward compatibility during transition
	private idleArmPromptTracker: Map<
		string,
		{
			promptCount: number; // How many prompts sent without productive response
			lastPromptAt: Date; // When we last prompted this arm
			lastProductiveAt: Date | null; // When arm last did real work
			escalationLevel: number; // 0 = none, 1 = interrupt, 2 = compact, 3 = kill
		}
	> = new Map();
	// Track when each arm was first detected (for grace period)
	private armDetectionTimes: Map<string, Date> = new Map();
	// Track recent activity from event stream (for real-time busy detection)
	private lastArmEventTime: Map<string, Date> = new Map();
	// In-memory file subscriptions keyed by arm ID
	private fileSubscriptions: Map<string, Set<string>> = new Map();
	// Plan hash cache to avoid reprocessing unchanged plan files
	private planFileHashes: Map<string, string> = new Map();

	// Infrastructure health tracking
	private infrastructureHealth: {
		database: { healthy: boolean; lastCheck: Date | null; error?: string };
		apiServer: { healthy: boolean; lastCheck: Date | null; error?: string };
		nats: {
			healthy: boolean;
			lastCheck: Date | null;
			error?: string;
			optional: boolean;
		};
		maildir: { healthy: boolean; lastCheck: Date | null; error?: string };
	} = {
		database: { healthy: false, lastCheck: null },
		apiServer: { healthy: false, lastCheck: null },
		nats: { healthy: false, lastCheck: null, optional: true },
		maildir: { healthy: false, lastCheck: null },
	};
	private lastInfraFailureNotification: Date | null = null;

	// Track completed task count for refactoring cycle (every 5 tasks)
	private completedTaskCount = 0;

	/**
	 * Log an activity entry to JetStream
	 * This replaces the old SQLite activity table - JetStream is now the single source of truth
	 */
	private logActivity(
		actor: string,
		action: string,
		target?: string,
		details?: Record<string, unknown>,
	): void {
		// Skip logging during shutdown to avoid connection errors
		if (this.shuttingDown) {
			return;
		}

		// Publish to JetStream if initialized
		if (eventStore.isInitialized()) {
			const subject = target
				? `coleo.events.arm.${target}.${action}`
				: `coleo.events.brain.${action}`;

			eventStore
				.publishEvent(subject, {
					type: action,
					armId: target,
					data: { actor, ...details },
					timestamp: new Date().toISOString(),
				})
				.catch((err) => {
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
	private async handleStateMachineSideEffect(
		effect: SideEffect,
	): Promise<void> {
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
				if (!this.shuttingDown) {
					await this.patchTaskViaApi(effect.taskId, {
						status: effect.status as Task["status"],
					});
				}
				break;

			case "RELEASE_TASK":
				if (!this.shuttingDown) {
					await this.patchTaskViaApi(effect.taskId, {
						status: "pending",
						assignedTo: null,
					});
					this.log(`Released task ${effect.taskId} back to pending`);
				}
				break;

			case "MARK_ARM_STOPPED":
				if (!this.shuttingDown) {
					await this.patchArmViaApi(effect.armId, {
						status: "stopped",
						lastActivityAt: new Date().toISOString(),
					});
					this.arms.delete(effect.armId);
					this.idleArmPromptTracker.delete(effect.armId);
				}
				break;

			// SCHEDULE_TIMEOUT is handled internally by ArmStateMachine
		}
	}

	constructor(options: BrainOptions) {
		this.options = options;
		this.apiBaseUrl =
			options.apiBaseUrl ||
			process.env.COLEO_API_URL ||
			"http://localhost:8080";
		this.apiKey = options.apiKey || process.env.COLEO_API_KEY || "";
		this.natsUrl = process.env.COLEO_NATS_URL || "nats://localhost:4222";
		this.state = {
			status: "stopped",
			pollIntervalMs: options.pollIntervalMs,
			activeArms: [],
			pendingTasks: 0,
			completedToday: 0,
			completedTaskCount: 0,
		};

		// Set up mail directories
		this.inbox = new Maildir(join(options.coleoDir, "mail", "inbox"));
		this.sent = new Maildir(join(options.coleoDir, "mail", "sent"));

		// Initialize template manager
		this.templates = new BrainTemplateManager(this.options.coleoDir, (msg) =>
			this.log(msg),
		);

		// Initialize mail processor
		this.mailProcessor = new MailProcessor((msg) => this.log(msg), "");

		// Initialize stuck arm analyzer
		this.stuckArmAnalyzer = new StuckArmAnalyzer(
			(msg) => this.log(msg),
			this.options.coleoDir,
		);

		// Initialize terminal dashboard (TTY only)
		this.dashboard = new TerminalDashboard({ enabled: process.stdout.isTTY });
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
			this.natsClient.subscribe<BrainMessage>(
				TOPICS.BRAIN_MESSAGES,
				async (message) => {
					await this.handleBrainMessage(message);
				},
			);

			// Subscribe to arm events for real-time activity tracking
			this.natsClient.subscribe<{ armId: string; type: string }>(
				TOPICS.BROADCAST_ARMS,
				async (event) => {
					if (event.armId) {
						this.lastArmEventTime.set(event.armId, new Date());
						// Log to JetStream for history
						this.logActivity(
							"brain",
							`event-${event.type}`,
							event.armId,
							event as unknown as Record<string, unknown>,
						);
					}
				},
			);

			// Subscribe to individual arm events to update status based on session changes
			this.natsClient.subscribe<{
				armId: string;
				type: string;
				properties: Record<string, unknown>;
			}>(`arm.>`, async (event) => {
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
	private async handleArmEvent(
		armId: string,
		eventType: string,
		properties: Record<string, unknown>,
	): Promise<void> {
		// Skip event handling during shutdown
		if (this.shuttingDown) return;

		// Update arm status based on session status events
		if (eventType === "session.status") {
			const status = properties.status as { type: string } | undefined;
			if (status?.type) {
				let dbStatus: string;
				switch (status.type) {
					case "busy":
						dbStatus = "busy";
						break;
					case "idle":
						dbStatus = "idle";
						break;
					case "error":
						dbStatus = "error";
						break;
					default:
						return; // Don't update for unknown statuses
				}

				try {
					const now = new Date().toISOString();
					await this.patchArmViaApi(armId, {
						status: dbStatus,
						lastActivityAt: now,
					});

					this.log(
						`Updated arm ${armId} status to ${dbStatus} based on session.status event`,
					);

					// Broadcast status change to API/WebSocket
					if (this.natsClient) {
						await this.natsClient.publish(TOPICS.BROADCAST_ARMS, {
							armId,
							type: "arm.status_changed",
							status: dbStatus,
							source: "session_event",
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
		timeoutMs: number = 2000,
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
			// API not available
			return null;
		}
	}

	private async getArmFromApi(armId: string): Promise<{
		id: string;
		name: string;
		domain: string;
		harness: string;
		status: string;
		pid?: number;
		lastActivityAt?: string | null;
		lastHeartbeat?: string | null;
		currentTaskId?: string | null;
		currentTaskSubject?: string | null;
		currentBugId?: string | null;
		currentBugTitle?: string | null;
	} | null> {
		const response = await this.apiRequest<{
			arm: {
				id: string;
				name: string;
				domain: string;
				harness: string;
				status: string;
				pid?: number;
				lastActivityAt?: string | null;
				lastHeartbeat?: string | null;
				currentTaskId?: string | null;
				currentTaskSubject?: string | null;
				currentBugId?: string | null;
				currentBugTitle?: string | null;
			};
		}>(`/api/arms/${encodeURIComponent(armId)}`);
		return response?.arm || null;
	}

	private async listArmsFromApi(includeAll = false): Promise<
		Array<{
			id: string;
			name: string;
			domain: string;
			harness: string;
			status: string;
			pid?: number;
			lastActivityAt?: string | null;
			lastHeartbeat?: string | null;
			currentTaskId?: string | null;
			currentTaskSubject?: string | null;
			currentBugId?: string | null;
			currentBugTitle?: string | null;
			createdAt?: string;
			provider?: string;
			model?: string;
		}>
	> {
		const suffix = includeAll ? "?includeAll=true" : "";
		const response = await this.apiRequest<{
			arms: Array<{
				id: string;
				name: string;
				domain: string;
				harness: string;
				status: string;
				pid?: number;
				lastActivityAt?: string | null;
				lastHeartbeat?: string | null;
				currentTaskId?: string | null;
				currentTaskSubject?: string | null;
				currentBugId?: string | null;
				currentBugTitle?: string | null;
				createdAt?: string;
				provider?: string;
				model?: string;
			}>;
		}>(`/api/arms${suffix}`);
		return response?.arms || [];
	}

	private async patchArmViaApi(
		armId: string,
		patch: {
			status?: string;
			lastActivityAt?: string | null;
			lastHeartbeat?: string | null;
			currentTaskId?: string | null;
			currentTaskSubject?: string | null;
			currentBugId?: string | null;
			currentBugTitle?: string | null;
		},
	): Promise<boolean> {
		const response = await this.apiRequest<{ arm?: { id: string } }>(
			`/api/arms/${encodeURIComponent(armId)}`,
			{
				method: "PATCH",
				body: JSON.stringify(patch),
			},
		);
		return !!response?.arm;
	}

	private async queueMessageViaApi(input: {
		id: string;
		from: string;
		to: string;
		type: string;
		payload: unknown;
	}): Promise<boolean> {
		const response = await this.apiRequest<{ queued?: boolean }>(
			"/api/brain/internal/messages/queue",
			{
				method: "POST",
				body: JSON.stringify(input),
			},
		);
		return response?.queued === true;
	}

	private async listPendingMessagesViaApi(
		to: string,
		limit = 500,
	): Promise<
		Array<{
			id: string;
			from: string;
			to: string;
			type: string;
			payload: unknown;
			createdAt: string;
		}>
	> {
		const params = new URLSearchParams({
			to,
			limit: String(limit),
		});
		const response = await this.apiRequest<{
			messages?: Array<{
				id: string;
				from: string;
				to: string;
				type: string;
				payload: unknown;
				createdAt: string;
			}>;
		}>(`/api/brain/internal/messages/pending?${params.toString()}`);
		return response?.messages || [];
	}

	private async markMessageStatusViaApi(
		messageId: string,
		status: "processing" | "completed" | "failed",
		error?: string,
	): Promise<void> {
		await this.apiRequest<{ success?: boolean }>(
			`/api/brain/internal/messages/${encodeURIComponent(messageId)}/status`,
			{
				method: "POST",
				body: JSON.stringify({ status, error }),
			},
		);
	}

	private async cleanupMessagesViaApi(olderThanDays = 7): Promise<void> {
		await this.apiRequest<{ deleted?: number }>(
			"/api/brain/internal/messages/cleanup",
			{
				method: "POST",
				body: JSON.stringify({ olderThanDays }),
			},
		);
	}

	private async recordFileChangeViaApi(input: {
		filePath: string;
		changeType: string;
		detectedByArmId?: string;
		contentHash?: string;
		changedAt?: string;
	}): Promise<void> {
		await this.apiRequest<{ recorded?: boolean }>(
			"/api/brain/internal/file-changes",
			{
				method: "POST",
				body: JSON.stringify(input),
			},
		);
	}

	/**
	 * Initialize brain state and directories
	 */
	async init(): Promise<void> {
		const config = await loadConfig(this.options.coleoDir);
		this.refactorFileThresholdLines =
			config.brain.refactorFileThresholdLines ?? 400;

		// Initialize API-backed arm state persistence.
		this.armStateDb = createArmStateApiDatabase(this.apiBaseUrl, this.apiKey);

		// Initialize doc update tracker
		this.docTracker = new DocUpdateTracker(
			this.apiBaseUrl,
			this.apiKey,
			this.options.coleoDir,
			process.cwd(),
		);

		// Initialize arm state machine
		this.armStateMachine = new ArmStateMachine(this.armStateDb, (effect) =>
			this.handleStateMachineSideEffect(effect),
		);

		// Initialize health monitor with callbacks
		const healthCallbacks: HealthMonitorCallbacks = {
			getActiveArmIds: async () => {
				const arms = await this.listArmsFromApi(true);
				return arms
					.filter((arm) => arm.status !== "stopped" && arm.status !== "error")
					.map((arm) => arm.id);
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
				await this.patchArmViaApi(armId, {
					status: "stopped",
					lastActivityAt: new Date().toISOString(),
				});
				this.arms.delete(armId);
				this.logActivity("brain", "arm_killed", armId, {
					reason,
					source: "health_monitor",
				});
			},
			notifyHuman: async (subject, body) => {
				await this.sendToHuman({ subject, body });
			},
			replyToPermission: async (armId, _requestId, approved) => {
				const response = approved ? "Yes, proceed." : "No, do not proceed.";
				await this.sendPromptToArm(armId, response);
			},
			getArmRuntimeState: async (armId) => {
				return await this.getArmHarnessState(armId);
			},
		};

		this.healthMonitor = new ArmHealthMonitor(healthCallbacks, {
			log: (msg) => this.log(msg),
			config: {
				checkIntervalMs: 30 * 1000, // 30 seconds
				eventWindowMs: 10 * 60 * 1000, // 10 minutes
				idlePromptDelayMs: 12 * 60 * 1000, // 12 minutes
				startupGracePeriodMs: 5 * 60 * 1000, // 5 minutes
				autoInterventionEnabled: true,
			},
			onResult: (result) => {
				this.lastHealthCheck = result;
				this.refreshDashboard();
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
		await this.templates.ensureTemplatesExist();

		// Initialize maildirs
		await this.inbox.init();
		await this.sent.init();

		// Load existing state (but reset activeArms - they'll be populated from DB)
		await this.loadState();
		this.state.activeArms = []; // Reset - get from database on first poll

		await this.loadTasks();
		await this.loadArms();
		this.refreshDashboard();
		// seenArmIds removed - now derived from database (hasReceivedInitialTasks)

		// Start documentation watcher for project docs
		try {
			const projectRoot = process.cwd();
			const docWatcher = getDocWatcher(projectRoot);
			docWatcher.onChange(async (event) => {
				// Log doc changes
				this.log(
					`Documentation changed: ${event.relativePath} (${event.type})`,
				);

				// If requirements or plans changed, re-evaluate pending tasks
				if (
					event.relativePath.includes("requirements") ||
					event.relativePath.includes("plans")
				) {
					this.log(
						`Re-evaluating tasks due to doc change: ${event.relativePath}`,
					);
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

			// Refresh tasks from database before assignment
			await this.loadTasks();

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

			// Step 5: Maintain task queue state (no push assignment; arms pull tasks)
			await this.assignTasks();

			// Step 6: Assign initial tasks to arms that are still idle
			await this.assignInitialTasks();

			// Step 7: Prompt idle arms to check for work or file changes
			await this.promptIdleArms();
		} else {
			this.log("API server unavailable - skipping arm operations");
		}

		// Step 8: Sync tasks from plan files via API-backed state adapter
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

		this.log(
			`Poll complete. ${this.tasks.filter((t) => t.status === "pending").length} pending, ${this.arms.size} arms`,
		);
	}

	/**
	 * Notify Observatory of brain event
	 */
	private async notifyObservatory(
		event: "started" | "stopped" | "paused" | "resumed" | "poll",
	): Promise<void> {
		if (!this.apiBaseUrl || !this.apiKey) return;

		try {
			const now = Date.now();
			const startedAt = this.state.startedAt
				? new Date(this.state.startedAt).getTime()
				: null;
			const uptime = startedAt
				? Math.floor((now - startedAt) / 1000)
				: undefined;

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
		this.logActivity("brain", "started", undefined, {
			pollIntervalMs: this.options.pollIntervalMs,
		});

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

		// Close arm state adapter
		if (this.armStateDb) {
			this.armStateDb.close?.();
			this.armStateDb = null;
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
		const armContexts = Array.from(this.arms.values()).map((arm) => ({
			name: arm.name,
			domain: (arm as Arm & { domain?: string }).domain || "general",
			status: arm.status,
		}));

		// Get recent activity from JetStream for LLM context
		let recentActivity: string[] = [];
		if (eventStore.isInitialized()) {
			try {
				const events = await eventStore.getRecentEvents(5);
				recentActivity = events.map(
					(e) => `${e.data.actor || e.armId || "brain"} ${e.type}`,
				);
			} catch {
				// Fall back to empty if JetStream query fails
			}
		}
		const systemPrompt = await this.templates.loadMailProcessorSystemPrompt({
			availableArms: armContexts,
			pendingTasks: this.state.pendingTasks,
			recentActivity,
		});
		for (const message of messages) {
			this.log(`Processing: ${message.subject}`);

			// Use LLM to determine intent
			const intent = await this.mailProcessor.processMessage(
				message.subject,
				message.body,
				systemPrompt,
			);

			this.log(`Intent: ${intent.type} (${intent.reasoning})`);

			// Handle the intent
			switch (intent.type) {
				case "new_task": {
					const task = await this.createTask(
						intent.subject || message.subject,
						intent.body || message.body,
						message.id,
						intent.priority,
						intent.domain,
					);
					// Send confirmation reply
					await this.sendToHuman({
						subject: `Re: ${message.subject}`,
						body: `I've received your message and created a new task.\n\n**Task:** ${task.subject}\n**Priority:** ${task.priority}\n**Status:** ${task.status}\n\nI'll assign this to an appropriate arm and keep you updated on progress.`,
						headers: {
							"In-Reply-To": message.id,
						},
					});
					break;
				}

				case "doc_update": {
					const docTask = await this.createDocUpdateTask(
						intent.subject || message.subject,
						intent.body || message.body,
						intent.targetDoc,
						message.id,
					);
					// Send confirmation reply
					await this.sendToHuman({
						subject: `Re: ${message.subject}`,
						body: `I've received your documentation update request.\n\n**Target:** ${intent.targetDoc || "documentation"}\n**Task:** ${docTask.subject}\n**Priority:** ${docTask.priority}\n\nI'll have an arm update the documentation and notify you when complete.`,
						headers: {
							"In-Reply-To": message.id,
						},
					});
					break;
				}

				case "bug_report":
					// Note: createHumanBugReport already sends a confirmation email
					await this.createHumanBugReport(
						intent.title || message.subject,
						intent.description || message.body,
						message.id,
					);
					break;

				case "approval_response": {
					await this.handleApprovalResponse(
						intent.originalId || "",
						intent.approved || false,
						intent.comment || message.body,
					);
					// Send confirmation reply
					await this.sendToHuman({
						subject: `Re: ${message.subject}`,
						body: `I've received your ${intent.approved ? "approval" : "rejection"}${intent.comment ? " with comment" : ""}.\n\nThe appropriate arm has been notified and will proceed accordingly.`,
						headers: {
							"In-Reply-To": message.id,
						},
					});
					break;
				}

				case "query":
					await this.handleQuery(intent.query || "status", message.id);
					break;

				case "prompt_arm": {
					if (intent.armName && intent.instruction) {
						// Check if arm exists and its status
						const targetArm = this.arms.get(intent.armName);
						if (!targetArm) {
							this.log(
								`Arm ${intent.armName} not found, creating task instead`,
							);
							await this.createTask(
								`Task for ${intent.armName}: ${message.subject}`,
								intent.instruction,
								message.id,
								intent.priority,
							);
						} else if (
							targetArm.status === "busy" ||
							targetArm.status === "running" ||
							targetArm.status === "starting"
						) {
							// Arm is busy - create a task instead of interrupting
							this.log(
								`Arm ${intent.armName} is ${targetArm.status}, creating task instead of interrupting`,
							);
							await this.createTask(
								message.subject,
								intent.instruction,
								message.id,
								intent.priority,
							);
							const body = await this.templates.renderTemplate(
								"human-task-queued-busy.jinja",
								{
									arm_name: intent.armName,
									arm_status: targetArm.status,
									subject: message.subject,
								},
							);
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
							// Send confirmation reply
							await this.sendToHuman({
								subject: `Re: ${message.subject}`,
								body: `I've received your request and prompted **${intent.armName}** directly.\n\nThe arm is working on:\n\n${intent.instruction.slice(0, 200)}${intent.instruction.length > 200 ? "..." : ""}\n\nYou'll receive updates as the arm progresses.`,
								headers: {
									"In-Reply-To": message.id,
								},
							});
						}
					}
					break;
				}

				case "escalate": {
					this.log(`Escalating message to human: ${message.subject}`);
					const body = await this.templates.renderTemplate(
						"human-mail-escalate.jinja",
						{
							subject: message.subject,
							body: message.body,
						},
					);
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
		domain?: string,
	): Promise<Task> {
		const requestedId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const task =
			(await this.createTaskViaApi({
				id: requestedId,
				subject,
				description,
				status: "pending",
				priority: priority || "normal",
				domain,
				mailThreadId,
				sourceType: "email",
			})) ||
			({
				id: requestedId,
				subject,
				description,
				status: "pending",
				priority: priority || "normal",
				domain,
				createdAt: new Date(),
				updatedAt: new Date(),
				mailThreadId,
			} as Task);

		this.log(
			`Created task: ${task.subject} (${task.id}) domain=${domain || "any"} priority=${task.priority}`,
		);
		this.logActivity("brain", "task_created", task.id, {
			subject,
			priority: task.priority,
			domain,
			mailThreadId,
		});

		return task;
	}

	/**
	 * Process messages from arms (API queue with file fallback)
	 */
	private async processArmQueue(): Promise<void> {
		// Process messages from API queue (primary)
		try {
			const messages = await this.listPendingMessagesViaApi("brain", 500);
			for (const message of messages) {
				try {
					await this.markMessageStatusViaApi(message.id, "processing");

					await this.handleArmMessage({
						id: message.id,
						from: message.from,
						to: message.to,
						type: message.type as MessageType,
						payload: message.payload,
						timestamp: new Date(message.createdAt),
					});

					await this.markMessageStatusViaApi(message.id, "completed");
				} catch (err) {
					this.log(`Error processing queue message ${message.id}: ${err}`);
					try {
						await this.markMessageStatusViaApi(
							message.id,
							"failed",
							String(err),
						);
					} catch (markErr) {
						this.log(
							`Failed to mark queue message ${message.id} as failed: ${markErr}`,
						);
					}
				}
			}

			// Periodically cleanup old messages (once per hour via modulo check)
			if (Date.now() % 3600000 < this.options.pollIntervalMs) {
				await this.cleanupMessagesViaApi(7);
			}
		} catch (err) {
			this.log(`Error listing API queue messages: ${err}`);
		}

		// Also check file queue for legacy/fallback messages
		const queueDir = join(this.options.coleoDir, "queue", "brain", "pending");
		const processedDir = join(
			this.options.coleoDir,
			"queue",
			"brain",
			"processed",
		);

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
				await rename(join(queueDir, file), join(processedDir, file));
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
				const payload = message.payload as {
					taskId: string;
					summary: string;
					artifacts: string[];
				};
				await this.completeTask(
					payload.taskId,
					payload.summary,
					payload.artifacts,
				);
				break;
			}

			case "discovery": {
				const discovery = message.payload as Discovery;
				await this.handleDiscovery(message.from, discovery);
				break;
			}

			case "approval_request": {
				const payload = message.payload as {
					action: string;
					context: string;
					options: string[];
				};
				await this.sendApprovalRequest(message.from, payload);
				break;
			}

			case "share_note": {
				const note = message.payload as {
					title: string;
					content: string;
					tags: string[];
				};
				await this.saveSharedNote(message.from, note);
				break;
			}

			case "tool_discovery": {
				const tool = message.payload as {
					name: string;
					command: string;
					description: string;
				};
				await this.handleToolDiscovery(message.from, tool);
				break;
			}

			case "heartbeat": {
				const payload = message.payload as {
					status?: string;
					currentTask?: string;
					timestamp: string;
				};
				await this.handleHeartbeat(message.from, payload);
				break;
			}

			case "doc_update": {
				const payload = message.payload as {
					path: string;
					reason: string;
					previousContent?: string;
					newContent?: string;
				};
				await this.handleDocUpdate(message.from, payload);
				break;
			}

			case "file_subscription": {
				const payload = message.payload as {
					action: "subscribe" | "unsubscribe";
					pattern: string;
					category?: string;
				};
				await this.handleFileSubscription(message.from, payload);
				break;
			}

			case "file_change": {
				const payload = message.payload as {
					filePath: string;
					changeType: string;
					summary: string;
					impact?: string;
					detectedAt: string;
				};
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
					status:
						| "on_track"
						| "blocked"
						| "issues_found"
						| "needs_review"
						| "completed_with_issues";
					summary: string;
					issues: string[];
					blockers: string[];
					nextSteps?: string;
					filesChanged: string[];
					testsStatus?: "passing" | "failing" | "not_run";
					screenshot_path?: string;
				};
				await this.handleStatusReport({
					...payload,
					screenshotPath: payload.screenshot_path,
				});
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

			case "bug_claim": {
				// Arm is claiming a bug
				const payload = message.payload as { action: string; bugId: string };
				if (payload.action === "claim") {
					await this.claimBugForArm(message.from, payload.bugId);
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
				const payload = message.payload as {
					taskId: string;
					status: string;
					message?: string;
					screenshot_path?: string;
				};
				await this.updateTaskStatus(
					message.from,
					payload.taskId,
					payload.status,
					payload.message,
					payload.screenshot_path,
				);
				break;
			}

			case "task_validation": {
				// Validator arm reports validation result
				const payload = message.payload as {
					taskId: string;
					approved: boolean;
					notes: string;
					screenshot_path?: string;
				};
				await this.handleTaskValidation(
					payload.taskId,
					message.from,
					payload.approved,
					payload.notes,
					payload.screenshot_path,
				);
				break;
			}
		}
	}

	/**
	 * Handle dependency discovery from an arm
	 */
	private async handleDependencyDiscovery(
		armId: string,
		payload: {
			taskId: string;
			dependsOn: string;
			type: string;
			description: string;
			severity?: string;
		},
	): Promise<void> {
		this.log(
			`Arm ${armId} discovered dependency: ${payload.dependsOn} (${payload.type}) for task ${payload.taskId}`,
		);

		// Publish to JetStream instead of SQLite
		if (eventStore.isInitialized()) {
			eventStore
				.publishEvent(`coleo.events.arm.${armId}.dependency_discovered`, {
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
				})
				.catch(() => {});
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
		mailThreadId?: string,
	): Promise<Task> {
		const taskId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		let fullDescription = description;
		if (targetDoc) {
			fullDescription = `Update documentation: docs/${targetDoc}\n\n${description}`;
		} else {
			fullDescription = `Update project documentation based on human feedback:\n\n${description}`;
		}

		const task =
			(await this.createTaskViaApi({
				id: taskId,
				subject: `Docs: ${subject}`,
				description: fullDescription,
				status: "pending",
				priority: "high",
				domain: "docs",
				classification: "documentation",
				mailThreadId,
				sourceType: "email",
			})) ||
			({
				id: taskId,
				subject: `Docs: ${subject}`,
				description: fullDescription,
				status: "pending",
				priority: "high",
				domain: "docs",
				classification: "documentation",
				createdAt: new Date(),
				updatedAt: new Date(),
				mailThreadId,
			} as Task);

		this.log(`Created doc update task: ${subject} (${taskId})`);
		this.logActivity("brain", "task_created", taskId, {
			subject,
			priority: task.priority,
			domain: "docs",
			targetDoc,
		});

		return task;
	}

	/**
	 * Create a bug report from human email
	 */
	private async createHumanBugReport(
		title: string,
		description: string,
		mailThreadId?: string,
	): Promise<void> {
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
		this.logActivity("brain", "bug_created", bugPayload.id, {
			title,
			source: "human_reported",
			mailThreadId,
		});

		// Send confirmation to human
		const body = await this.templates.renderTemplate(
			"human-bug-report-confirmation.jinja",
			{
				bug_id: bugPayload.id,
				title,
			},
		);
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
	private async ensureArmExists(armId: string): Promise<void> {
		const existing = await this.apiRequest<{ arm?: { id: string } }>(
			`/api/arms/${encodeURIComponent(armId)}`,
		);
		if (!existing?.arm) {
			await this.apiRequest<{ arm?: { id: string } }>("/api/arms", {
				method: "POST",
				body: JSON.stringify({
					name: armId,
					domain: "general",
					harness: "manual",
				}),
			});
		}

		await this.apiRequest(`/api/arms/${encodeURIComponent(armId)}`, {
			method: "PATCH",
			body: JSON.stringify({
				status: "running",
			}),
		});
	}

	/**
	 * Handle an arm claiming a task
	 * Updates the database to assign the task to the arm
	 */
	private async claimTaskForArm(armId: string, taskId: string): Promise<void> {
		this.log(`Arm ${armId} claiming task ${taskId}`);

		try {
			// Always refresh task cache from API before task operations.
			await this.loadTasks();

			// Ensure the arm exists (prevents assignment failures)
			await this.ensureArmExists(armId);

			const assignmentResponse = await this.apiRequest<{
				result: {
					success: boolean;
					data?: { needsMoreArms?: boolean };
					error?: string;
				};
			}>("/api/brain/internal/assign-task", {
				method: "POST",
				body: JSON.stringify({
					taskId,
					armId,
					role: "primary",
					isClaim: true,
				}),
			});

			if (!assignmentResponse?.result?.success) {
				this.log(
					`Error claiming task ${taskId} for arm ${armId}: ${assignmentResponse?.result?.error || "assignment API unavailable"}`,
				);
				return;
			}

			const task = await this.getTaskFromApi(taskId);
			let taskSubject = task?.subject;
			if (!taskSubject) taskSubject = taskId;
			await this.apiRequest(`/api/arms/${encodeURIComponent(armId)}`, {
				method: "PATCH",
				body: JSON.stringify({ status: "busy" }),
			});
			await this.apiRequest(`/api/arms/${encodeURIComponent(armId)}/metrics`, {
				method: "POST",
				body: JSON.stringify({
					currentTask: { id: taskId, subject: taskSubject },
				}),
			});

			// Update in-memory arm state
			const arm = this.arms.get(armId);
			if (arm) {
				arm.status = "busy";
				arm.currentTask = taskId;
				arm.lastActivity = new Date();
			}

			this.log(`Task ${taskId} claimed by arm ${armId}`);
		} catch (err) {
			this.log(`Error claiming task ${taskId} for arm ${armId}: ${err}`);
		}
	}

	/**
	 * Handle an arm claiming a bug
	 * Updates the database to assign the bug to the arm
	 */
	private async claimBugForArm(armId: string, bugId: string): Promise<void> {
		this.log(`Arm ${armId} claiming bug ${bugId}`);

		try {
			// Ensure the arm exists
			await this.ensureArmExists(armId);

			const bugResponse = await this.apiRequest<{
				bug?: { title?: string };
			}>(`/api/bugs/${encodeURIComponent(bugId)}`);
			const bugTitle = bugResponse?.bug?.title || bugId;

			await this.apiRequest(`/api/bugs/${encodeURIComponent(bugId)}`, {
				method: "PATCH",
				body: JSON.stringify({
					assigneeArmId: armId,
					status: "investigating",
				}),
			});

			await this.apiRequest(`/api/arms/${encodeURIComponent(armId)}/metrics`, {
				method: "POST",
				body: JSON.stringify({
					currentBug: { id: bugId, title: bugTitle },
				}),
			});

			this.log(`Bug ${bugId} claimed by arm ${armId}`);
		} catch (err) {
			this.log(`Error claiming bug ${bugId} for arm ${armId}: ${err}`);
		}
	}

	/**
	 * Handle an arm updating their status on a task (e.g., acknowledging work started)
	 */
	private async updateTaskStatus(
		armId: string,
		taskId: string,
		status: string,
		message?: string,
		screenshotPath?: string,
	): Promise<void> {
		this.log(`Arm ${armId} updating task ${taskId} status to ${status}`);

		try {
			// Always refresh task cache from API before task operations.
			await this.loadTasks();

			// Ensure the arm exists (prevents assignment failures)
			await this.ensureArmExists(armId);

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

			await this.patchTaskViaApi(taskId, {
				status: dbStatus as Task["status"],
				assignedTo: armId,
			});

			const now = new Date().toISOString();
			const armPatch: {
				lastActivityAt: string;
				status?: string;
				currentTaskId?: string;
				currentTaskSubject?: string;
			} = {
				lastActivityAt: now,
			};
			if (dbStatus === "in_progress") {
				armPatch.status = "busy";
				armPatch.currentTaskId = taskId;
				armPatch.currentTaskSubject = taskId;
			}
			await this.patchArmViaApi(armId, armPatch);

			const trackedArm = this.arms.get(armId);
			if (trackedArm) {
				trackedArm.lastActivity = new Date();
				if (dbStatus === "in_progress") {
					trackedArm.status = "busy";
					trackedArm.currentTask = taskId;
				}
			}

			this.logActivity("brain", "task_status_update", taskId, {
				armId,
				status: dbStatus,
				message,
				screenshotPath,
			});
			this.log(`Task ${taskId} status updated to ${dbStatus} by arm ${armId}`);

			const armLabel = this.getArmDisplayName(armId);
			const notes = message?.trim();
			const statusLabel = this.humanizeStatus(status);
			const parts: Array<string | null> = [
				`Status update from ${armLabel}: ${statusLabel}.`,
				dbStatus === "in_progress"
					? `Arm ${armLabel} started working on this task.`
					: null,
				notes ? `Notes:\n${notes}` : null,
			];
			const content = parts
				.filter((part): part is string => Boolean(part))
				.join("\n\n");
			await this.appendTaskComment(taskId, content, { armId, screenshotPath });
		} catch (err) {
			this.log(`Error updating task ${taskId} status: ${err}`);
		}
	}

	/**
	 * Add a task comment when an arm provides status or validation
	 */
	private async appendTaskComment(
		taskId: string,
		content: string,
		options?: {
			armId?: string;
			armName?: string;
			screenshotPath?: string;
			authorType?: "arm" | "brain";
		},
	): Promise<void> {
		const armId = options?.armId || "brain";
		const armName =
			options?.armName ||
			(options?.armId ? this.getArmDisplayName(options.armId) : "Brain");
		const authorType =
			options?.authorType || (options?.armId ? "arm" : "brain");

		// Try to use API first
		const response = await this.apiRequest<{ comment: { id: string } }>(
			`/api/tasks/${taskId}/discussions`,
			{
				method: "POST",
				body: JSON.stringify({
					content,
					authorType,
					authorId: armId,
					authorName: armName,
					client: "mcp" as const,
					screenshotPath: options?.screenshotPath,
				}),
			},
		);

		// If API call succeeded, we're done (the API handles broadcasting)
		if (response) {
			return;
		}

		this.log(
			`Task discussion API unavailable for ${taskId}; comment not persisted`,
		);
	}

	private getArmDisplayName(armId: string): string {
		const arm = this.arms.get(armId);
		if (arm?.name) return arm.name;
		return armId;
	}

	private humanizeStatus(value: string): string {
		return value
			.split("_")
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}

	/**
	 * Fetch a single task from the API server.
	 */
	private mapApiTask(task: {
		id: string;
		subject: string;
		description: string;
		status: string;
		priority: string;
		domain?: string | null;
		classification?: string | null;
		assignedTo?: string | null;
		dependencyBlocked?: boolean;
		sortOrder?: number | null;
		createdAt: string;
		updatedAt: string;
		completedAt?: string | null;
		artifacts?: string[];
		mailThreadId?: string | null;
		context?: {
			discoveries?: Array<{
				id: string;
				kind: string;
				title: string;
				details: string;
				filePath?: string;
				lineNumber?: number;
				severity: string;
			}>;
			notes?: string;
		};
	}): Task {
		return {
			id: task.id,
			subject: task.subject,
			description: task.description,
			status: task.status as Task["status"],
			priority: task.priority as Task["priority"],
			domain: task.domain || undefined,
			classification: task.classification || undefined,
			assignedTo: task.assignedTo || undefined,
			dependencyBlocked: task.dependencyBlocked === true,
			sortOrder: task.sortOrder ?? undefined,
			createdAt: new Date(task.createdAt),
			updatedAt: new Date(task.updatedAt),
			completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
			artifacts: task.artifacts || [],
			mailThreadId: task.mailThreadId || undefined,
			context: task.context || undefined,
		};
	}

	private async listTasksFromApi(options?: {
		status?: string[];
		assignedTo?: string;
		phase?: string;
		limit?: number;
		offset?: number;
	}): Promise<Task[]> {
		const params = new URLSearchParams();
		if (options?.status && options.status.length > 0) {
			params.set("status", options.status.join(","));
		}
		if (options?.assignedTo) {
			params.set("assignedTo", options.assignedTo);
		}
		if (options?.phase) {
			params.set("phase", options.phase);
		}
		params.set("limit", String(options?.limit ?? 500));
		params.set("offset", String(options?.offset ?? 0));

		const response = await this.apiRequest<{
			tasks: Array<{
				id: string;
				subject: string;
				description: string;
				status: string;
				priority: string;
				domain?: string | null;
				classification?: string | null;
				assignedTo?: string | null;
				dependencyBlocked?: boolean;
				sortOrder?: number | null;
				createdAt: string;
				updatedAt: string;
				completedAt?: string | null;
				artifacts?: string[];
				mailThreadId?: string | null;
				context?: {
					discoveries?: Array<{
						id: string;
						kind: string;
						title: string;
						details: string;
						filePath?: string;
						lineNumber?: number;
						severity: string;
					}>;
					notes?: string;
				};
			}>;
			counts?: {
				byStatus?: Record<string, number>;
			};
		}>(`/api/tasks?${params.toString()}`);

		if (!response?.tasks) {
			return [];
		}

		if (response.counts?.byStatus?.pending !== undefined) {
			this.state.pendingTasks = response.counts.byStatus.pending;
		}

		return response.tasks.map((task) => this.mapApiTask(task));
	}

	private async listBugsFromApi(
		limit: number = 200,
		options?: { statuses?: string[] },
	): Promise<
		Array<{
			id: string;
			title: string;
			status: string;
			priority: string;
			blockers: string[];
			resolution?: string;
			resolvedAt?: string;
			humanNotified: boolean;
		}>
	> {
		const statuses = options?.statuses;
		const bugs: Array<{
			id: string;
			title: string;
			status: string;
			priority: string;
			blockers: string[];
			resolution?: string;
			resolvedAt?: string;
			humanNotified: boolean;
		}> = [];
		const seen = new Set<string>();

		if (statuses && statuses.length > 0) {
			for (const status of statuses) {
				const response = await this.apiRequest<{
					bugs: Array<{
						id: string;
						title: string;
						status: string;
						priority: string;
						blockers?: string[];
						resolution?: string;
						resolvedAt?: string;
						humanNotified?: boolean;
					}>;
				}>(
					`/api/bugs?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(String(limit))}`,
				);
				for (const bug of response?.bugs || []) {
					if (seen.has(bug.id)) continue;
					seen.add(bug.id);
					bugs.push({
						id: bug.id,
						title: bug.title,
						status: bug.status,
						priority: bug.priority,
						blockers: bug.blockers || [],
						resolution: bug.resolution,
						resolvedAt: bug.resolvedAt,
						humanNotified: bug.humanNotified === true,
					});
				}
			}
			return bugs;
		}

		const response = await this.apiRequest<{
			bugs: Array<{
				id: string;
				title: string;
				status: string;
				priority: string;
				blockers?: string[];
				resolution?: string;
				resolvedAt?: string;
				humanNotified?: boolean;
			}>;
		}>(`/api/bugs?limit=${encodeURIComponent(String(limit))}`);

		return (response?.bugs || [])
			.filter((bug) => bug.status !== "resolved" && bug.status !== "closed")
			.map((bug) => ({
				id: bug.id,
				title: bug.title,
				status: bug.status,
				priority: bug.priority,
				blockers: bug.blockers || [],
				resolution: bug.resolution,
				resolvedAt: bug.resolvedAt,
				humanNotified: bug.humanNotified === true,
			}));
	}

	private async createTaskViaApi(input: {
		id?: string;
		subject: string;
		description: string;
		status?: Task["status"];
		priority?: Task["priority"];
		domain?: string;
		classification?: string;
		phase?: string;
		mailThreadId?: string;
		context?: Task["context"];
		metadata?: Record<string, unknown>;
		sortOrder?: number;
		sourceType?:
			| "manual"
			| "plan"
			| "email"
			| "discovery"
			| "proposal"
			| "system";
		sourceRef?: string;
	}): Promise<Task | null> {
		// DB currently rejects source_type="system" via CHECK constraint.
		// Normalize to a supported source type to avoid task creation failures.
		const normalizedInput =
			input.sourceType === "system"
				? { ...input, sourceType: "manual" as const }
				: input;

		const response = await this.apiRequest<{
			task: {
				id: string;
				subject: string;
				description: string;
				status: string;
				priority: string;
				domain?: string | null;
				classification?: string | null;
				assignedTo?: string | null;
				dependencyBlocked?: boolean;
				sortOrder?: number | null;
				createdAt: string;
				updatedAt: string;
				completedAt?: string | null;
				artifacts?: string[];
				mailThreadId?: string | null;
				context?: Task["context"];
			};
		}>("/api/tasks", {
			method: "POST",
			body: JSON.stringify(normalizedInput),
		});

		if (!response?.task) {
			return null;
		}

		return this.mapApiTask(response.task);
	}

	private async patchTaskViaApi(
		taskId: string,
		patch: {
			status?: Task["status"];
			assignedTo?: string | null;
			dependencyBlocked?: boolean;
			metadata?: Record<string, unknown>;
			artifacts?: string[];
			context?: Task["context"];
		},
	): Promise<Task | null> {
		const response = await this.apiRequest<{
			task: {
				id: string;
				subject: string;
				description: string;
				status: string;
				priority: string;
				domain?: string | null;
				classification?: string | null;
				assignedTo?: string | null;
				dependencyBlocked?: boolean;
				sortOrder?: number | null;
				createdAt: string;
				updatedAt: string;
				completedAt?: string | null;
				artifacts?: string[];
				mailThreadId?: string | null;
				context?: Task["context"];
			};
		}>(`/api/tasks/${encodeURIComponent(taskId)}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		});

		if (!response?.task) {
			return null;
		}

		return this.mapApiTask(response.task);
	}

	private async getTaskFromApi(taskId: string): Promise<Task | null> {
		const response = await this.apiRequest<{
			task: {
				id: string;
				subject: string;
				description: string;
				status: string;
				priority: string;
				domain?: string | null;
				classification?: string | null;
				assignedTo?: string | null;
				dependencyBlocked?: boolean;
				sortOrder?: number | null;
				createdAt: string;
				updatedAt: string;
				completedAt?: string | null;
				artifacts?: string[];
				mailThreadId?: string | null;
				context?: Task["context"];
			};
		}>(`/api/tasks/${encodeURIComponent(taskId)}`);

		if (!response?.task) {
			return null;
		}

		return this.mapApiTask(response.task);
	}

	private async getTaskDependenciesFromApi(taskId: string): Promise<string[]> {
		const response = await this.apiRequest<{
			task: {
				id: string;
			};
			dependencies?: string[];
		}>(`/api/tasks/${encodeURIComponent(taskId)}`);
		return response?.dependencies || [];
	}

	private async listStatusReportsFromApi(options?: {
		taskId?: string;
		armId?: string;
		limit?: number;
	}): Promise<
		Array<{
			id: string;
			taskId: string;
			armId: string;
			status:
				| "on_track"
				| "blocked"
				| "issues_found"
				| "needs_review"
				| "completed_with_issues";
			summary: string;
			issues?: string[];
			blockers?: string[];
			nextSteps?: string;
			filesChanged?: string[];
			testsStatus?: "passing" | "failing" | "not_run";
			createdAt: string;
		}>
	> {
		const limit = Math.max(1, options?.limit ?? 100);
		const pageSize = 100;
		const reports: Array<{
			id: string;
			taskId: string;
			armId: string;
			status:
				| "on_track"
				| "blocked"
				| "issues_found"
				| "needs_review"
				| "completed_with_issues";
			summary: string;
			issues?: string[];
			blockers?: string[];
			nextSteps?: string;
			filesChanged?: string[];
			testsStatus?: "passing" | "failing" | "not_run";
			createdAt: string;
		}> = [];

		let offset = 0;
		while (reports.length < limit) {
			const currentPageSize = Math.min(pageSize, limit - reports.length);
			const params = new URLSearchParams({
				limit: String(currentPageSize),
				offset: String(offset),
			});
			if (options?.taskId) params.set("taskId", options.taskId);
			if (options?.armId) params.set("armId", options.armId);

			const response = await this.apiRequest<{
				reports: Array<{
					id: string;
					taskId: string;
					armId: string;
					status:
						| "on_track"
						| "blocked"
						| "issues_found"
						| "needs_review"
						| "completed_with_issues";
					summary: string;
					issues?: string[];
					blockers?: string[];
					nextSteps?: string;
					filesChanged?: string[];
					testsStatus?: "passing" | "failing" | "not_run";
					createdAt: string;
				}>;
				pagination?: {
					total: number;
				};
			}>(`/api/status-reports?${params.toString()}`);

			const batch = response?.reports || [];
			reports.push(...batch);

			if (batch.length < currentPageSize) {
				break;
			}
			const total = response?.pagination?.total;
			offset += batch.length;
			if (typeof total === "number" && offset >= total) {
				break;
			}
		}

		return reports;
	}

	private async getTaskDiscussionText(taskId: string): Promise<string> {
		const response = await this.apiRequest<{
			discussions?: Array<{
				content?: string;
			}>;
		}>(
			`/api/tasks/${encodeURIComponent(taskId)}/discussions?limit=100&offset=0`,
		);
		if (!response?.discussions || response.discussions.length === 0) {
			return "";
		}
		return response.discussions
			.map((comment) =>
				typeof comment.content === "string" ? comment.content : "",
			)
			.filter((content) => content.length > 0)
			.join(" ");
	}

	private async moveTaskToTop(taskId: string): Promise<boolean> {
		const response = await this.apiRequest<{ success?: boolean }>(
			"/api/tasks/reorder",
			{
				method: "POST",
				body: JSON.stringify({
					taskId,
					toSortOrder: 0,
				}),
			},
		);

		return response?.success === true;
	}

	/**
	 * Initiate peer validation for a task completion
	 * Validation is pull-based: finalize the task and queue a follow-up validation task
	 */
	private async initiateTaskValidation(
		taskId: string,
		summary: string,
		artifacts: string[],
		taskContext?: Task,
	): Promise<void> {
		this.log(`Finalizing task ${taskId} and queuing validation follow-up...`);

		const task = taskContext || (await this.getTaskFromApi(taskId));
		if (!task) {
			this.log(`[initiateTaskValidation] Task ${taskId} not found`);
			return;
		}

		await this.finalizeTaskCompletion(taskId, summary, artifacts);

		const validationDescription = [
			`Validate completion for task "${task.subject}" (${task.id}).`,
			"",
			"Review the implementation and artifacts to confirm acceptance criteria.",
			"If issues are found, create a follow-up bug/task with concrete repro steps.",
			"",
			"Completion summary:",
			summary || "(no summary provided)",
			"",
			"Artifacts:",
			artifacts.length > 0
				? artifacts.map((a) => `- ${a}`).join("\n")
				: "- None",
		].join("\n");

		const validationTask = await this.createTaskViaApi({
			subject: `Validate completion: ${task.subject}`,
			description: validationDescription,
			status: "pending",
			priority: task.priority === "critical" ? "critical" : "high",
			classification: "qa",
			domain: task.domain,
			sourceType: "system",
			sourceRef: task.id,
			context: {
				notes: `Validation follow-up queued after completion of ${task.id}.`,
			},
		});

		if (validationTask) {
			const moved = await this.moveTaskToTop(validationTask.id);
			this.logActivity("brain", "validation_task_queued", validationTask.id, {
				originalTaskId: task.id,
				movedToTop: moved,
			});
		}
	}

	/**
	 * Handle task validation result from validator arm
	 */
	private async handleTaskValidation(
		taskId: string,
		validatorArmId: string,
		approved: boolean,
		notes: string,
		screenshotPath?: string,
	): Promise<void> {
		this.log(
			`Task ${taskId} validation result from ${validatorArmId}: ${approved}`,
		);

		const task = await this.getTaskFromApi(taskId);
		const taskSubject = task?.subject || taskId;

		if (approved) {
			// validation succeeded - mark task as completed
			await this.finalizeTaskCompletion(taskId, notes, []);

			this.logActivity("brain", "task_validation_approved", taskId, {
				validatorArmId,
			});

			// Add comment about approval
			const armLabel = this.getArmDisplayName(validatorArmId);
			const parts: Array<string | null> = [
				`Task validated and approved by ${armLabel}`,
				notes ? `Notes:\n${notes}` : null,
			];
			const content = parts
				.filter((part): part is string => Boolean(part))
				.join("\n\n");
			await this.appendTaskComment(taskId, content, {
				armId: validatorArmId,
				screenshotPath,
			});

			this.log(`Task ${taskSubject} approved and completed`);
		} else {
			// validation failed - return task to in_progress with feedback
			// Get the original worker arm to reassign
			const originalWorker = await this.getTaskFromApi(taskId);
			const originalWorkerId = originalWorker?.assignedTo || null;

			if (originalWorkerId) {
				await this.patchTaskViaApi(taskId, {
					status: "in_progress",
				});

				// Add comment about rejection
				const armLabel = this.getArmDisplayName(validatorArmId);
				const parts: Array<string | null> = [
					`Validation rejected by ${armLabel}`,
					notes ? `Feedback:\n${notes}` : null,
				];
				const content = parts
					.filter((part): part is string => Boolean(part))
					.join("\n\n");
				await this.appendTaskComment(taskId, content, {
					armId: validatorArmId,
					screenshotPath,
				});

				// Notify original worker arm to address issues
				const feedbackPrompt = `# Task Validation Feedback

**Task ID**: ${taskId}
**Subject**: ${taskSubject}

## Validation Result: REJECTED

**Validator**: ${validatorArmId}

**Feedback**:
${notes}

${screenshotPath ? `**Screenshot**: ${screenshotPath}` : ""}

## Next Steps

Please address the issues mentioned in the feedback and resubmit for validation.

When you have fixed the issues, call \`complete_task\` again with an updated summary.`;

				await this.sendPromptToArm(originalWorkerId, feedbackPrompt);

				this.log(
					`Task ${taskSubject} returned to in_progress for ${originalWorkerId} to address feedback`,
				);
			}
		}
	}

	/**
	 * Finalize task completion (called after validation or if validation skipped)
	 */
	private async finalizeTaskCompletion(
		taskId: string,
		summary: string,
		artifacts: string[],
	): Promise<void> {
		const task = await this.getTaskFromApi(taskId);
		const workerArmId = task?.assignedTo;

		// Find the arm that was working on this task and transition its state
		if (workerArmId && this.armStateMachine) {
			await this.armStateMachine.transition(workerArmId, {
				type: "TASK_COMPLETED",
				taskId,
			});

			// Also update the legacy in-memory arm status
			const arm = this.arms.get(workerArmId);
			if (arm) {
				arm.status = "idle";
				arm.currentTask = undefined;
			}
		}

		await this.patchTaskViaApi(taskId, {
			status: "completed",
			artifacts,
			assignedTo: null,
			dependencyBlocked: false,
		});
		if (workerArmId) {
			await this.apiRequest(`/api/arms/${encodeURIComponent(workerArmId)}`, {
				method: "PATCH",
				body: JSON.stringify({ status: "idle" }),
			});
			await this.apiRequest(
				`/api/arms/${encodeURIComponent(workerArmId)}/metrics`,
				{
					method: "POST",
					body: JSON.stringify({ currentTask: null }),
				},
			);
		}

		this.state.completedToday++;
		this.state.completedTaskCount++;

		const taskSubject =
			task?.subject || (await this.getTaskSubjectFromApi(taskId));

		// Log activity
		this.logActivity("brain", "task_completed", taskId, {
			subject: taskSubject,
			artifacts,
		});

		// Mirror task completion into task + arm event streams for activity analysis
		if (eventStore.isInitialized()) {
			const now = new Date().toISOString();
			const data = { actor: "brain", taskId, subject: taskSubject, artifacts };

			eventStore
				.publishEvent(`coleo.events.task.${taskId}.task.completed`, {
					type: "task.completed",
					armId: workerArmId,
					data,
					timestamp: now,
				})
				.catch(() => {
					// Best-effort
				});

			if (workerArmId) {
				eventStore
					.publishEvent(`coleo.events.arm.${workerArmId}.task.completed`, {
						type: "task.completed",
						armId: workerArmId,
						data,
						timestamp: now,
					})
					.catch(() => {
						// Best-effort
					});
			}
		}

		this.completedTaskCount = this.state.completedTaskCount;
		if (this.completedTaskCount % 5 === 0) {
			const largeFiles = await findLargeFilesUtil({
				rootDir: process.cwd(),
				minLines: this.refactorFileThresholdLines,
				thresholds: { normal: this.refactorFileThresholdLines },
				includeGitStatus: true,
			});
			if (largeFiles.length > 0) {
				await this.createRefactoringTask(largeFiles);
			}
		}

		// Check for tasks that were blocked on this task and unblock them
		await this.unblockDependentTasks(taskId);

		// Notify human
		const body = await this.templates.renderTemplate(
			"human-task-completed.jinja",
			{
				subject: taskSubject,
				summary,
				artifacts_list: artifacts.map((a) => `- ${a}`).join("\n") || "None",
			},
		);
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
	 * Complete a task
	 * Enhanced for progressive planning: checks for status reports with issues
	 * and triggers plan re-evaluation to determine next tasks
	 */
	private async completeTask(
		taskId: string,
		summary: string,
		artifacts: string[],
	): Promise<void> {
		// Always refresh task cache from API before task operations.
		await this.loadTasks();

		const task = await this.getTaskFromApi(taskId);
		if (!task) {
			this.log(
				`[completeTask] Task ${taskId} not found via API, skipping completion`,
			);
			return;
		}

		const isFollowUpTask =
			task.subject?.startsWith("Validate completion:") ||
			task.subject?.startsWith("Verify & Polish:");

		// Follow-up QA tasks are terminal. Do not recursively generate
		// additional verification/validation work from them.
		if (isFollowUpTask) {
			this.log(
				`Skipping recursive follow-up generation for ${taskId} (${task.subject})`,
			);
			await this.finalizeTaskCompletion(taskId, summary, artifacts);
			return;
		}

		// Check for status reports with issues for this task
		const statusReportsWithIssues =
			await this.getStatusReportsWithIssues(taskId);

		if (statusReportsWithIssues.length > 0) {
			// There are issues - create a verification task instead of just completing
			const latestReport = statusReportsWithIssues[0]!; // Most recent report (guaranteed by length check)
			this.log(
				`Task ${taskId} has ${statusReportsWithIssues.length} status reports with issues. Creating verification task.`,
			);

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

		await this.initiateTaskValidation(taskId, summary, artifacts, task);
	}

	/**
	 * Get task subject from API (fallback when not in memory)
	 */
	private async getTaskSubjectFromApi(taskId: string): Promise<string> {
		const task = await this.getTaskFromApi(taskId);
		return task?.subject || taskId;
	}

	/**
	 * Get status reports with issues for a task
	 */
	private async getStatusReportsWithIssues(taskId: string): Promise<
		Array<{
			id: string;
			summary: string;
			issues: string[];
			nextSteps?: string;
			testsStatus?: "passing" | "failing" | "not_run";
		}>
	> {
		const params = new URLSearchParams({
			taskId,
			limit: "100",
			offset: "0",
		});
		const response = await this.apiRequest<{
			reports: Array<{
				id: string;
				status:
					| "on_track"
					| "blocked"
					| "issues_found"
					| "needs_review"
					| "completed_with_issues";
				summary: string;
				issues?: string[];
				nextSteps?: string;
				testsStatus?: "passing" | "failing" | "not_run";
			}>;
		}>(`/api/status-reports?${params.toString()}`);

		if (!response?.reports) {
			return [];
		}

		return response.reports
			.filter((report) =>
				["issues_found", "completed_with_issues", "needs_review"].includes(
					report.status,
				),
			)
			.map((report) => ({
				id: report.id,
				summary: report.summary,
				issues: report.issues || [],
				nextSteps: report.nextSteps || undefined,
				testsStatus: report.testsStatus,
			}));
	}

	/**
	 * Unblock tasks that were waiting on a completed task
	 * Part of progressive planning - re-evaluates which tasks can now proceed
	 */
	private async unblockDependentTasks(completedTaskId: string): Promise<void> {
		try {
			const response = await this.apiRequest<{
				unblocked: Array<{ taskId: string; subject: string }>;
			}>("/api/brain/internal/dependencies/unblock-for-completed", {
				method: "POST",
				body: JSON.stringify({ completedTaskId }),
			});
			for (const row of response?.unblocked || []) {
				this.log(
					`Unblocked task: ${row.subject} (was waiting on ${completedTaskId})`,
				);
				this.logActivity("brain", "task_unblocked", row.taskId, {
					completedDependency: completedTaskId,
					subject: row.subject,
				});
			}
		} catch (err) {
			this.log(`Error unblocking dependent tasks: ${err}`);
		}
	}

	/**
	 * Determine if a status report should be forwarded to the human user
	 *
	 * Decision factors:
	 * 1. Report status type - some always forward, some conditional
	 * 2. Pending backlog - blocked tasks can be deferred while work continues elsewhere
	 * 3. Completion states - if work is done with issues, notify and queue follow-up
	 *
	 * Returns: {
	 *   shouldForward: boolean,
	 *   reason: string,
	 *   action?: 'notify' | 'defer_task'
	 * }
	 */
	private async shouldForwardStatusReportToUser(
		report: {
			taskId: string;
			armId: string;
			status:
				| "on_track"
				| "blocked"
				| "issues_found"
				| "needs_review"
				| "completed_with_issues";
			summary: string;
			blockers?: string[];
		},
		task: Task,
	): Promise<{
		shouldForward: boolean;
		reason: string;
		action?: "notify" | "defer_task";
	}> {
		// on_track - never forward, just progress updates
		if (report.status === "on_track") {
			return {
				shouldForward: false,
				reason: "Progress update - no user action needed",
			};
		}

		// Always forward needs_review - explicit request for human attention
		if (report.status === "needs_review") {
			return {
				shouldForward: true,
				reason: "Arm explicitly requested human review",
				action: "notify",
			};
		}

		// For blocked status, check if:
		// 1. There is other pending work the arm can pull from the queue
		// 2. The user needs immediate notification
		if (report.status === "blocked") {
			// Check if there are other pending tasks this arm could work on instead
			const otherPendingTasks = (
				await this.listTasksFromApi({ status: ["pending"], limit: 500 })
			).filter((pendingTask) => pendingTask.id !== task.id);

			if (otherPendingTasks.length > 0) {
				// There's other work to do - defer this task and notify user
				this.log(
					`Task ${task.subject} blocked - deferring and moving arm to other work`,
				);
				return {
					shouldForward: true,
					reason: `Task blocked and deferred. Arm will pull other pending work. User notified.`,
					action: "defer_task",
				};
			}

			// No alternatives in the queue, must notify user
			return {
				shouldForward: true,
				reason: "Task is blocked and requires human intervention",
				action: "notify",
			};
		}

		return {
			shouldForward: true,
			reason: "Status requires user visibility and follow-up queue management",
			action: "notify",
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
		status:
			| "on_track"
			| "blocked"
			| "issues_found"
			| "needs_review"
			| "completed_with_issues";
		summary: string;
		issues: string[];
		blockers: string[];
		nextSteps?: string;
		filesChanged: string[];
		testsStatus?: "passing" | "failing" | "not_run";
		screenshotPath?: string;
	}): Promise<void> {
		const task = await this.getTaskFromApi(report.taskId);
		if (!task) {
			this.log(`Status report for unknown task: ${report.taskId}`);
			return;
		}

		// Update last activity for the arm
		const now = new Date().toISOString();
		const reportedArmStatus = report.status === "blocked" ? "idle" : "busy";
		await this.patchArmViaApi(report.armId, {
			lastActivityAt: now,
			status: reportedArmStatus,
		});
		const reportingArm = this.arms.get(report.armId);
		if (reportingArm) {
			reportingArm.lastActivity = new Date();
			reportingArm.status = reportedArmStatus;
		}

		const statusReportResponse = await this.apiRequest<{
			report?: { id: string };
		}>("/api/status-reports", {
			method: "POST",
			body: JSON.stringify({
				taskId: report.taskId,
				armId: report.armId,
				status: report.status,
				summary: report.summary,
				issues: report.issues,
				blockers: report.blockers,
				nextSteps: report.nextSteps,
				filesChanged: report.filesChanged,
				testsStatus: report.testsStatus,
			}),
		});
		if (statusReportResponse?.report?.id) {
			this.log(`Stored status report: ${statusReportResponse.report.id}`);
		} else {
			this.log(`Failed to persist status report ${report.id} via API`);
		}

		// Log activity
		this.logActivity("brain", "status_report_received", report.taskId, {
			reportId: report.id,
			armId: report.armId,
			status: report.status,
			issueCount: report.issues.length,
			blockerCount: report.blockers.length,
		});

		const armLabel = this.getArmDisplayName(report.armId);
		const statusLabel = this.humanizeStatus(report.status);
		const trimmedSummary = report.summary?.trim();
		const testsLabel = report.testsStatus
			? this.humanizeStatus(report.testsStatus)
			: null;

		const formatList = (title: string, items: string[]) => {
			if (items.length === 0) return null;
			const preview = items
				.slice(0, 5)
				.map((item) => `- ${item}`)
				.join("\n");
			const more =
				items.length > 5 ? `\n- ...and ${items.length - 5} more` : "";
			return `${title}\n${preview}${more}`;
		};

		const filesSection = formatList("Files changed:", report.filesChanged);
		const issuesSection = formatList("Issues:", report.issues);
		const blockersSection = formatList("Blockers:", report.blockers);
		const nextSteps = report.nextSteps?.trim();

		const statusParts: Array<string | null> = [
			`Status report (${statusLabel}) from ${armLabel}`,
			trimmedSummary || null,
			testsLabel ? `Tests status: ${testsLabel}` : null,
			filesSection,
			issuesSection,
			blockersSection,
			nextSteps ? `Next steps:\n${nextSteps}` : null,
		];

		const statusContent = statusParts
			.filter((part): part is string => Boolean(part))
			.join("\n\n");
		await this.appendTaskComment(report.taskId, statusContent, {
			armId: report.armId,
			screenshotPath: report.screenshotPath,
		});

		// Determine if we should forward this status report to the user
		const forwardDecision = await this.shouldForwardStatusReportToUser(
			report,
			task,
		);
		this.log(
			`Status report forward decision: ${forwardDecision.shouldForward ? "FORWARD" : "HOLD"} - ${forwardDecision.reason}`,
		);

		// Log the decision for transparency
		this.logActivity("brain", "status_report_forward_decision", report.taskId, {
			reportId: report.id,
			shouldForward: forwardDecision.shouldForward,
			reason: forwardDecision.reason,
		});

		// Handle based on status
		switch (report.status) {
			case "blocked": {
				if (forwardDecision.action === "defer_task") {
					// Defer the task and notify user - arm will move to other work
					// Clear the reporting arm so it can pull other work
					await this.clearArmTaskAssignment(report.armId);

					await this.patchTaskViaApi(task.id, {
						status: "blocked",
						dependencyBlocked: false,
					});

					const body = await this.templates.renderTemplate(
						"human-task-deferred.jinja",
						{
							task_subject: task.subject,
							summary: report.summary,
							blockers_list:
								report.blockers.map((b) => `- ${b}`).join("\n") ||
								"No specific blockers listed",
							next_steps: report.nextSteps || "None specified",
						},
					);
					await this.sendToHuman({
						subject: `[coleo] Task deferred: ${task.subject}`,
						body,
						headers: {
							"X-Coleo-Task-Id": report.taskId,
							"X-Coleo-Type": "task-deferred",
						},
					});
					this.log(
						`Task ${task.subject} deferred. Arm ${report.armId} will be assigned to other work.`,
					);
				} else {
					// Standard blocked handling - notify user immediately
					await this.patchTaskViaApi(task.id, {
						status: "blocked",
						dependencyBlocked: false,
					});

					const body = await this.templates.renderTemplate(
						"human-task-blocked.jinja",
						{
							task_subject: task.subject,
							arm_id: report.armId,
							summary: report.summary,
							blockers_list:
								report.blockers.map((b) => `- ${b}`).join("\n") ||
								"No specific blockers listed",
							next_steps: report.nextSteps || "None specified",
						},
					);
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
				this.log(
					`Issues found in task ${task.subject}: ${report.issues.length} issues`,
				);

				// Only notify human if decision says to forward
				if (forwardDecision.shouldForward && report.issues.length > 0) {
					const body = await this.templates.renderTemplate(
						"human-issues-found.jinja",
						{
							arm_id: report.armId,
							task_subject: task.subject,
							issues_list: report.issues.map((i) => `- ${i}`).join("\n"),
							summary: report.summary,
							next_steps: report.nextSteps || "Continuing work...",
							forward_reason: forwardDecision.reason,
						},
					);
					await this.sendToHuman({
						subject: `[coleo] Issues found: ${task.subject}`,
						body,
						headers: {
							"X-Coleo-Task-Id": report.taskId,
							"X-Coleo-Type": "issues-found",
						},
					});
				} else if (!forwardDecision.shouldForward) {
					this.log(
						`Issues found but not forwarding to user: ${forwardDecision.reason}`,
					);
				}
				break;
			}

			case "needs_review": {
				// Task needs human or other arm review - always forward
				this.log(`Task ${task.subject} needs review`);
				const body = await this.templates.renderTemplate(
					"human-review-needed.jinja",
					{
						arm_id: report.armId,
						task_subject: task.subject,
						summary: report.summary,
						files_list:
							report.filesChanged.map((f) => `- ${f}`).join("\n") ||
							"None listed",
						tests_status: report.testsStatus || "Not run",
					},
				);
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
				await this.createVerificationTask(
					task,
					report,
					!forwardDecision.shouldForward,
				);
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
	 * @param skipNotification - If true, don't send notification to human
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
		skipNotification: boolean = false,
	): Promise<Task> {
		const taskId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		const issuesList =
			report.issues.length > 0
				? `## Issues to Address\n${report.issues.map((i) => `- ${i}`).join("\n")}\n\n`
				: "";

		const testInfo =
			report.testsStatus === "failing"
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

		const verifyTask =
			(await this.createTaskViaApi({
				id: taskId,
				subject: `Verify & Polish: ${originalTask.subject}`,
				description,
				status: "pending",
				priority: originalTask.priority === "critical" ? "critical" : "high",
				classification: "qa",
				domain: originalTask.domain,
				sourceType: "system",
				sourceRef: originalTask.id,
				context: {
					notes: `Follow-up verification for ${originalTask.id}. Status report: ${report.id}`,
				},
			})) ||
			({
				id: taskId,
				subject: `Verify & Polish: ${originalTask.subject}`,
				description,
				status: "pending",
				priority: originalTask.priority === "critical" ? "critical" : "high",
				classification: "qa",
				domain: originalTask.domain,
				createdAt: new Date(),
				updatedAt: new Date(),
				context: {
					notes: `Follow-up verification for ${originalTask.id}. Status report: ${report.id}`,
				},
			} as Task);

		// Mark original task as completed (with issues noted)
		await this.patchTaskViaApi(originalTask.id, {
			status: "completed",
			assignedTo: null,
			dependencyBlocked: false,
		});

		this.state.completedToday++;

		this.log(`Created verification task: ${verifyTask.subject} (${taskId})`);
		await this.moveTaskToTop(taskId);
		this.logActivity("brain", "verification_task_created", taskId, {
			originalTaskId: originalTask.id,
			issueCount: report.issues.length,
			testsStatus: report.testsStatus,
			skipNotification,
		});

		// Notify human unless explicitly skipped (e.g., when assigning to another arm)
		if (!skipNotification) {
			const body = await this.templates.renderTemplate(
				"human-verification-needed.jinja",
				{
					task_subject: originalTask.subject,
					issues_list:
						report.issues.map((i) => `- ${i}`).join("\n") ||
						"No specific issues listed",
					summary: report.summary,
				},
			);
			await this.sendToHuman({
				subject: `[coleo] Verification needed: ${originalTask.subject}`,
				body,
				headers: {
					"X-Coleo-Task-Id": taskId,
					"X-Coleo-Type": "verification-task-created",
				},
			});
		} else {
			this.log(`Skipping human notification for verification task ${taskId}`);
		}

		return verifyTask;
	}

	/**
	 * Handle a discovery from an arm
	 */
	private async handleDiscovery(
		armId: string,
		discovery: Discovery,
	): Promise<void> {
		const discoveryId = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		await this.apiRequest("/api/discoveries", {
			method: "POST",
			body: JSON.stringify({
				id: discoveryId,
				armId,
				armName: armId,
				kind: discovery.kind,
				title: discovery.title,
				details: discovery.details,
				filePath: discovery.file || null,
				lineNumber: discovery.line || null,
				severity: discovery.severity || "info",
				status: "open",
			}),
		});
		this.log(`Stored discovery: ${discovery.title} (${discovery.kind})`);

		// Also notify human for high-severity discoveries
		if (discovery.severity === "error" || discovery.severity === "warning") {
			const body = await this.templates.renderTemplate(
				"human-discovery.jinja",
				{
					arm_id: armId,
					kind: discovery.kind,
					severity: discovery.severity || "info",
					details: discovery.details,
					file_info: discovery.file
						? `**File:** ${discovery.file}${discovery.line ? `:${discovery.line}` : ""}`
						: "",
				},
			);
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
	async getDiscoveriesForArm(
		armId: string,
		domain: string,
		options?: {
			limit?: number;
			severity?: string[];
			status?: string[];
			filePattern?: string;
		},
	): Promise<
		Array<{
			id: string;
			kind: string;
			title: string;
			details: string;
			filePath?: string;
			lineNumber?: number;
			severity: string;
			createdAt: string;
		}>
	> {
		const limit = options?.limit || 20;
		try {
			const response = await this.apiRequest<{
				discoveries: Array<{
					id: string;
					kind: string;
					title: string;
					details: string;
					filePath: string | null;
					lineNumber: number | null;
					severity: string;
					status: string;
					createdAt: string;
				}>;
			}>(
				`/api/discoveries?status=open&limit=${limit}${options?.severity?.[0] ? `&severity=${encodeURIComponent(options.severity[0])}` : ""}`,
			);
			const discoveries = response?.discoveries || [];
			const filtered = discoveries.filter((d) => {
				if (options?.severity && options.severity.length > 0) {
					if (!options.severity.includes(d.severity)) return false;
				}
				if (options?.filePattern) {
					if (!d.filePath) return false;
					return d.filePath.includes(options.filePattern);
				}
				return true;
			});

			return filtered.map((row) => ({
				id: row.id,
				kind: row.kind,
				title: row.title,
				details: row.details,
				filePath: row.filePath || undefined,
				lineNumber: row.lineNumber || undefined,
				severity: row.severity,
				createdAt: row.createdAt,
			}));
		} catch (err) {
			this.log(`Error querying discoveries: ${err}`);
			return [];
		}
	}

	/**
	 * Search discoveries using full-text search
	 */
	async searchDiscoveries(
		query: string,
		options?: {
			limit?: number;
			severity?: string[];
		},
	): Promise<
		Array<{
			id: string;
			kind: string;
			title: string;
			details: string;
			severity: string;
			createdAt: string;
		}>
	> {
		const limit = options?.limit || 20;

		try {
			const response = await this.apiRequest<{
				discoveries: Array<{
					id: string;
					kind: string;
					title: string;
					details: string;
					severity: string;
					createdAt: string;
				}>;
			}>(
				`/api/discoveries/search?q=${encodeURIComponent(query)}&limit=${limit}${options?.severity?.[0] ? `&severity=${encodeURIComponent(options.severity[0])}` : ""}`,
			);

			return (response?.discoveries || [])
				.filter((row) =>
					options?.severity?.length
						? options.severity.includes(row.severity)
						: true,
				)
				.map((row) => ({
					id: row.id,
					kind: row.kind,
					title: row.title,
					details: row.details,
					severity: row.severity,
					createdAt: row.createdAt,
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
		const discoveries = await this.getDiscoveriesForArm(armId, domain, {
			limit: 10,
		});

		if (discoveries.length === 0) {
			return "No prior discoveries recorded.";
		}

		const lines = [`## Prior Discoveries (${discoveries.length} open)`];

		for (const d of discoveries) {
			lines.push(`- **[${d.severity.toUpperCase()}] ${d.title}**`);
			lines.push(`  - Kind: ${d.kind}`);
			if (d.filePath) {
				lines.push(
					`  - File: ${d.filePath}${d.lineNumber ? `:${d.lineNumber}` : ""}`,
				);
			}
			lines.push(
				`  - ${d.details.slice(0, 200)}${d.details.length > 200 ? "..." : ""}`,
			);
		}

		return lines.join("\n");
	}

	/**
	 * Send an approval request to the human
	 */
	private async sendApprovalRequest(
		armId: string,
		request: { action: string; context: string; options: string[] },
	): Promise<void> {
		const requestId = `approval-${Date.now()}`;

		const body = await this.templates.renderTemplate(
			"human-approval-request.jinja",
			{
				arm_id: armId,
				action: request.action,
				context: request.context,
				options: request.options.join(" | "),
			},
		);
		await this.sendToHuman({
			subject: `[coleo] [${requestId}] Approval needed: ${request.action}`,
			body,
			headers: {
				"X-Coleo-Type": "approval-request",
				"X-Coleo-From": armId,
				"X-Coleo-Request-Id": requestId,
				Priority: "high",
			},
		});
	}

	/**
	 * Handle approval response from human
	 */
	private async handleApprovalResponse(
		originalId: string,
		approved: boolean,
		comment: string,
	): Promise<void> {
		// TODO: Find pending approval and notify the arm
		this.log(
			`Approval response for ${originalId}: ${approved ? "approved" : "rejected"}`,
		);
	}

	/**
	 * Handle a status query from human
	 */
	private async handleQuery(query: string, replyToId: string): Promise<void> {
		if (query === "status") {
			const taskSnapshot = await this.listTasksFromApi({
				status: ["pending", "in_progress"],
				limit: 500,
			});
			const pendingTasks = taskSnapshot.filter((t) => t.status === "pending");
			const inProgress = taskSnapshot.filter((t) => t.status === "in_progress");
			const completedToday = this.state.completedToday;

			const body = await this.templates.renderTemplate(
				"human-status-report.jinja",
				{
					arms_active: this.arms.size,
					pending_count: pendingTasks.length,
					in_progress_count: inProgress.length,
					completed_today: completedToday,
					pending_list:
						pendingTasks.map((t) => `- ${t.subject}`).join("\n") || "None",
					in_progress_list:
						inProgress
							.map((t) => `- ${t.subject} (${t.assignedTo})`)
							.join("\n") || "None",
				},
			);
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
		note: { title: string; content: string; tags: string[] },
	): Promise<void> {
		const noteId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		// Persist note via API
		await this.apiRequest<{ created?: boolean }>(
			"/api/brain/internal/notes",
			{
				method: "POST",
				body: JSON.stringify({
					id: noteId,
					author,
					title: note.title,
					content: note.content,
					category: "shared",
					tags: note.tags,
				}),
			},
		);

		this.log(`Saved shared note: ${note.title} from ${author}`);
	}

	/**
	 * Handle a tool discovery and persist it through the API server.
	 */
	private async handleToolDiscovery(
		armId: string,
		tool: { name: string; command: string; description: string },
	): Promise<void> {
		// Persist tool via API
		await this.apiRequest<{ upserted?: boolean }>(
			"/api/brain/internal/tools/upsert",
			{
				method: "POST",
				body: JSON.stringify({
					name: tool.name,
					command: tool.command,
					description: tool.description,
					discoveredBy: armId,
				}),
			},
		);

		// Notify human
		const body = await this.templates.renderTemplate(
			"human-tool-discovered.jinja",
			{
				arm_id: armId,
				tool_name: tool.name,
				command: tool.command,
				description: tool.description,
			},
		);
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
		payload: { status?: string; currentTask?: string; timestamp: string },
	): Promise<void> {
		const now = new Date().toISOString();
		const status =
			payload.status === "busy" || payload.currentTask ? "busy" : "idle";
		await this.patchArmViaApi(armId, {
			status,
			lastHeartbeat: now,
			lastActivityAt: now,
			currentTaskId: status === "idle" ? null : undefined,
			currentTaskSubject:
				status === "idle" ? null : (payload.currentTask ?? undefined),
		});

		if (status === "idle") {
			await this.apiRequest(`/api/arms/${encodeURIComponent(armId)}/metrics`, {
				method: "POST",
				body: JSON.stringify({ currentTask: null }),
			});
		} else if (payload.currentTask) {
			await this.apiRequest(`/api/arms/${encodeURIComponent(armId)}/metrics`, {
				method: "POST",
				body: JSON.stringify({
					currentTask: {
						id: payload.currentTask,
						subject: payload.currentTask,
					},
				}),
			});
		}

		// Update state machine with heartbeat event
		if (this.armStateMachine) {
			await this.armStateMachine.transition(armId, { type: "HEARTBEAT" });
		}

		// Update in-memory state too
		const arm = this.arms.get(armId);
		if (arm) {
			arm.lastActivity = new Date();
			if (status === "busy") {
				arm.status = "busy";
				// Only overwrite currentTask if payload references a known task ID
				if (payload.currentTask) {
					const knownTask = this.tasks.find(
						(t) => t.id === payload.currentTask,
					);
					if (knownTask) {
						arm.currentTask = payload.currentTask;
					}
				}
			} else {
				arm.status = "idle";
				arm.currentTask = undefined;
			}
		}

		this.log(`Heartbeat from ${armId}: ${payload.status || "alive"}`);
	}

	/**
	 * Handle documentation update from an arm
	 */
	private async handleDocUpdate(
		armId: string,
		payload: {
			path: string;
			reason: string;
			previousContent?: string;
			newContent?: string;
		},
	): Promise<void> {
		this.log(`Documentation updated by ${armId}: ${payload.path}`);

		await this.recordFileChangeViaApi({
			filePath: payload.path,
			changeType: "modified",
			detectedByArmId: armId,
		});

		// Notify human of the update
		const body = await this.templates.renderTemplate(
			"human-doc-updated.jinja",
			{
				arm_id: armId,
				path: payload.path,
				reason: payload.reason,
			},
		);
		await this.sendToHuman({
			subject: `[coleo] Documentation updated: ${payload.path}`,
			body,
			headers: {
				"X-Coleo-Type": "doc-update",
				"X-Coleo-Path": payload.path,
			},
		});

		// Track file changes in-memory; subscribed arms are notified via handleFileChange
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
		},
	): Promise<void> {
		try {
			const now = new Date().toISOString();
			const bugId =
				payload.id ||
				`bug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

			// Determine priority based on source and content
			let priority: "low" | "medium" | "high" | "critical" = "medium";
			if (payload.source === "system_detected") {
				priority = "high"; // System issues are usually high priority
			} else if (
				payload.title.toLowerCase().includes("crash") ||
				payload.title.toLowerCase().includes("fail") ||
				payload.description.toLowerCase().includes("block")
			) {
				priority = "high";
			}
			// Critical priority for system-wide blocking issues
			if (
				payload.source === "system_detected" &&
				(payload.title.toLowerCase().includes("down") ||
					payload.description.toLowerCase().includes("unavailable"))
			) {
				priority = "critical";
			}
			// Low priority for minor issues
			if (
				payload.source === "human_reported" &&
				!payload.title.toLowerCase().includes("crash") &&
				!payload.title.toLowerCase().includes("fail") &&
				!payload.description.toLowerCase().includes("block")
			) {
				priority = "low";
			}

			// Set blockers array if this bug is blocking a task
			const blockersList = payload.sourceTaskId ? [payload.sourceTaskId] : [];

			await this.apiRequest("/api/bugs", {
				method: "POST",
				body: JSON.stringify({
					id: bugId,
					title: payload.title,
					description: payload.description,
					source: payload.source,
					sourceArmId: payload.source === "arm_reported" ? armId : undefined,
					sourceTaskId: payload.sourceTaskId,
					priority,
					errorDetails: payload.errorDetails || null,
					blockers: blockersList,
					metadata: { reportedAt: now },
				}),
			});

			this.log(
				`Bug reported: ${payload.title} (${priority} priority) by ${payload.source}`,
			);

			// Query blocked tasks for notification
			const blockedTasks: Task[] = [];
			for (const blockedTaskId of blockersList) {
				const blockedTask = await this.getTaskFromApi(blockedTaskId);
				if (blockedTask) {
					blockedTasks.push(blockedTask);
				}
			}

			// Notify human for critical/high priority bugs
			if (priority === "critical" || priority === "high") {
				const body = await this.templates.renderTemplate(
					"human-bug-high-priority.jinja",
					{
						priority,
						title: payload.title,
						description: payload.description,
						source: payload.source,
						reported_by: armId,
						blocking_tasks_count: blockedTasks.length,
						blocked_tasks_list:
							blockedTasks.length > 0
								? blockedTasks.map((t) => `- ${t.subject} (${t.id})`).join("\n")
								: "None",
					},
				);
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
				await this.apiRequest(`/api/bugs/${encodeURIComponent(bugId)}`, {
					method: "PATCH",
					body: JSON.stringify({ humanNotified: true }),
				});
			}

			// Handle escalation based on priority and impact
			if (priority === "medium") {
				// For medium priority bugs, evaluate impacted active tasks and log for resolution
				await this.handleMediumPriorityBugEscalation(bugId, payload);
			} else if (priority === "low") {
				// For low priority bugs, continue work but track for later resolution
				this.log(`Low priority bug ${bugId} logged for later resolution`);
			}

			// If bug blocks a task, try to assign an arm to investigate
			if (payload.sourceTaskId) {
				const task = await this.getTaskFromApi(payload.sourceTaskId);
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
		try {
			const oneHourAgo = Date.now() - 60 * 60 * 1000;
			const resolvedBugs = await this.listBugsFromApi(500, {
				statuses: ["resolved", "closed"],
			});
			const recentlyResolvedBugs = resolvedBugs.filter((bug) => {
				if (!bug.resolvedAt) return false;
				if (new Date(bug.resolvedAt).getTime() <= oneHourAgo) return false;
				return bug.blockers.length > 0;
			});

			for (const bug of recentlyResolvedBugs) {
				const blockedTaskIds = bug.blockers;

				for (const taskId of blockedTaskIds) {
					const task = await this.getTaskFromApi(taskId);
					if (task && task.status === "blocked") {
						await this.patchTaskViaApi(taskId, { status: "pending" });

						this.log(
							`Resuming blocked task ${taskId} after bug ${bug.id} resolution`,
						);

						const body = await this.templates.renderTemplate(
							"human-task-resumed.jinja",
							{
								task_id: taskId,
								task_subject: task.subject,
								bug_id: bug.id,
								bug_title: bug.title,
								resolved_at: bug.resolvedAt || new Date().toISOString(),
							},
						);
						await this.sendToHuman({
							subject: `[coleo] Task Resumed: ${task.subject}`,
							body,
							headers: {
								"X-Coleo-Type": "task-resumed",
								"X-Coleo-Task-Id": taskId,
								"X-Coleo-Bug-Id": bug.id,
							},
						});

						this.logActivity("brain", "task_resumed", taskId, {
							reason: "blocking_bug_resolved",
							bugId: bug.id,
						});
					}
				}

				if (
					(bug.priority === "critical" || bug.priority === "high") &&
					!bug.humanNotified
				) {
					const blockedTasks = this.tasks.filter((t) =>
						blockedTaskIds.includes(t.id),
					);
					const body = await this.templates.renderTemplate(
						"human-bug-resolved.jinja",
						{
							bug_id: bug.id,
							title: bug.title,
							priority: bug.priority,
							resolution: bug.resolution || "No details provided",
							status: bug.status,
							blocking_tasks_count: blockedTasks.length,
							blocked_tasks_list:
								blockedTasks.length > 0
									? blockedTasks
											.map((t) => `- ${t.subject} (${t.id})`)
											.join("\n")
									: "None",
						},
					);
					await this.sendToHuman({
						subject: `[coleo] Bug Resolved: ${bug.title}`,
						body,
						headers: {
							"X-Coleo-Type": "bug-resolved",
							"X-Coleo-Bug-Id": bug.id,
						},
					});

					this.log(`Sent bug resolution notification for ${bug.id}`);
					await this.apiRequest(`/api/bugs/${encodeURIComponent(bug.id)}`, {
						method: "PATCH",
						body: JSON.stringify({ humanNotified: true }),
					});
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
		},
	): Promise<void> {
		// For medium priority bugs, inspect affected active tasks and log for resolution
		this.log(
			`Medium priority bug ${bugId} - checking for impacted active tasks`,
		);

		// If this bug came from a specific task, capture impact context for queue-based follow-up
		if (bugPayload.sourceTaskId) {
			const task = this.tasks.find((t) => t.id === bugPayload.sourceTaskId);
			if (task && task.assignedTo && task.status === "in_progress") {
				// Task is in progress, record context for subsequent planning decisions
				const assignedArm = Array.from(this.arms.values()).find(
					(a) => a.id === task.assignedTo,
				);
				if (assignedArm) {
					this.log(`Task ${task.id} may need follow-up due to bug ${bugId}`);
				}
			}
		}

		// Log the escalation for human review
		const body = await this.templates.renderTemplate(
			"human-bug-medium-escalation.jinja",
			{
				title: bugPayload.title,
				description: bugPayload.description,
				source: bugPayload.source,
				bug_id: bugId,
			},
		);
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
		},
	): Promise<void> {
		// Load and render the bug assignment prompt template
		const prompt = await this.templates.loadBugAssignmentPrompt({
			bugId: payload.bugId,
			title: payload.title,
			assignedBy: payload.assignedBy,
			reason: payload.reason,
		});

		// Send notification to the assigned arm via their MCP session
		await this.sendPromptToArm(armId, prompt);

		this.log(
			`Bug ${payload.bugId} assigned to arm ${armId} by ${payload.assignedBy}`,
		);
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
		},
	): Promise<void> {
		const taskId = `bug-investigate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		const description = `Investigate and diagnose the reported bug.

**Bug Details:**
- Title: ${bugPayload.title}
- Description: ${bugPayload.description}
- Source: ${bugPayload.source}
${bugPayload.sourceTaskId ? `- Related Task: ${bugPayload.sourceTaskId}` : ""}

**Investigation Steps:**
1. Reproduce the issue
2. Identify root cause
3. Determine impact on other tasks
4. Propose fix or workaround
5. Update bug status

Report findings using bug resolution workflow.`;

		await this.createTaskViaApi({
			id: taskId,
			subject: `Investigate Bug: ${bugPayload.title}`,
			description,
			status: "pending",
			priority: "high",
			classification: "development",
			sourceType: "discovery",
			sourceRef: bugId,
			context: {
				notes: JSON.stringify({
					bugId,
					investigationRequired: true,
				}),
			},
		});

		this.log(`Created bug investigation task: ${taskId} for bug ${bugId}`);
	}

	/**
	 * Handle file subscription request from an arm
	 */
	private async handleFileSubscription(
		armId: string,
		payload: {
			action: "subscribe" | "unsubscribe";
			pattern: string;
			category?: string;
		},
	): Promise<void> {
		if (payload.action === "subscribe") {
			const existing = this.fileSubscriptions.get(armId) || new Set<string>();
			if (!existing.has(payload.pattern)) {
				existing.add(payload.pattern);
				this.fileSubscriptions.set(armId, existing);
				this.log(`Arm ${armId} subscribed to: ${payload.pattern}`);
			}
		} else {
			const existing = this.fileSubscriptions.get(armId);
			existing?.delete(payload.pattern);
			if (existing && existing.size === 0) {
				this.fileSubscriptions.delete(armId);
			}
			this.log(`Arm ${armId} unsubscribed from: ${payload.pattern}`);
		}
	}

	/**
	 * Handle file change report from an arm
	 */
	private async handleFileChange(
		armId: string,
		payload: {
			filePath: string;
			changeType: string;
			summary: string;
			impact?: string;
			detectedAt: string;
		},
	): Promise<void> {
		this.log(
			`File change detected by ${armId}: ${payload.filePath} (${payload.changeType})`,
		);

		await this.recordFileChangeViaApi({
			filePath: payload.filePath,
			changeType: payload.changeType,
			detectedByArmId: armId,
			changedAt: payload.detectedAt,
		});

		// Notify subscribed arms
		for (const [subArmId, patterns] of this.fileSubscriptions.entries()) {
			if (subArmId === armId) continue;
			const matches = Array.from(patterns).some((pattern) =>
				this.pathMatchesPattern(payload.filePath, pattern),
			);
			if (!matches) continue;

			await this.sendToArm(subArmId, {
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
			this.log(`Notified arm ${subArmId} of file change: ${payload.filePath}`);
		}

		// If requirements or plans changed, re-evaluate pending tasks
		if (
			payload.filePath.includes("requirements") ||
			payload.filePath.includes("plans")
		) {
			this.log(
				`Requirements/plans changed: ${payload.filePath}. Re-evaluating tasks.`,
			);
		}

		// Notify human of significant changes
		if (
			payload.impact === "high" ||
			payload.filePath.includes("requirements")
		) {
			const body = await this.templates.renderTemplate(
				"human-file-change.jinja",
				{
					arm_id: armId,
					file_path: payload.filePath,
					change_type: payload.changeType,
					summary: payload.summary,
					impact_line: payload.impact ? `**Impact:** ${payload.impact}` : "",
				},
			);
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

	private pathMatchesPattern(filePath: string, pattern: string): boolean {
		const normalizedPath = filePath.replaceAll("\\", "/");
		const normalizedPattern = pattern.replaceAll("\\", "/");

		if (normalizedPattern === "**" || normalizedPattern === "*") {
			return true;
		}

		if (!normalizedPattern.includes("*")) {
			return normalizedPath.includes(normalizedPattern);
		}

		const tokenDouble = "__DOUBLE_STAR__";
		const tokenSingle = "__SINGLE_STAR__";
		const escaped = normalizedPattern
			.replaceAll("**", tokenDouble)
			.replaceAll("*", tokenSingle)
			.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
			.replaceAll(tokenDouble, ".*")
			.replaceAll(tokenSingle, "[^/]*");

		const regex = new RegExp(`^${escaped}$`);
		return regex.test(normalizedPath);
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
		const knownArms = (await this.listArmsFromApi(true)).map((arm) => ({
			id: arm.id,
			name: arm.name,
			pid: arm.pid ?? null,
			status: arm.status,
			domain: arm.domain,
			harness: arm.harness,
		}));

		this.log(
			`scanForRunningArms: found ${knownArms.length} known arms via API`,
		);

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
				this.log(
					`  ${arm.name}: marked as stopped (PID ${arm.pid}), checking if alive...`,
				);
			} else {
				this.log(
					`  ${arm.name}: status=${arm.status} (PID ${arm.pid}), checking...`,
				);
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
						this.log(
							`  ${arm.name}: PROCESS ALIVE (PID ${arm.pid}), but API server unavailable - skipping`,
						);
						continue;
					}
				}

				// Process is alive and usable! Add to tracked arms
				this.log(`  ${arm.name}: PROCESS ALIVE (PID ${arm.pid}), detecting...`);

				const now = new Date().toISOString();
				await this.patchArmViaApi(arm.id, {
					status: "idle",
					lastHeartbeat: now,
					lastActivityAt: now,
				});

				// Initialize state machine for this arm
				if (this.armStateMachine) {
					const existingContext = this.armStateMachine.getContext(arm.id);
					if (!existingContext) {
						// New arm to state machine - initialize as idle (already running)
						this.armStateMachine.initializeArm(arm.id, "idle");
						this.log(`  ${arm.name}: initialized state machine as idle`);
					} else if (existingContext.state === "disconnected") {
						// Was disconnected, now reconnected - emit CONNECTION_RESTORED
						await this.armStateMachine.transition(arm.id, {
							type: "CONNECTION_RESTORED",
						});
						this.log(
							`  ${arm.name}: state machine transition from disconnected to ${this.armStateMachine.getContext(arm.id)?.state}`,
						);
					} else if (
						existingContext.state === "stopped" ||
						existingContext.state === "error"
					) {
						// Was stopped/error, now running again - re-initialize as idle
						this.armStateMachine.initializeArm(arm.id, "idle");
						this.log(
							`  ${arm.name}: re-initialized state machine as idle (was ${existingContext.state})`,
						);
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

				this.logActivity("brain", "arm_detected", arm.id, {
					pid: arm.pid,
					reason: "process_scan",
				});
			} catch {
				// Process dead
				if (arm.status !== "stopped") {
					this.log(
						`  ${arm.name}: process dead, transitioning to stopped via state machine`,
					);

					if (this.armStateMachine) {
						// Emit STOP event - this will handle releasing tasks and cleanup via side effects
						await this.armStateMachine.transition(arm.id, {
							type: "STOP",
							reason: "process_dead_on_scan",
						});
					} else {
						await this.patchArmViaApi(arm.id, {
							status: "stopped",
							lastActivityAt: new Date().toISOString(),
						});
					}
				} else {
					this.log(
						`  ${arm.name}: already marked stopped, process confirmed dead`,
					);
				}
			}
		}

		this.log(
			`scanForRunningArms: complete, now tracking ${this.arms.size} arms`,
		);
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
					const stateResult = await this.apiRequest<{
						state: string;
						hasSession: boolean;
					}>(`/api/arms/${armId}/state`);

					if (stateResult) {
						if (
							stateResult.hasSession &&
							stateResult.state !== "stopped" &&
							stateResult.state !== "dead"
						) {
							// Arm is properly connected - check state machine instead of ad-hoc grace period
							const harnessStatus =
								stateResult.state === "processing" ? "busy" : "idle";

							// Use state machine to determine if we should sync status
							if (this.armStateMachine) {
								const smContext = this.armStateMachine.getContext(armId);

								// If state machine says arm is in task_assigned or working state,
								// don't sync to idle - the state machine handles this with proper timeouts
								if (
									smContext &&
									(smContext.state === "task_assigned" ||
										smContext.state === "working")
								) {
									if (harnessStatus === "idle") {
										// Harness reports idle but state machine knows we have a task
										// This is the race condition the state machine is designed to handle
										this.log(
											`Arm ${armId}: harness reports idle but state machine is in "${smContext.state}" - keeping current state (task: "${smContext.currentTaskSubject}")`,
										);
										continue;
									}
								}

								// If harness says processing but state machine is idle, the harness may be
								// working on something without a brain task - leave it alone
								if (
									smContext &&
									smContext.state === "idle" &&
									harnessStatus === "busy"
								) {
									this.log(
										`Arm ${armId}: harness reports busy but state machine is idle - arm may be working on non-brain task`,
									);
									continue;
								}
							}

							if (arm.status !== harnessStatus) {
								this.log(
									`Arm ${armId}: syncing status from "${arm.status}" to "${harnessStatus}" based on harness state`,
								);
								await this.syncArmStatus(armId, harnessStatus);
							} else {
								this.log(
									`Arm ${armId} is running (PID: ${arm.pid}, state: ${stateResult.state})`,
								);
							}
							continue;
						} else if (!stateResult.hasSession) {
							// Process is running but API session was lost (server restart)
							// Emit CONNECTION_LOST to state machine - it will set up reconnect timeout
							this.log(
								`Arm ${armId} process alive but session lost (server restart), emitting CONNECTION_LOST`,
							);

							if (this.armStateMachine) {
								await this.armStateMachine.transition(armId, {
									type: "CONNECTION_LOST",
								});
							}

							// Also prompt the arm to re-register
							const prompt = await this.templates.renderTemplate(
								"arm-api-restart-prompt.jinja",
							);
							await this.sendPromptToArm(arm.name, prompt);
							continue;
						}
					} else {
						// API not available but process is running - keep the arm
						this.log(
							`Arm ${armId} is running (PID: ${arm.pid}, API unavailable)`,
						);
						continue;
					}
				} catch {
					// Process is dead - transition through state machine
					this.log(
						`Arm ${armId} process dead (PID: ${arm.pid}), transitioning to stopped via state machine`,
					);

					if (this.armStateMachine) {
						// Emit STOP event - this will handle releasing tasks and cleanup via side effects
						await this.armStateMachine.transition(armId, {
							type: "STOP",
							reason: "process_dead",
						});
					} else {
						await this.patchArmViaApi(armId, {
							status: "stopped",
							lastActivityAt: new Date().toISOString(),
						});
					}
					this.arms.delete(armId);
					this.idleArmPromptTracker.delete(armId);
				}
			} else {
				// No PID - check via API session
				const stateResult = await this.apiRequest<{
					state: string;
					hasSession: boolean;
				}>(`/api/arms/${armId}/state`);

				if (stateResult && !stateResult.hasSession) {
					this.log(
						`Arm ${armId} has no session and no PID, transitioning to stopped via state machine`,
					);

					if (this.armStateMachine) {
						// Emit STOP event - this will handle releasing tasks and cleanup via side effects
						await this.armStateMachine.transition(armId, {
							type: "STOP",
							reason: "no_session",
						});
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

		// Also check API-known arms not currently in the in-memory map
		const timeoutSeconds = await this.getBrainConfigNumber(
			"arm_heartbeat_timeout_seconds",
			300,
		);

		const cutoffTime = new Date(
			Date.now() - timeoutSeconds * 1000,
		).toISOString();

		const armIds = Array.from(this.arms.keys());
		const allArms = await this.listArmsFromApi(true);
		const staleArms = allArms
			.filter((arm) => !armIds.includes(arm.id))
			.filter((arm) => arm.status !== "stopped" && arm.status !== "starting")
			.map((arm) => ({
				id: arm.id,
				name: arm.name,
				pid: arm.pid ?? null,
				last_heartbeat: arm.lastHeartbeat || null,
				status: arm.status,
				harness: arm.harness,
			}));

		for (const arm of staleArms) {
			// For API harness arms, skip if API server is unavailable
			// They can't communicate without the API server
			if (arm.harness === "opencode-api") {
				const apiAvailable = await this.isApiServerAvailable();
				if (!apiAvailable) {
					this.log(
						`Arm ${arm.id}: API harness, API server unavailable - skipping stale check`,
					);
					continue;
				}
			}

			// Check if process is still running
			if (arm.pid) {
				try {
					process.kill(arm.pid, 0);
					// Process is alive but not in our arms map - may have been spawned externally
					// Keep it but don't add to active arms
					this.log(
						`Arm ${arm.id} has running process (PID: ${arm.pid}) but not tracked, marking as idle`,
					);
					await this.patchArmViaApi(arm.id, {
						status: "idle",
						lastActivityAt: new Date().toISOString(),
					});
					continue;
				} catch {
					// Process dead - mark as stopped
				}
			}

			// Process is dead or no PID - check heartbeat
			if (
				arm.last_heartbeat &&
				new Date(arm.last_heartbeat) > new Date(cutoffTime)
			) {
				// Recently heartbeated, might be a race condition
				continue;
			}

			this.log(
				`Arm ${arm.id} is stale (last heartbeat: ${arm.last_heartbeat || "never"}), marking as stopped`,
			);
			await this.patchArmViaApi(arm.id, {
				status: "stopped",
				lastActivityAt: new Date().toISOString(),
			});
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

			// Verify arm exists via API before proceeding
			const armExists = await this.getArmFromApi(armId);
			if (!armExists) {
				this.log(`Arm ${armId} not found via API, skipping initial prompt`);
				continue;
			}

			// Send the common initial prompt to the arm
			const prompt = await this.templates.loadInitialArmPrompt();
			const success = await this.sendPromptToArm(armId, prompt);

			if (success) {
				this.log(`Sent initial prompt to ${armId}`);
				this.logActivity("brain", "arm_initialized", armId, {
					source: "initial_prompt_sent",
				});
				this.initializedArmIds.add(armId);

				// Create a placeholder task record so hasReceivedInitialTasks persists across restarts.
				await this.createTaskViaApi({
					id: `init-${armId}`,
					subject: `Arm ${armId} initialized`,
					description: "Initial prompt sent to arm",
					status: "completed",
					priority: "normal",
					sourceType: "system",
					sourceRef: "arm-init",
				});
			} else {
				this.log(`Failed to send initial prompt to ${armId}`);
			}
		}
	}

	/**
	 * Check if an arm has already received the initial prompt (derived from database)
	 */
	private async hasReceivedInitialTasks(armId: string): Promise<boolean> {
		if (!this.initializedArmIdsLoaded) {
			const completedTasks = await this.listTasksFromApi({
				status: ["completed"],
				limit: 5000,
			});
			for (const task of completedTasks) {
				if (!task.id.startsWith("init-")) continue;
				const markerArmId = task.id.slice("init-".length);
				if (markerArmId) {
					this.initializedArmIds.add(markerArmId);
				}
			}
			this.initializedArmIdsLoaded = true;
		}

		return this.initializedArmIds.has(armId);
	}

	/**
	 * Prompt idle arms to check for tasks or wait for relevant file changes
	 * This is called in the poll cycle to keep arms busy
	 */
	private async promptIdleArms(): Promise<void> {
		// Always refresh task cache from API before task operations.
		await this.loadTasks();
		const taskSnapshot = await this.listTasksFromApi({
			status: ["pending", "claimed"],
			limit: 500,
		});

		const idleArms = Array.from(this.arms.values()).filter(
			(arm) => arm.status === "idle",
		);

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
				this.log(
					`Arm ${arm.id} [${armDomain}]: API harness, API server unavailable, skipping prompt`,
				);
				continue;
			}

			// Grace period: skip prompting arms that were just detected
			// This prevents interrupting arms that were working autonomously before brain came online
			const detectionTime = this.armDetectionTimes.get(arm.id);
			if (detectionTime) {
				const gracePeriod = await this.getBrainConfigNumber(
					"brain_arm_grace_period_minutes",
					5,
				);
				const detectedMinutesAgo =
					(Date.now() - detectionTime.getTime()) / 1000 / 60;
				if (detectedMinutesAgo < gracePeriod) {
					this.log(
						`Arm ${arm.id} [${armDomain}]: recently detected (${detectedMinutesAgo.toFixed(1)}m ago, grace period: ${gracePeriod}m), skipping prompt`,
					);
					continue;
				}
			}

			// Health check: verify the arm's harness is actually responsive
			if (isApi) {
				const harnessState = await this.getArmHarnessState(arm.id);
				if (!harnessState) {
					this.log(
						`Arm ${arm.id} [${armDomain}]: Cannot get harness state, skipping prompt`,
					);
					continue;
				}
				if (!harnessState.hasSession) {
					this.log(
						`Arm ${arm.id} [${armDomain}]: No active session (zombie?), marking as stopped`,
					);
					await this.syncArmStatus(arm.id, "stopped");
					continue;
				}
				if (harnessState.state === "stopped" || harnessState.state === "dead") {
					this.log(
						`Arm ${arm.id} [${armDomain}]: Harness state is ${harnessState.state}, marking as stopped`,
					);
					await this.syncArmStatus(arm.id, "stopped");
					continue;
				}
				if (this.isActiveHarnessState(harnessState.state)) {
					this.log(
						`Arm ${arm.id} [${armDomain}]: harness state is "${harnessState.state}", skipping idle prompt`,
					);
					if (arm.status !== "busy") {
						await this.syncArmStatus(arm.id, "busy");
					}
					continue;
				}
			}

			// Double-check state machine - don't prompt if it knows the arm has work
			if (this.armStateMachine) {
				const smContext = this.armStateMachine.getContext(arm.id);
				if (
					smContext &&
					(smContext.state === "task_assigned" || smContext.state === "working")
				) {
					this.log(
						`Arm ${arm.id} [${armDomain}]: state machine says "${smContext.state}", skipping prompt`,
					);
					continue;
				}
			}

			// Check recent activity across all known signal sources before nudging.
			const recentSignal = await this.getRecentArmActivitySignal(
				arm.id,
				160 * 1000,
			);
			if (recentSignal.recent) {
				this.log(
					`Arm ${arm.id} [${armDomain}]: ${recentSignal.reason || "recent activity"}, skipping prompt`,
				);
				continue;
			}

			// Get all unassigned pending tasks - any idle arm should be able to work on them
			// Domain is a preference, not a hard filter
			const availableTasks = taskSnapshot.filter((task) => {
				if (task.status !== "pending") return false;
				if (task.assignedTo) return false; // Already assigned to someone
				return true; // Any unassigned pending task is fair game
			});

			// Also include tasks specifically assigned to this arm
			const myAssignedTasks = taskSnapshot.filter(
				(task) => task.assignedTo === arm.id && task.status === "claimed",
			);

			const allTasks = [...myAssignedTasks, ...availableTasks];
			const uniqueTasks = allTasks.filter(
				(task, index, self) =>
					index === self.findIndex((t) => t.id === task.id),
			);

			if (uniqueTasks.length > 0) {
				// There are tasks available - prompt the arm to fetch its assignment
				const taskCount = uniqueTasks.length;
				const domainMatchCount = uniqueTasks.filter(
					(t) => !t.domain || t.domain === armDomain,
				).length;

				this.log(
					`Arm ${arm.id} [${armDomain}]: ${taskCount} task(s) available (${domainMatchCount} domain match), prompting to check instructions...`,
				);

				const prompt = await this.templates.renderTemplate(
					"arm-tasks-available-prompt.jinja",
					{
						task_count: taskCount,
					},
				);

				const promptSuccess = await this.sendPromptToArm(arm.name, prompt);

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
				this.log(
					`Arm ${arm.id} [${armDomain}]: No pending tasks, waiting for file changes...`,
				);

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
			frontend: [
				"src/components/**",
				"src/web/**",
				"*.css",
				"*.scss",
				"*.tsx",
				"*.ts",
			],
			backend: ["src/api/**", "src/services/**", "src/db/**", "*.ts"],
			testing: ["**/*.test.*", "**/*.spec.*", "e2e/**", "__tests__/**"],
			docs: ["*.md", "docs/**", "README*"],
			architect: [
				"src/**",
				"*.toml",
				"*.json",
				"AGENTS.md",
				"docs/architecture/**",
			],
			devops: ["Dockerfile", ".github/**", "*.yml", "*.yaml", "infra/**"],
			general: ["src/**", "*.ts", "*.md"],
		};

		return patterns[domain] ?? patterns["general"] ?? [];
	}

	private isActiveHarnessState(state: string): boolean {
		return (
			state === "initializing" ||
			state === "processing" ||
			state === "executing" ||
			state === "waiting_approval" ||
			state === "busy"
		);
	}

	private toEpochMs(value: unknown): number | null {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return null;
		}
		// OpenCode message times may be seconds while JS dates are milliseconds.
		return value < 1_000_000_000_000 ? value * 1000 : value;
	}

	private extractMessageTimestampMs(message: Record<string, unknown>): number | null {
		const info = message.info;
		if (!info || typeof info !== "object") {
			return null;
		}
		const time = (info as Record<string, unknown>).time;
		if (!time || typeof time !== "object") {
			return null;
		}
		const timeObj = time as Record<string, unknown>;
		return (
			this.toEpochMs(timeObj.completed) ??
			this.toEpochMs(timeObj.created) ??
			null
		);
	}

	private async getRecentArmMessageTimestampMs(
		armId: string,
		limit = 20,
	): Promise<number | null> {
		const response = await this.apiRequest<{ messages?: unknown[] }>(
			`/api/arms/${encodeURIComponent(armId)}/messages?limit=${limit}`,
			{},
			1500,
		);
		const messages = response?.messages;
		if (!messages || messages.length === 0) {
			return null;
		}

		let latestMs: number | null = null;
		for (const message of messages) {
			if (!message || typeof message !== "object") {
				continue;
			}
			const timestampMs = this.extractMessageTimestampMs(
				message as Record<string, unknown>,
			);
			if (
				timestampMs !== null &&
				(latestMs === null || timestampMs > latestMs)
			) {
				latestMs = timestampMs;
			}
		}

		return latestMs;
	}

	private async getRecentArmActivitySignal(
		armId: string,
		thresholdMs: number,
	): Promise<{ recent: boolean; reason?: string }> {
		const nowMs = Date.now();

		const lastNatsEvent = this.lastArmEventTime.get(armId);
		if (lastNatsEvent) {
			const ageMs = nowMs - lastNatsEvent.getTime();
			if (ageMs < thresholdMs) {
				return {
					recent: true,
					reason: `recent NATS arm event ${Math.round(ageMs / 1000)}s ago`,
				};
			}
		}

		if (eventStore.isInitialized()) {
			try {
				const recentArmEvents = await eventStore.getArmEvents(armId, 25);
				let latestJetStreamMs: number | null = null;
				for (const event of recentArmEvents) {
					const timestampMs = new Date(event.timestamp).getTime();
					if (
						Number.isFinite(timestampMs) &&
						(latestJetStreamMs === null || timestampMs > latestJetStreamMs)
					) {
						latestJetStreamMs = timestampMs;
					}
				}
				if (latestJetStreamMs !== null) {
					const ageMs = nowMs - latestJetStreamMs;
					if (ageMs < thresholdMs) {
						return {
							recent: true,
							reason: `recent JetStream arm event ${Math.round(ageMs / 1000)}s ago`,
						};
					}
				}
			} catch {
				// Best effort only.
			}
		}

		const latestMessageMs = await this.getRecentArmMessageTimestampMs(armId, 20);
		if (latestMessageMs !== null) {
			const ageMs = nowMs - latestMessageMs;
			if (ageMs >= 0 && ageMs < thresholdMs) {
				return {
					recent: true,
					reason: `recent session message ${Math.round(ageMs / 1000)}s ago`,
				};
			}
		}

		return { recent: false };
	}

	/**
	 * Send a prompt to an arm via the API server
	 */
	private async sendPromptToArm(
		armName: string,
		message: string,
		options?: { interrupt?: boolean },
	): Promise<boolean> {
		try {
			const url = `${this.apiBaseUrl}/api/arms/${armName}/prompt`;
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-API-Key": this.apiKey,
				},
				body: JSON.stringify({
					prompt: message,
					interrupt: options?.interrupt,
				}),
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
	private async getArmHarnessState(
		armId: string,
	): Promise<{ state: string; hasSession: boolean } | null> {
		try {
			return await this.apiRequest<{ state: string; hasSession: boolean }>(
				`/api/arms/${armId}/state`,
			);
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
			const result = await this.apiRequest<{
				success: boolean;
				newSessionId?: string;
			}>(`/api/arms/${armId}/reset-session`, { method: "POST" });
			if (result?.success) {
				this.log(
					`Reset session for arm ${armId}: new session ${result.newSessionId}`,
				);
				return true;
			}
			return false;
		} catch (err) {
			this.log(`Failed to reset session for arm ${armId}: ${err}`);
			return false;
		}
	}

	private async getBrainConfigValue(key: string): Promise<string | null> {
		const response = await this.apiRequest<{
			key: string;
			value: string | null;
		}>(`/api/brain/config/${encodeURIComponent(key)}`);
		if (!response || typeof response.value !== "string") {
			return null;
		}
		return response.value;
	}

	/**
	 * Get a numeric config value from the API server config table
	 */
	private async getBrainConfigNumber(
		key: string,
		defaultValue: number,
	): Promise<number> {
		const value = await this.getBrainConfigValue(key);
		if (value === null) return defaultValue;
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : defaultValue;
	}

	private async getBrainConfigBoolean(
		key: string,
		defaultValue: boolean,
	): Promise<boolean> {
		const value = await this.getBrainConfigValue(key);
		if (value === null) return defaultValue;
		return value.toLowerCase() === "true";
	}

	/**
	 * Sync an arm's status in the database and in-memory tracking
	 * Used when harness state differs from database state
	 */
	private async syncArmStatus(
		armId: string,
		status: "idle" | "busy" | "stopped",
	): Promise<void> {
		// Update in-memory
		const arm = this.arms.get(armId);
		if (arm) {
			arm.status = status;
			if (status === "stopped") {
				this.arms.delete(armId);
				this.idleArmPromptTracker.delete(armId);
			}
		}

		// Update via API
		await this.patchArmViaApi(armId, {
			status,
			lastActivityAt: new Date().toISOString(),
		});

		this.log(`Synced arm ${armId} status to: ${status}`);
		this.logActivity("brain", "arm_status_synced", armId, {
			status,
			source: "harness_state",
		});
	}

	/**
	 * Strip ANSI escape codes, TUI characters, and other non-content characters
	 * This cleans up terminal output for analysis and display
	 */
	private stripTerminalArtifacts(text: string): string {
		return (
			text
				// ANSI escape sequences (colors, cursor movement, etc.)
				.replace(
					new RegExp("\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])", "g"),
					"",
				)
				// OSC sequences (terminal titles, hyperlinks, etc.)
				.replace(
					new RegExp(
						"\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
						"g",
					),
					"",
				)
				// CSI sequences that might be malformed
				.replace(new RegExp("\\u001B\\[[\\d;]*[A-Za-z]", "g"), "")
				// Other escape sequences
				.replace(new RegExp("\\u001B[PX^_].*?\\u001B\\\\", "g"), "")
				// Control characters (keep \t \n \r)
				.replace(
					new RegExp(
						"[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
						"g",
					),
					"",
				)
				// Box-drawing and block characters (TUI borders)
				.replace(
					/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬]/g,
					"",
				)
				// Block elements (used for progress bars, etc.)
				.replace(/[▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟■□▢▣▤▥▦▧▨▩▪▫▬▭▮▯]/g, "")
				// Geometric shapes (squares, diamonds, etc.)
				.replace(
					/[◆◇◈◉◊○◌◍◎●◐◑◒◓◔◕◖◗◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯⬝⬞⬟⬠⬡⬢⬣⬤⬥⬦⬧⬨⬩⬪⬫⬬⬭⬮⬯]/g,
					"",
				)
				// More geometric and misc symbols
				.replace(/[⊙⊚⊛⊜⊝⊞⊟⊠⊡▰▱▲△▴▵▶▷▸▹►▻▼▽▾▿◀◁◂◃◄◅◆◇]/g, "")
				// Braille patterns (sometimes used for graphics)
				.replace(/[\u2800-\u28FF]/g, "")
				// Arrows and pointers
				.replace(
					/[←↑→↓↔↕↖↗↘↙↚↛↜↝↞↟↠↡↢↣↤↥↦↧↨↩↪↫↬↭↮↯↰↱↲↳↴↵↶↷↸↹↺↻↼↽↾↿⇀⇁⇂⇃⇄⇅⇆⇇⇈⇉⇊⇋⇌⇍⇎⇏⇐⇑⇒⇓⇔⇕⇖⇗⇘⇙⇚⇛⇜⇝⇞⇟⇠⇡⇢⇣⇤⇥⇦⇧⇨⇩⇪]/g,
					"",
				)
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
				.trim()
		);
	}

	/**
	 * Check if an arm is using an API-based harness (opencode-api)
	 * API harnesses don't have PTY output, so log analysis is unreliable
	 */
	private async isApiHarness(armId: string): Promise<boolean> {
		const arm = await this.getArmFromApi(armId);
		return arm?.harness === "opencode-api";
	}

	/**
	 * Check if an arm has sent a recent heartbeat
	 * Recent heartbeat indicates the arm is still active
	 */
	private async hasRecentHeartbeat(
		armId: string,
		maxAgeSeconds = 60,
	): Promise<boolean> {
		const arm = await this.getArmFromApi(armId);
		if (!arm?.lastHeartbeat) return false;
		const lastHeartbeat = new Date(arm.lastHeartbeat);
		const now = new Date();
		const secondsSinceHeartbeat =
			(now.getTime() - lastHeartbeat.getTime()) / 1000;
		return secondsSinceHeartbeat < maxAgeSeconds;
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
			nats: {
				healthy: boolean;
				lastCheck: Date | null;
				error?: string;
				optional: boolean;
			};
			maildir: { healthy: boolean; lastCheck: Date | null; error?: string };
		};
		issues: string[];
	}> {
		const now = new Date();
		const issues: string[] = [];

		// 1. Check Database (CRITICAL - required for everything)
		// Use dedicated infrastructure-health endpoint first because /api/status can be slow.
		try {
			let dbHealth:
				| { healthy: boolean; error?: string }
				| undefined
				| null = null;

			const infrastructure = await this.apiRequest<{
				components?: Array<{
					component: string;
					healthy: boolean;
					error?: string;
				}>;
			}>("/api/brain/internal/infrastructure-health");
			dbHealth = infrastructure?.components?.find(
				(component) => component.component === "database",
			);

			// Backward-compatible fallback for older API versions.
			if (!dbHealth) {
				const systemStatus = await this.apiRequest<{
					infrastructure?: {
						database?: { healthy: boolean; error?: string };
					};
				}>("/api/status");
				dbHealth = systemStatus?.infrastructure?.database;
			}

			if (!dbHealth) {
				this.infrastructureHealth.database = {
					healthy: false,
					lastCheck: now,
					error:
						"Database health unavailable from API (/api/brain/internal/infrastructure-health, /api/status)",
				};
				issues.push("Database health unavailable from API");
			} else if (dbHealth.healthy) {
				this.infrastructureHealth.database = { healthy: true, lastCheck: now };
			} else {
				this.infrastructureHealth.database = {
					healthy: false,
					lastCheck: now,
					error: dbHealth.error || "Database unhealthy",
				};
				issues.push(
					`Database error: ${dbHealth.error || "Database reported unhealthy"}`,
				);
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.infrastructureHealth.database = {
				healthy: false,
				lastCheck: now,
				error: errorMsg,
			};
			issues.push(`Database error: ${errorMsg}`);
		}

		// 2. Check API Server (CRITICAL for arm communication)
		try {
			const apiHealthy = await this.isApiServerAvailable();
			if (apiHealthy) {
				this.infrastructureHealth.apiServer = { healthy: true, lastCheck: now };
			} else {
				this.infrastructureHealth.apiServer = {
					healthy: false,
					lastCheck: now,
					error: "API server not responding",
				};
				issues.push("API server not responding at " + this.apiBaseUrl);
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.infrastructureHealth.apiServer = {
				healthy: false,
				lastCheck: now,
				error: errorMsg,
			};
			issues.push(`API server error: ${errorMsg}`);
		}

		// 3. Check NATS (OPTIONAL - degrades functionality but not critical)
		try {
			if (this.natsClient) {
				const connected = this.natsClient.connected();
				if (connected) {
					this.infrastructureHealth.nats = {
						healthy: true,
						lastCheck: now,
						optional: true,
					};
				} else {
					this.infrastructureHealth.nats = {
						healthy: false,
						lastCheck: now,
						error: "NATS disconnected",
						optional: true,
					};
					// Not a critical issue - we can work without NATS
				}
			} else {
				this.infrastructureHealth.nats = {
					healthy: false,
					lastCheck: now,
					error: "NATS client not initialized",
					optional: true,
				};
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.infrastructureHealth.nats = {
				healthy: false,
				lastCheck: now,
				error: errorMsg,
				optional: true,
			};
		}

		// 4. Check Maildir (IMPORTANT for human communication but not blocking)
		try {
			// Try to list inbox to verify maildir is accessible
			await this.inbox.list("new");
			this.infrastructureHealth.maildir = { healthy: true, lastCheck: now };
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.infrastructureHealth.maildir = {
				healthy: false,
				lastCheck: now,
				error: errorMsg,
			};
			issues.push(`Maildir error: ${errorMsg}`);
		}

		// Determine overall health
		// Critical: database must be healthy
		// For arm work: API server must be healthy
		const databaseHealthy = this.infrastructureHealth.database.healthy;
		const apiHealthy = this.infrastructureHealth.apiServer.healthy;
		const canWorkWithArms = databaseHealthy && apiHealthy;
		const healthy =
			databaseHealthy &&
			apiHealthy &&
			this.infrastructureHealth.maildir.healthy;

		// Log health status
		if (!healthy) {
			this.log(`Infrastructure health check: ${issues.length} issue(s)`);
			for (const issue of issues) {
				this.log(`  - ${issue}`);
			}
		}

		// Persist infrastructure health to API server
		try {
			const components = [
				{
					component: "database",
					healthy: this.infrastructureHealth.database.healthy,
					optional: false,
					error: this.infrastructureHealth.database.error,
				},
				{
					component: "nats",
					healthy: this.infrastructureHealth.nats.healthy,
					optional: true,
					error: this.infrastructureHealth.nats.error,
				},
				{
					component: "maildir",
					healthy: this.infrastructureHealth.maildir.healthy,
					optional: false,
					error: this.infrastructureHealth.maildir.error,
				},
				{
					component: "api_server",
					healthy: this.infrastructureHealth.apiServer.healthy,
					optional: false,
					error: this.infrastructureHealth.apiServer.error,
				},
			];

			const persistResponse = await this.apiRequest<{
				result: { success: boolean; error?: string };
			}>("/api/brain/internal/infrastructure-health", {
				method: "POST",
				body: JSON.stringify({ components }),
			});
			if (!persistResponse?.result?.success) {
				this.log(
					`Failed to persist infrastructure health: ${persistResponse?.result?.error || "API unavailable"}`,
				);
			}
		} catch (err) {
			this.log(`Failed to persist infrastructure health: ${err}`);
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

		// Check API health for database/API recovery.
		if (!this.infrastructureHealth.database.healthy) {
			try {
				const status = await this.apiRequest<{ status: string }>("/api/health");
				if (status?.status === "ok") {
					this.log("Recovered database/API connection");
					recovered = true;
				}
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
			const minutesSince =
				(Date.now() - this.lastInfraFailureNotification.getTime()) / 1000 / 60;
			if (minutesSince < 15) {
				return;
			}
		}

		this.lastInfraFailureNotification = new Date();

		// Create a system-detected bug report for critical infrastructure issues
		const criticalIssues = issues.filter(
			(issue) =>
				issue.includes("Database") ||
				issue.includes("API Server") ||
				issue.includes("Maildir"),
		);
		if (criticalIssues.length > 0) {
			const bugPayload = {
				id: `bug-system-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				title: "Critical Infrastructure Issues Detected",
				description: `The brain detected critical infrastructure failures that may prevent normal operation:\n\n${criticalIssues.map((i) => `- ${i}`).join("\n")}\n\nComponent Status:\n- Database: ${this.infrastructureHealth.database.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.database.error || "Unhealthy")}\n- API Server: ${this.infrastructureHealth.apiServer.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.apiServer.error || "Unhealthy")}\n- NATS: ${this.infrastructureHealth.nats.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.nats.error || "Unhealthy")} (optional)\n- Maildir: ${this.infrastructureHealth.maildir.healthy ? "✓ Healthy" : "✗ " + (this.infrastructureHealth.maildir.error || "Unhealthy")}`,
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

		const body = await this.templates.renderTemplate(
			"human-infra-issues.jinja",
			{
				issues_list: issues.map((i) => `- ${i}`).join("\n"),
				db_status: this.infrastructureHealth.database.healthy
					? "✓ Healthy"
					: "✗ " + (this.infrastructureHealth.database.error || "Unhealthy"),
				api_status: this.infrastructureHealth.apiServer.healthy
					? "✓ Healthy"
					: "✗ " + (this.infrastructureHealth.apiServer.error || "Unhealthy"),
				nats_status: this.infrastructureHealth.nats.healthy
					? "✓ Healthy"
					: "✗ " + (this.infrastructureHealth.nats.error || "Unhealthy"),
				maildir_status: this.infrastructureHealth.maildir.healthy
					? "✓ Healthy"
					: "✗ " + (this.infrastructureHealth.maildir.error || "Unhealthy"),
			},
		);
		await this.sendToHuman({
			subject: "[coleo] Infrastructure health issues detected",
			body,
			headers: {
				"X-Coleo-Type": "infrastructure-alert",
				Priority: "high",
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
		const busyArms = Array.from(this.arms.values()).filter(
			(arm) => arm.status === "busy",
		);

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
						if (
							smContext &&
							(smContext.state === "task_assigned" ||
								smContext.state === "working")
						) {
							// State machine knows arm has a task - don't sync to idle
							// The harness reporting idle is expected during task acknowledgment
							this.log(
								`Arm ${arm.name}: harness reports idle but state machine is in "${smContext.state}" - keeping busy (task: "${smContext.currentTaskSubject}")`,
							);
							continue;
						}
					}
					// No state machine or state machine agrees it's idle - sync them
					// But first check if any fresh activity signal says it's still active.
					const recentSignal = await this.getRecentArmActivitySignal(
						arm.id,
						60 * 1000,
					);
					if (recentSignal.recent) {
						this.log(
							`Arm ${arm.name}: ${recentSignal.reason || "recent activity"}, keeping busy`,
						);
						continue;
					}
					this.log(
						`Arm ${arm.name}: harness state is "idle" but DB says "busy", syncing...`,
					);
					await this.syncArmStatus(arm.id, "idle");
					arm.status = "idle";
					continue;
				} else if (
					harnessState.state === "dead" ||
					harnessState.state === "stopped"
				) {
					// Arm is dead/stopped - update DB
					this.log(
						`Arm ${arm.name}: harness state is "${harnessState.state}", marking as stopped`,
					);
					await this.syncArmStatus(arm.id, "stopped");
					continue;
				} else if (harnessState.state === "error") {
					// Arm is in error state - this might need intervention
					this.log(
						`Arm ${arm.name}: harness state is "error", will analyze logs`,
					);
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
						this.log(
							`Arm ${arm.name}: API harness with recent heartbeat, assuming active`,
						);
						continue;
					} else {
						// No recent heartbeat - might be truly stuck or the API server is down
						this.log(
							`Arm ${arm.name}: API harness with no recent heartbeat, will analyze logs`,
						);
						// Fall through to log analysis as a last resort
					}
				} else {
					this.log(
						`Arm ${arm.name}: could not get harness state, falling back to log analysis`,
					);
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
				const task = this.tasks.find((t) => t.id === arm.currentTask);
				currentTaskDescription = task
					? `${task.subject}: ${task.description?.slice(0, 200)}`
					: undefined;
			}

			// Analyze if the arm is stuck
			const analysis = await this.stuckArmAnalyzer.analyze(
				arm.name,
				armDomain,
				recentOutput,
				currentTaskDescription,
			);

			if (!analysis.isStuck) {
				this.log(`Arm ${arm.name}: not stuck (${analysis.reasoning})`);
				continue;
			}

			// Arm is stuck - take action
			this.log(
				`Arm ${arm.name} is STUCK: ${analysis.stuckType} (confidence: ${analysis.confidence}) - ${analysis.reasoning}`,
			);
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
	private async handleStuckArm(
		arm: Arm,
		analysis: StuckAnalysis,
	): Promise<void> {
		switch (analysis.suggestedAction) {
			case "answer":
				// Generate an answer to the arm's question
				if (analysis.suggestedResponse) {
					this.log(
						`Answering ${arm.name}'s question: "${analysis.suggestedResponse.slice(0, 50)}..."`,
					);
					const success = await this.sendPromptToArm(
						arm.name,
						analysis.suggestedResponse,
					);
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
					const approvalResponse =
						analysis.suggestedResponse || "Yes, proceed.";
					this.log(`Auto-approving for ${arm.name}: "${approvalResponse}"`);
					const success = await this.sendPromptToArm(
						arm.name,
						approvalResponse,
					);
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
					const prompt = await this.templates.renderTemplate(
						"arm-loop-compact-nudge.jinja",
					);
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
					await this.patchTaskViaApi(arm.currentTask, {
						status: "blocked",
					});
				}
				await this.escalateStuckArm(arm, analysis);
				break;

			case "prompt": {
				// Send a generic nudge to continue
				const defaultNudge = await this.templates.renderTemplate(
					"arm-generic-nudge.jinja",
				);
				const nudgeMessage = analysis.suggestedResponse || defaultNudge;
				this.log(
					`Prompting ${arm.name} to continue: "${nudgeMessage.slice(0, 50)}..."`,
				);
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
	private async escalateStuckArm(
		arm: Arm,
		analysis: StuckAnalysis,
	): Promise<void> {
		const stuckType = analysis.stuckType || "unknown";

		// Check if we already escalated for this same stuck type
		const lastStuck = this.lastStuckState.get(arm.id);
		if (lastStuck && lastStuck.stuckType === stuckType) {
			// Already escalated for this stuck type - don't spam the human
			const minutesSinceEscalation =
				(Date.now() - lastStuck.escalatedAt.getTime()) / 1000 / 60;
			this.log(
				`Arm ${arm.name} still stuck (${stuckType}) - already escalated ${Math.round(minutesSinceEscalation)}m ago, skipping duplicate notification`,
			);
			return;
		}

		const recentOutput = await this.readArmLogs(arm.name, 30);
		const taskInfo = arm.currentTask
			? this.tasks.find((t) => t.id === arm.currentTask)?.subject ||
				arm.currentTask
			: "unknown";

		const body = await this.templates.renderTemplate("human-arm-stuck.jinja", {
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
				Priority: "high",
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
		const idleArms = Array.from(this.arms.values()).filter(
			(arm) => arm.status === "idle",
		);
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
				const lastProductiveActivity = recentActivity?.find((a) =>
					this.isProductiveAction(a.action),
				);

				tracker = {
					promptCount: 0,
					lastPromptAt: new Date(),
					lastProductiveAt: lastProductiveActivity
						? new Date(lastProductiveActivity.timestamp)
						: null,
					escalationLevel: 0,
				};
				this.idleArmPromptTracker.set(arm.id, tracker);

				// If the arm has recent productive activity, skip stuck loop detection for now
				// This prevents the brain from interrupting arms that were working autonomously
				if (tracker.lastProductiveAt) {
					const idleMinutes =
						(Date.now() - tracker.lastProductiveAt.getTime()) / 1000 / 60;
					this.log(
						`Arm ${arm.id}: has recent productive activity (${idleMinutes.toFixed(1)}m ago), skipping stuck loop check`,
					);
					continue;
				}
			}

			// Check for productive activity since last prompt
			const hasProductiveActivity = recentActivity.some(
				(a) =>
					this.isProductiveAction(a.action) &&
					new Date(a.timestamp) > tracker!.lastPromptAt,
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
				stuckMinutes =
					(Date.now() - tracker.lastProductiveAt.getTime()) / 1000 / 60;
			} else if (recentActivity.length > 0) {
				// No known productive activity - use oldest activity in window as reference
				const oldestTimestamp =
					recentActivity[recentActivity.length - 1]?.timestamp;
				if (oldestTimestamp) {
					stuckMinutes =
						(Date.now() - new Date(oldestTimestamp).getTime()) / 1000 / 60;
				} else {
					stuckMinutes = 15; // Default to triggering detection
				}
			} else {
				stuckMinutes = 15; // Default to triggering detection
			}

			const promptInterval =
				(Date.now() - tracker.lastPromptAt.getTime()) / 1000;

			this.log(
				`Arm ${arm.id}: promptCount=${tracker.promptCount}, stuckMinutes=${stuckMinutes.toFixed(1)}, interval=${promptInterval.toFixed(0)}s`,
			);

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
	private async getRecentArmActivity(
		armId: string,
		minutes: number,
	): Promise<Array<{
		timestamp: string;
		action: string;
		details: string;
	}> | null> {
		if (!eventStore.isInitialized()) return null;

		const since = new Date(Date.now() - minutes * 60 * 1000);
		try {
			const events = await eventStore.getArmEvents(armId, 100);

			// Filter to events within the time window and transform to expected format
			return events
				.filter((e) => new Date(e.timestamp) > since)
				.map((e) => ({
					timestamp: e.timestamp,
					action: e.type,
					details: JSON.stringify(e.data),
				}))
				.sort(
					(a, b) =>
						new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
				);
		} catch {
			return null;
		}
	}

	/**
	 * Detect prompt-response patterns in activity stream
	 */
	private analyzePromptResponsePattern(
		armId: string,
		activity: Array<{ timestamp: string; action: string; details: string }>,
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
		tracker: {
			promptCount: number;
			lastPromptAt: Date;
			lastProductiveAt: Date | null;
			escalationLevel: number;
		},
		stuckMinutes: number,
	): Promise<void> {
		// Determine intervention level based on escalation level
		if (tracker.escalationLevel === 0) {
			this.log(
				`Arm ${arm.id} appears stuck (${stuckMinutes.toFixed(1)}m, ${tracker.promptCount} prompts). Sending interrupt...`,
			);
			this.logActivity("brain", "idle_arm_stuck", arm.id, {
				stuckMinutes: stuckMinutes.toFixed(1),
				promptCount: tracker.promptCount,
				intervention: "interrupt",
			});
			await this.sendPromptToArm(arm.name, "/interrupt", { interrupt: true });
			tracker.escalationLevel = 1;
			tracker.promptCount = 0; // Reset after intervention
		} else if (tracker.escalationLevel === 1) {
			this.log(
				`Arm ${arm.id} still stuck after interrupt. Sending /compact...`,
			);
			this.logActivity("brain", "idle_arm_stuck", arm.id, {
				stuckMinutes: stuckMinutes.toFixed(1),
				promptCount: tracker.promptCount,
				intervention: "compact",
			});
			await this.sendPromptToArm(arm.name, "/compact");
			tracker.escalationLevel = 2;
			tracker.promptCount = 0;
		} else if (tracker.escalationLevel === 2) {
			await this.escalateIdleArmToHuman(arm, tracker, stuckMinutes);
			tracker.escalationLevel = 3;
		} else if (tracker.escalationLevel === 3) {
			if (stuckMinutes >= 20) {
				this.log(
					`Arm ${arm.id} stuck for 20+ minutes after escalation. Auto-killing zombie arm...`,
				);
				this.logActivity("brain", "arm_zombie_killed", arm.id, {
					stuckMinutes,
					promptCount: tracker.promptCount,
					action: "auto_kill",
				});
				await this.killZombieArm(arm);
			} else if (stuckMinutes >= 15) {
				this.log(
					`Arm ${arm.id} stuck for 15+ minutes. Will auto-kill at 20 minutes.`,
				);
			}
		}

		// Reset prompt count after any intervention (we'll re-detect if still stuck)
		tracker.promptCount = 0;
	}

	/**
	 * Kill a zombie arm that has been unresponsive for too long
	 * Terminates the process and cleans up database state
	 */
	private async escalateIdleArmToHuman(
		arm: Arm,
		tracker: {
			promptCount: number;
			lastPromptAt: Date;
			lastProductiveAt: Date | null;
			escalationLevel: number;
		},
		stuckMinutes: number,
	): Promise<void> {
		this.log(`Arm ${arm.id} still stuck after compact. Escalating to human...`);
		this.logActivity("brain", "idle_arm_stuck", arm.id, {
			stuckMinutes: stuckMinutes.toFixed(1),
			promptCount: tracker.promptCount,
			intervention: "escalate",
		});
		await this.sendToHuman({
			subject: `[coleo] Arm ${arm.name} stuck in idle loop`,
			body: await this.templates.renderTemplate("human-arm-idle-loop.jinja", {
				arm_name: arm.name,
				stuck_minutes: stuckMinutes.toFixed(1),
				prompt_count: tracker.promptCount,
				arm_status: arm.status,
				last_productive: tracker.lastProductiveAt?.toISOString() || "never",
			}),
		});
	}

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

			// Update arm status via API
			await this.patchArmViaApi(arm.id, {
				status: "stopped",
				lastActivityAt: new Date().toISOString(),
			});

			// Remove from in-memory tracking
			this.arms.delete(arm.id);
			this.idleArmPromptTracker.delete(arm.id);
			this.lastStuckState.delete(arm.id);

			// Notify human
			const body = await this.templates.renderTemplate(
				"human-arm-zombie-killed.jinja",
				{
					arm_name: arm.name,
				},
			);
			await this.sendToHuman({
				subject: `[coleo] Auto-killed zombie arm: ${arm.name}`,
				body,
			});

			// Mark any current task as blocked
			if (arm.currentTask) {
				await this.patchTaskViaApi(arm.currentTask, {
					status: "blocked",
				});
				this.log(
					`Marked task ${arm.currentTask} as blocked due to zombie arm kill`,
				);
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
	 * Queue maintenance for pending tasks.
	 * Tasks are not push-assigned by the brain; arms pull them via MCP.
	 */
	private async assignTasks(): Promise<void> {
		// Always refresh task cache from API before task operations.
		await this.loadTasks();
		const taskSnapshot = await this.listTasksFromApi({
			status: ["pending"],
			limit: 500,
		});

		const pendingTasks = taskSnapshot
			.filter(
				(t) => t.status === "pending" && !t.assignedTo && !t.dependencyBlocked,
			)
			.sort(
				(a, b) =>
					(a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
					(b.sortOrder ?? Number.MAX_SAFE_INTEGER),
			);
		const unresolvedBugs = await this.listBugsFromApi(500);
		for (const task of pendingTasks) {
			const blockingBugs = unresolvedBugs.filter((bug) =>
				bug.blockers.includes(task.id),
			);
			if (blockingBugs.length === 0) {
				continue;
			}

			this.log(
				`Task ${task.id} blocked by ${blockingBugs.length} unresolved bug(s)`,
			);

			await this.patchTaskViaApi(task.id, {
				status: "blocked",
			});

			const criticalBugs = blockingBugs.filter(
				(b) => b.priority === "critical",
			);
			const highBugs = blockingBugs.filter((b) => b.priority === "high");

			if (criticalBugs.length > 0 || highBugs.length > 0) {
				const body = await this.templates.renderTemplate(
					"human-task-blocked-by-bugs.jinja",
					{
						task_id: task.id,
						task_subject: task.subject,
						blocking_bugs_list: blockingBugs
							.map((b) => `- ${b.title} (${b.priority} priority)`)
							.join("\n"),
					},
				);
				await this.sendToHuman({
					subject: `[coleo] Task Blocked by ${criticalBugs.length + highBugs.length} Critical/High Priority Bug(s)`,
					body,
					headers: {
						"X-Coleo-Type": "task-blocked",
						"X-Coleo-Task-Id": task.id,
					},
				});
			}
		}
	}

	/**
	 * Send a message to an arm's queue via API-backed state adapter
	 */
	private async sendToArm(
		armId: string,
		message: { type: string; payload: unknown },
	): Promise<void> {
		const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
		const queued = await this.queueMessageViaApi({
			id: messageId,
			from: "brain",
			to: armId,
			type: message.type,
			payload: message.payload,
		});
		if (!queued) {
			this.log(`Failed to queue message ${messageId} for arm ${armId}`);
		}
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

	// State persistence methods via API server

	private async loadState(): Promise<void> {
		try {
			const response = await this.apiRequest<{
				state?: {
					status: BrainState["status"];
					pollIntervalMs: number;
					startedAt?: string;
					lastPollAt?: string;
					pendingTasks: number;
					completedToday: number;
					completedTaskCount: number;
				};
			}>("/api/brain/state");

			if (!response?.state) return;

			this.state = {
				status: response.state.status,
				pollIntervalMs: response.state.pollIntervalMs,
				activeArms: [],
				startedAt: response.state.startedAt,
				lastPollAt: response.state.lastPollAt,
				pendingTasks: response.state.pendingTasks,
				completedToday: response.state.completedToday,
				completedTaskCount: response.state.completedTaskCount ?? 0,
			};
			this.completedTaskCount = this.state.completedTaskCount;
		} catch (err) {
			console.error(`Failed to load brain state via API: ${err}`);
		}
	}

	private async saveState(): Promise<void> {
		try {
			await this.apiRequest<{ state?: unknown }>("/api/brain/state", {
				method: "PATCH",
				body: JSON.stringify({
					status: this.state.status,
					pollIntervalMs: this.state.pollIntervalMs,
					startedAt: this.state.startedAt,
					lastPollAt: this.state.lastPollAt,
					pendingTasks: this.state.pendingTasks,
					completedToday: this.state.completedToday,
					completedTaskCount: this.state.completedTaskCount,
				}),
			});
		} catch (err) {
			console.error(`Failed to save brain state via API: ${err}`);
		}
	}

	private async loadTasks(): Promise<void> {
		this.tasks = await this.listTasksFromApi({
			status: ["pending", "claimed", "in_progress", "blocked", "completing"],
			limit: 500,
		});
		this.state.pendingTasks = this.tasks.filter(
			(t) => t.status === "pending",
		).length;
	}

	private async saveTasks(): Promise<void> {
		// Task persistence is API-driven. Keep this method for compatibility with
		// older call sites while migration to explicit API writes is in progress.
		this.state.pendingTasks = (
			await this.listTasksFromApi({ status: ["pending"], limit: 500 })
		).length;
	}

	/**
	 * Sync tasks from project plan files into the task API
	 */
	private async syncPlanTasks(): Promise<void> {
		try {
			// Get project root (current working directory or configured)
			const projectRoot = process.env.OCTOPAI_PROJECT_ROOT || process.cwd();

			// Check if task auto-discover is enabled
			const autoDiscover = await this.getBrainConfigBoolean(
				"task_auto_discover",
				true,
			);
			if (!autoDiscover) {
				return; // Task sync disabled
			}

			// Find and parse all plan files
			const planFiles = await findPlanFiles(projectRoot);

			if (planFiles.length === 0) {
				return; // No plan files found
			}

			let newTasksCount = 0;
			let updatedTasksCount = 0;
			const existingTasks = await this.listTasksFromApi({ limit: 5000 });
			const existingById = new Map(existingTasks.map((task) => [task.id, task]));

			for (const filePath of planFiles) {
				const result = await parsePlanFile(filePath);

				if (result.errors.length > 0) {
					this.log(
						`Plan parse errors in ${filePath}: ${result.errors.join(", ")}`,
					);
					continue;
				}

				// Skip unchanged files based on in-memory hash cache.
				const lastHash = this.planFileHashes.get(filePath);
				if (lastHash === result.fileHash) {
					// File hasn't changed, skip
					continue;
				}

				// Import tasks from plan
				const dbTasks = tasksToDatabaseFormat(result.tasks);

				for (const task of dbTasks) {
					const existing = existingById.get(task.id) || null;

					if (!existing) {
						const created = await this.createTaskViaApi({
							id: task.id,
							subject: task.subject,
							description: task.description,
							status: task.status as Task["status"],
							priority: task.priority as Task["priority"],
							sourceType: task.source_type as
								| "manual"
								| "plan"
								| "email"
								| "discovery"
								| "proposal"
								| "system",
							sourceRef: task.source_ref,
							phase: task.phase,
							metadata: task.metadata
								? (JSON.parse(task.metadata) as Record<string, unknown>)
								: undefined,
						});
						if (created) {
							newTasksCount++;
							existingById.set(created.id, created);
						}
					} else if (
						existing.status === "pending" &&
						task.status === "completed"
					) {
						const updated = await this.patchTaskViaApi(task.id, {
							status: "completed",
						});
						if (updated) {
							updatedTasksCount++;
							existingById.set(updated.id, updated);
						}
					}
				}

				this.planFileHashes.set(filePath, result.fileHash);
			}

			// Remove stale hashes for plan files that no longer exist.
			for (const knownPath of Array.from(this.planFileHashes.keys())) {
				if (!planFiles.includes(knownPath)) {
					this.planFileHashes.delete(knownPath);
				}
			}

			if (newTasksCount > 0 || updatedTasksCount > 0) {
				this.log(
					`Synced tasks from plans: ${newTasksCount} new, ${updatedTasksCount} updated`,
				);
				this.logActivity("brain", "tasks_synced", undefined, {
					newTasks: newTasksCount,
					updated: updatedTasksCount,
				});
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

			const existingTasks = await this.listTasksFromApi({
				status: ["pending", "claimed", "in_progress", "blocked"],
				limit: 500,
			});

			const tasksForDeduplication = await Promise.all(
				existingTasks.map(async (task) => {
					const discussionText = await this.getTaskDiscussionText(task.id);
					return {
						subject: task.subject,
						description: `${task.description} ${discussionText}`.trim(),
					};
				}),
			);

			// Deduplicate
			const newItems = deduplicateItems(result.items, tasksForDeduplication);

			if (newItems.length === 0) {
				// All items were duplicates, clear inbox anyway
				await clearInbox(projectRoot);
				this.log(
					`Inbox: ${result.items.length} items were duplicates, cleared inbox`,
				);
				return;
			}

			// Create tasks from inbox items
			let created = 0;
			for (const item of newItems) {
				const taskId = `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
				const createdTask = await this.createTaskViaApi({
					id: taskId,
					subject: item.subject,
					description: item.description,
					status: "pending",
					priority: item.priority as Task["priority"],
					sourceType: "system",
					sourceRef: ".project/inbox.md",
				});
				if (createdTask) {
					created++;
				}
			}

			// Clear the inbox
			await clearInbox(projectRoot);

			this.log(`Inbox: created ${created} tasks, cleared inbox`);
			this.logActivity("brain", "inbox_processed", undefined, {
				itemsFound: result.items.length,
				duplicates: result.items.length - newItems.length,
				tasksCreated: created,
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
		try {
			const nowMs = Date.now();
			const oneDayAgoMs = nowMs - 24 * 60 * 60 * 1000;

			const completedTasks = await this.listTasksFromApi({
				status: ["completed"],
				limit: 500,
			});
			const allReports = await this.listStatusReportsFromApi({ limit: 500 });
			const activeTasks = await this.listTasksFromApi({ limit: 500 });
			const verifySubjects = new Set(
				activeTasks
					.filter((t) => t.subject.startsWith("Verify & Polish: "))
					.map((t) => t.subject),
			);

			let verificationTasksCreated = 0;
			const reportsByTask = new Map<
				string,
				Array<{
					id: string;
					summary: string;
					issues?: string[];
					testsStatus?: "passing" | "failing" | "not_run";
					createdAt: string;
				}>
			>();

			for (const report of allReports) {
				if (
					!["issues_found", "completed_with_issues", "needs_review"].includes(
						report.status,
					)
				) {
					continue;
				}
				const createdAtMs = new Date(report.createdAt).getTime();
				if (!Number.isFinite(createdAtMs) || createdAtMs <= oneDayAgoMs) {
					continue;
				}
				const existing = reportsByTask.get(report.taskId) || [];
				existing.push({
					id: report.id,
					summary: report.summary,
					issues: report.issues,
					testsStatus: report.testsStatus,
					createdAt: report.createdAt,
				});
				reportsByTask.set(report.taskId, existing);
			}

			for (const task of completedTasks) {
				if (
					task.subject.startsWith("Validate completion:") ||
					task.subject.startsWith("Verify & Polish:")
				) {
					continue;
				}

				const verifySubject = `Verify & Polish: ${task.subject}`;
				if (verifySubjects.has(verifySubject)) {
					continue;
				}
				const taskReports = reportsByTask.get(task.id);
				if (!taskReports || taskReports.length === 0) {
					continue;
				}
				taskReports.sort(
					(a, b) =>
						new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
				);
				const latest = taskReports[0]!;
				const verifyTask = await this.createVerificationTaskFromReEval(
					{
						id: task.id,
						subject: task.subject,
						classification: task.classification || "development",
						domain: task.domain,
						priority: task.priority,
					},
					{
						id: latest.id,
						summary: latest.summary,
						issues: latest.issues || [],
						testsStatus: latest.testsStatus,
					},
				);
				if (verifyTask) {
					verificationTasksCreated++;
					verifySubjects.add(verifySubject);
					this.log(
						`Re-evaluation: Created verification task for "${task.subject}"`,
					);
				}
			}

			const allTasks = await this.listTasksFromApi({ limit: 500 });
			const taskStatusById = new Map(
				allTasks.map((task) => [task.id, task.status] as const),
			);
			const candidates = allTasks
				.filter(
					(task) =>
						task.dependencyBlocked &&
						(task.status === "pending" || task.status === "blocked"),
				)
				.slice(0, 10);

			let unblockedCount = 0;
			for (const task of candidates) {
				const dependencies = await this.getTaskDependenciesFromApi(task.id);
				const ready = dependencies.every(
					(depId) => taskStatusById.get(depId) === "completed",
				);
				if (!ready) continue;

				const updated = await this.patchTaskViaApi(task.id, {
					dependencyBlocked: false,
					status: "pending",
				});
				if (!updated) continue;

				const inMemoryTask = this.tasks.find((t) => t.id === task.id);
				if (inMemoryTask) {
					inMemoryTask.status = "pending";
					inMemoryTask.updatedAt = new Date();
				}

				unblockedCount++;
				this.log(`Re-evaluation: Unblocked task "${task.subject}"`);
				this.logActivity("brain", "task_unblocked", task.id, {
					reason: "dependencies_satisfied",
					subject: task.subject,
				});
			}

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
		},
	): Promise<Task | null> {
		const taskId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		const issuesList =
			report.issues.length > 0
				? `## Issues to Address\n${report.issues.map((i) => `- ${i}`).join("\n")}\n\n`
				: "";

		const testInfo =
			report.testsStatus === "failing"
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

		const verifyTask =
			(await this.createTaskViaApi({
				id: taskId,
				subject: `Verify & Polish: ${originalTask.subject}`,
				description,
				status: "pending",
				priority: originalTask.priority === "critical" ? "critical" : "high",
				classification: "qa",
				domain: originalTask.domain,
				sourceType: "system",
				sourceRef: originalTask.id,
				context: {
					notes: `Follow-up verification for ${originalTask.id}. Status report: ${report.id}`,
				},
			})) ||
			({
				id: taskId,
				subject: `Verify & Polish: ${originalTask.subject}`,
				description,
				status: "pending",
				priority: originalTask.priority === "critical" ? "critical" : "high",
				classification: "qa",
				domain: originalTask.domain,
				createdAt: new Date(),
				updatedAt: new Date(),
			} as Task);

		this.logActivity("brain", "verification_task_created", taskId, {
			originalTaskId: originalTask.id,
			issueCount: report.issues.length,
			testsStatus: report.testsStatus,
			source: "re_evaluation",
		});

		return verifyTask;
	}

	private async loadArms(): Promise<void> {
		const armsFromApi = await this.listArmsFromApi(true);

		if (armsFromApi.length === 0) {
			const apiAvailable = await this.isApiServerAvailable();
			if (!apiAvailable) {
				this.log("Failed to load arms from API");
				return;
			}
		}

		this.arms.clear();
		for (const row of armsFromApi) {
			if (row.status === "stopped") continue;

			const arm: Arm = {
				id: row.id,
				name: row.name,
				agent: row.harness,
				status: row.status as Arm["status"],
				pid: row.pid,
				provider: row.provider,
				model: row.model,
				currentTask: row.currentTaskId || undefined,
				startedAt: new Date(row.createdAt || new Date().toISOString()),
				lastActivity: row.lastActivityAt
					? new Date(row.lastActivityAt)
					: undefined,
			};
			(arm as Arm & { domain?: string }).domain = row.domain;
			this.arms.set(arm.id, arm);

			// Ensure arm has state machine entry
			if (this.armStateMachine) {
				const ctx = this.armStateMachine.getContext(arm.id);
				if (!ctx) {
					// Initialize state based on current arm status
					const initialState =
						row.status === "busy"
							? "working"
							: row.status === "idle"
								? "idle"
								: row.status === "starting"
									? "starting"
									: "idle";
					this.armStateMachine.initializeArm(arm.id, initialState as ArmState);
				}
			}
		}
		this.log(`Loaded ${this.arms.size} active arms from API`);
	}

	private async saveArms(): Promise<void> {
		for (const arm of this.arms.values()) {
			const now = new Date().toISOString();

			// Try API first
			const apiResult = await this.apiRequest<{ arm: unknown }>(
				`/api/arms/${arm.id}`,
				{
					method: "PATCH",
					body: JSON.stringify({
						status: arm.status,
						lastActivityAt: arm.lastActivity?.toISOString() || now,
					}),
				},
			);

			if (!apiResult) {
				this.log(`Failed to persist arm state via API for ${arm.id}`);
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

	private getArmStatusRows(): ArmStatusRow[] {
		const healthResults = this.lastHealthCheck?.armResults;
		const rows: ArmStatusRow[] = [];

		for (const arm of this.arms.values()) {
			const task = this.tasks.find((t) => t.id === arm.currentTask);
			const taskSummary = task?.subject || arm.currentTask || "-";
			const analysis = healthResults?.get(arm.id);
			const health = analysis
				? `${analysis.state} (${analysis.confidence})${analysis.reason ? `: ${analysis.reason}` : ""}`
				: "unknown";

			rows.push({
				name: arm.name || arm.id,
				status: arm.status || "unknown",
				task: taskSummary,
				health,
			});
		}

		rows.sort((a, b) => a.name.localeCompare(b.name));
		return rows;
	}

	private refreshDashboard(): void {
		if (!this.dashboard || !this.dashboard.isEnabled()) return;
		this.dashboard.setArms(this.getArmStatusRows());
		this.dashboard.render();
	}

	private async clearArmTaskAssignment(armId: string): Promise<void> {
		const now = new Date().toISOString();
		await this.patchArmViaApi(armId, {
			status: "idle",
			currentTaskId: null,
			currentTaskSubject: null,
			lastActivityAt: now,
		});

		const arm = this.arms.get(armId);
		if (arm) {
			arm.status = "idle";
			arm.currentTask = undefined;
			arm.lastActivity = new Date();
		}
	}

	private log(message: string): void {
		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] ${message}`;

		if (this.dashboard?.isEnabled()) {
			this.dashboard.addLogLine(line);
			this.refreshDashboard();
		} else if (this.options.verbose) {
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

			this.abortController.signal.addEventListener("abort", abortHandler, {
				once: true,
			});
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
	private async handleDocUpdateTrigger(
		trigger: "threshold" | "periodic",
	): Promise<void> {
		if (!this.docTracker) return;

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
		await this.createTaskViaApi({
			id: taskId,
			subject: "Documentation Sync: Feature Docs Alignment",
			description,
			status: "pending",
			priority: "normal",
			domain: "docs",
			classification: "documentation",
			sourceType: "system",
			sourceRef: "doc-update",
			context: {
				notes: JSON.stringify({
					triggerType: trigger,
					filesChanged: context.filesChanged,
					featureDocsToUpdate: context.featureDocsToUpdate,
					changedFilesCount: context.changedFilesCount,
				}),
			},
		});

		// Create doc update record
		const docUpdateId = await this.docTracker.createDocUpdate(taskId, trigger);
		await this.docTracker.startDocUpdate(docUpdateId);

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
${context.filesChanged
	.slice(0, 10)
	.map((f) => `- ${f}`)
	.join("\n")}
${context.filesChanged.length > 10 ? `- ... and ${context.filesChanged.length - 10} more` : ""}

### Feature Docs to Review
${
	context.featureDocsToUpdate.length > 0
		? context.featureDocsToUpdate.map((d) => `- ${d}`).join("\n")
		: "No specific feature docs identified - review general docs for accuracy."
}

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

	/**
	 * Find files larger than specified threshold
	 */
	private async findLargeFiles(
		threshold: number,
	): Promise<Array<{ path: string; lines: number }>> {
		try {
			const { execSync } = await import("child_process");

			const cwd = process.cwd();

			const output = execSync(
				`find "${cwd}/src" -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \\) ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" -exec wc -l {} + 2>/dev/null | sort -rn`,
				{ encoding: "utf-8" },
			);

			const lines = output.trim().split("\n");
			const largeFiles: Array<{ path: string; lines: number }> = [];

			for (const line of lines) {
				const match = line.match(/^\s*(\d+)\s+(.+)$/);
				if (match && match[1] && match[2]) {
					const lineCount = parseInt(match[1], 10);
					const filePath = match[2].trim();

					if (lineCount > threshold) {
						largeFiles.push({ path: filePath, lines: lineCount });
					}
				}
			}

			return largeFiles;
		} catch (err) {
			this.log(`Error finding large files: ${err}`);
			return [];
		}
	}

	/**
	 * Build refactoring task description
	 */
	private buildRefactoringDescription(
		files: Array<{
			path: string;
			lines: number;
			gitStatus?: { staged: boolean; modified: boolean; untracked: boolean };
		}>,
	): string {
		const formatGitStatus = (status?: {
			staged: boolean;
			modified: boolean;
			untracked: boolean;
		}): string => {
			if (!status) return "unknown";
			const flags: string[] = [];
			if (status.staged) flags.push("staged");
			if (status.modified) flags.push("modified");
			if (status.untracked) flags.push("untracked");
			return flags.length > 0 ? flags.join(", ") : "clean";
		};

		const tableRows = files
			.map((f) => {
				const relPath = f.path.replace(process.cwd() + "/", "");
				let priority = "normal";
				if (f.lines > 600) priority = "high";
				if (f.lines > 800) priority = "critical";
				return `| \`${relPath}\` | ${f.lines} | **${priority}** | ${formatGitStatus(f.gitStatus)} |`;
			})
			.join("\n");

		const hasCriticalFiles = files.some((f) => f.lines > 800);
		const hasHighPriorityFiles = files.some(
			(f) => f.lines > 600 && f.lines <= 800,
		);
		const hasMediumFiles = files.some((f) => f.lines > 400 && f.lines <= 600);

		return `## Refactoring Task

### Prerequisites (VERIFY FIRST)
- [ ] Run \`git status --porcelain\` and confirm target files are clean (no modified/staged/untracked)
- [ ] Confirm the API server and brain are running (health checks pass)
- [ ] Confirm files are checked in before making changes
- [ ] Check no other arms have active claims on these files

### Files to Refactor

| File | Lines | Priority | Git status |
|------|-------|----------|------------|
${tableRows}

### File Size Rules

| Threshold | Action |
|-----------|--------|
| >400 lines | Flag for refactoring |
| >600 lines | High priority refactoring |
| >800 lines | Critical - block new work on file until refactored |

${hasCriticalFiles ? "⚠️ **CRITICAL**: Files >800 lines detected. These files are too large for effective LLM processing. Refactor with highest priority.**" : ""}
${hasHighPriorityFiles ? "💡 **High Priority**: Files >600 lines should be refactored soon to maintain code quality.**" : ""}
${hasMediumFiles ? "📋 **Medium Priority**: Files >400 lines should be refactored when convenient.**" : ""}

### Guidelines

When refactoring large files:

1. **Extract functions/classes**: Break down monolithic functions into smaller, focused units
2. **Separate concerns**: Move distinct functionality to separate modules or files
3. **Maintain tests**: Ensure all existing tests pass after refactoring
4. **Document rationale**: Add comments explaining the refactoring choices

### Escalation Rules

- If an arm attempts to edit a file >800 lines, the Brain will block the edit and require refactoring first
- Files >600 lines will trigger high-priority refactoring tasks automatically
- Files between 400-600 lines will be flagged during the regular refactoring cycle (every 5 completed tasks)`;
	}

	/**
	 * Create a refactoring task for large files
	 */
	private async createRefactoringTask(
		files: Array<{
			path: string;
			lines: number;
			gitStatus?: { staged: boolean; modified: boolean; untracked: boolean };
		}>,
	): Promise<void> {
		try {
			const taskId = `refactor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

			const maxLines = Math.max(...files.map((f) => f.lines));
			let priority: "critical" | "high" | "normal" | "low" = "normal";
			if (maxLines > 800) priority = "critical";
			else if (maxLines > 600) priority = "high";
			else if (maxLines > 400) priority = "normal";

			const description = this.buildRefactoringDescription(files);

			await this.createTaskViaApi({
				id: taskId,
				subject: `Refactor large files (${files.length} files)`,
				description,
				status: "pending",
				priority,
				classification: "refactoring",
				domain: "refactoring",
				sourceType: "system",
				sourceRef: "refactoring-cycle",
			});

			this.log(
				`Created refactoring task: ${taskId} (count: ${files.length}, priority: ${priority})`,
			);
			this.logActivity("brain", "refactoring_task_created", taskId, {
				fileCount: files.length,
				priority,
				maxLines,
			});
		} catch (err) {
			this.log(`Error creating refactoring task: ${err}`);
		}
	}
}
