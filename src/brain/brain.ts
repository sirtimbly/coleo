/**
 * Brain - The central coordinator for Coleo
 *
 * Runs a polling loop that:
 * 1. Reads human mail from sent/
 * 2. Processes arm messages from API queue
 * 3. Assigns tasks to arms
 * 4. Sends status updates to human inbox
 */

import { readFile, mkdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { Maildir, type MailMessage } from "../mail";
import { getDocWatcher, stopDocWatcher } from "../docs/watcher";
import {
	parsePlanFile,
	findPlanFiles,
	tasksToDatabaseFormat,
	type PlanParseResult,
} from "./plan-parser";
import { parseInbox, clearInbox, deduplicateItems } from "./inbox-parser";
import { DocUpdateTracker } from "./doc-tracker";
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
import {
	ArmOutputProcessor,
	type ArmOutputDecision,
} from "./arm-output-processor";
import { StuckArmAnalyzer, type StuckAnalysis } from "./activity-analyzer";
import { TerminalDashboard, type ArmStatusRow } from "./terminal-dashboard";
import { createArmStateApiDatabase } from "./arm-state-api-db";
import { findLargeFiles as findLargeFilesUtil } from "./utils/find-large-files";
import {
	stripTerminalArtifacts,
	getDomainPatterns,
	isActiveHarnessState,
	toEpochMs,
	extractMessageTimestampMs,
	humanizeStatus,
	normalizeTaskPriority,
	normalizeBugPriority,
	mapApiTask,
	isSessionMessage,
} from "./brain-utils";
import type { SessionMessage } from "./brain-utils";
import type { ArmStateStore } from "./db-client";
import type {
	BrainState,
	Task,
	QueueMessage,
	Arm,
	Discovery,
	MessageType,
	TaskAttachment,
} from "../types";
import { isBrainInboxMessageType } from "../types/brain-inbox";
import { appendTaskAttachmentsToPromptText } from "../lib/prompt-attachments";
import {
	buildCommitTaskSubject,
	buildValidationTaskSubject,
	buildVerificationTaskSubject,
	isFollowUpTaskSubject,
	isValidationTaskSubject,
	isVerificationTaskSubject,
} from "./task-subjects";
import {
	type BrainOptions,
	isTaskAttachment,
	pathMatchesPattern,
	buildDocUpdateDescription,
	buildCommitTaskDescription,
	buildVerificationTaskDescription,
	type DocUpdateContext,
} from "./brain-types";
export { type BrainOptions } from "./brain-types";
import {
	createApiClient,
	logActivityViaApi,
	publishEventViaApi,
	queueMessageViaApi,
	listPendingMessagesViaApi,
	markMessageStatusViaApi,
} from "./brain-api-client";
import {
	listTasksFromApi,
	getTaskFromApi,
	createTaskViaApi,
	patchTaskViaApi,
	listStatusReportsFromApi,
	getTaskSubjectFromApi,
} from "./brain-task-client";
import {
	listBugsFromApi,
	getBugFromApi,
	createBugViaApi,
	patchBugViaApi,
	determineBugPriority,
	formatBugReport,
} from "./brain-bug-handler";

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
	private refactorFileThresholdLines = 400;
	private templates: BrainTemplateManager;
	private mailProcessor: MailProcessor;
	private armOutputProcessor: ArmOutputProcessor;
	private stuckArmAnalyzer: StuckArmAnalyzer;
	private docTracker: DocUpdateTracker | null = null;
	private armStateMachine: ArmStateMachine | null = null;
	private healthMonitor: ArmHealthMonitor | null = null;
	private lastHealthCheck: HealthCheckResult | null = null;
	private dashboard: TerminalDashboard | null = null;

	private lastStuckState: Map<
		string,
		{ stuckType: string; escalatedAt: Date }
	> = new Map();
	private idleArmPromptTracker: Map<
		string,
		{
			promptCount: number;
			lastPromptAt: Date;
			lastProductiveAt: Date | null;
			escalationLevel: number;
		}
	> = new Map();
	private armDetectionTimes: Map<string, Date> = new Map();
	private processedArmOutputMessageIds: Map<string, Set<string>> = new Map();
	private processedStatusReportIds: Set<string> = new Set();
	private processedDiscoveryIds: Set<string> = new Set();
	private fileSubscriptions: Map<string, Set<string>> = new Map();
	private planFileHashes: Map<string, string> = new Map();
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

	// Claims system integration config
	private resolveClaimsActive = false; // Config flag for active claim resolution (default: false)

	// Mail config for external email sending
	private mailConfig: { fromAddress: string; toAddress: string } | null = null;

	/**
	 * Log an activity entry via API (API handles JetStream persistence).
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

		void this.apiRequest<{ entry?: unknown }>(
			"/api/activity",
			{
				method: "POST",
				body: JSON.stringify({
					actor,
					action,
					target,
					details: details || {},
				}),
			},
			1500,
		);
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
		this.armOutputProcessor = new ArmOutputProcessor((msg) => this.log(msg));

		// Initialize stuck arm analyzer
		this.stuckArmAnalyzer = new StuckArmAnalyzer(
			(msg) => this.log(msg),
			this.options.coleoDir,
		);

		// Initialize terminal dashboard (TTY only)
		this.dashboard = new TerminalDashboard({ enabled: process.stdout.isTTY });
	}

	/**
	 * Load mail configuration from API
	 */
	private async loadMailConfig(): Promise<void> {
		try {
			const response = await this.apiRequest<{
				mail: { fromAddress: string; toAddress: string };
			}>("/api/config/mail", {}, 5000);
			if (response?.mail?.toAddress) {
				this.mailConfig = {
					fromAddress: response.mail.fromAddress || "brain@coleo.dev",
					toAddress: response.mail.toAddress,
				};
				this.log(`Mail config loaded: ${this.mailConfig.fromAddress} -> ${this.mailConfig.toAddress}`);
			}
		} catch (err) {
			this.log(`Failed to load mail config: ${err}`);
		}
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

	private async listRecentActivitySummary(limit: number): Promise<string[]> {
		const response = await this.apiRequest<{
			activity?: Array<{
				actor?: string;
				action?: string;
				target?: string | null;
			}>;
		}>(`/api/activity?limit=${Math.max(1, limit)}`, {}, 1500);
		const activity = response?.activity || [];
		return activity
			.filter((entry) => typeof entry.action === "string" && entry.action.trim())
			.map((entry) => {
				const actor = entry.actor || entry.target || "unknown";
				return `${actor} ${entry.action}`;
			});
	}

	private async publishEventViaApi(event: {
		subject: string;
		type: string;
		armId?: string;
		data: Record<string, unknown>;
		timestamp?: string;
	}): Promise<void> {
		await this.apiRequest<{ published?: boolean }>(
			"/api/events/internal/publish",
			{
				method: "POST",
				body: JSON.stringify({
					...event,
					timestamp: event.timestamp || new Date().toISOString(),
				}),
			},
			1500,
		);
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
		const response = await this.apiRequest<{ accepted?: boolean; queued?: boolean }>(
			"/api/brain/internal/commands/publish",
			{
				method: "POST",
				body: JSON.stringify(input),
			},
		);
		return response?.accepted === true || response?.queued === true;
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
	): Promise<boolean> {
		const response = await this.apiRequest<{ success?: boolean }>(
			`/api/brain/internal/messages/${encodeURIComponent(messageId)}/status`,
			{
				method: "POST",
				body: JSON.stringify({ status, error }),
			},
		);
		return response?.success === true;
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
			config.refactoring.fileSizeThreshold ?? 400;

		// Load mail config for external email sending
		await this.loadMailConfig();

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
				startupGracePeriodMs: 2 * 60 * 1000, // 2 minutes
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

		const previousLastPollAt = this.state.lastPollAt;
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

		// API is required for this tick. Wait for next poll when unavailable.
		if (!infraHealth.components.apiServer.healthy) {
			this.log("CRITICAL: API server unhealthy, skipping poll cycle");
			return;
		}

		// If database is down, we can't do anything meaningful
		if (!infraHealth.components.database.healthy) {
			this.log("CRITICAL: Database unhealthy, skipping poll cycle");
			return;
		}

		// Step 1: Check for new human messages
		if (infraHealth.components.maildir.healthy) {
			await this.processHumanMail();
		}

		// Step 2: Process arm messages
		await this.processArmQueue();

		// Step 2.25: Evaluate recently persisted status reports and discoveries
		// so reports visible in the dashboard also influence planning even when
		// they were not handled through the live arm queue path.
		await this.processOperationalSignals(previousLastPollAt);

		// Step 2.5: Check for resolved bugs and resume blocked tasks
		await this.checkResolvedBugsAndResumeTasks();

		// Steps 3-6 require API server for arm communication
		if (infraHealth.canWorkWithArms) {
			// Step 3: Check arm health and detect new arms
			await this.checkArms();

			// Refresh tasks from database before assignment
			await this.loadTasks();

			// Step 3.5: Interpret recent assistant output from arms for
			// brain-side follow-up actions (task/bug/task-update) and reply prompts.
			await this.processArmAssistantOutputs();

			// Refresh tasks in case assistant-output processing changed task state.
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

		// Step 9: Prompt idle arms at the end of the cycle.
		// This avoids racing with task/status updates handled earlier in the same poll.
		if (infraHealth.canWorkWithArms) {
			await this.promptIdleArms();
		}

		// Step 10: Save state
		await this.saveState();

		// Step 11: Notify Observatory of poll completion
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

		await this.notifyObservatory("started");
		await this.poll();

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
	 * Process new mail from human (in inbox folder - via Postmark inbound)
	 */
	private isColeoGeneratedMail(message: MailMessage): boolean {
		const type = Object.entries(message.headers).find(
			([header]) => header.toLowerCase() === "x-coleo-type",
		)?.[1];
		return Boolean(type && type.toLowerCase() !== "human-message");
	}

	private getMailHeader(message: MailMessage, name: string): string | undefined {
		const normalizedName = name.toLowerCase();
		const value = Object.entries(message.headers).find(
			([header]) => header.toLowerCase() === normalizedName,
		)?.[1];
		return value?.trim() || undefined;
	}

	private getMailMessageId(message: MailMessage): string {
		return this.getMailHeader(message, "message-id") ?? message.id;
	}

	private getMailThreadId(message: MailMessage): string {
		return (
			this.getMailHeader(message, "x-coleo-thread-id") ??
			this.getMailHeader(message, "x-coleo-task-id") ??
			this.getMailHeader(message, "x-coleo-bug-id") ??
			this.getMailHeader(message, "x-coleo-request-id") ??
			this.getMailHeader(message, "in-reply-to") ??
			this.getMailMessageId(message)
		);
	}

	private buildMailReplyHeaders(
		message: MailMessage,
		type = "brain-reply",
		extraHeaders: Record<string, string> = {},
	): Record<string, string> {
		const messageId = this.getMailMessageId(message);
		const existingReferences = this.getMailHeader(message, "references");

		return {
			"X-Coleo-Type": type,
			"X-Coleo-Thread-Id": this.getMailThreadId(message),
			"In-Reply-To": messageId,
			References: existingReferences ? `${existingReferences} ${messageId}` : messageId,
			...extraHeaders,
		};
	}

	private async processHumanMail(): Promise<void> {
		const [inboxMessages, sentMessages] = await Promise.all([
			this.inbox.list("new"),
			this.sent.list("new"),
		]);
		const messages = [
			...inboxMessages
				.filter(
					(message) =>
						!message.from.toLowerCase().includes("brain@coleo.local") &&
						!this.isColeoGeneratedMail(message),
				)
				.map((message) => ({
					mailbox: this.inbox,
					source: "inbox" as const,
					message,
				})),
			...sentMessages
				.filter(
					(message) =>
						message.to.toLowerCase().includes("brain@coleo.local") &&
						!this.isColeoGeneratedMail(message),
				)
				.map((message) => ({
					mailbox: this.sent,
					source: "sent" as const,
					message,
				})),
		];

		if (messages.length === 0) return;

		this.log(`Processing ${messages.length} human message(s)...`);

		// Build context for LLM
		const armContexts = Array.from(this.arms.values()).map((arm) => ({
			name: arm.name,
			domain: (arm as Arm & { domain?: string }).domain || "general",
			status: arm.status,
		}));

		const recentActivity = await this.listRecentActivitySummary(5);
		const systemPrompt = await this.templates.loadMailProcessorSystemPrompt({
			availableArms: armContexts,
			pendingTasks: this.state.pendingTasks,
			recentActivity,
		});

		for (const entry of messages) {
			const { mailbox, message, source } = entry;
			this.log(`Processing: ${message.subject}`);
			const threadId = this.getMailThreadId(message);
			const attachments = this.parseMailAttachments(message);
			const taskContext =
				attachments.length > 0
					? ({ attachments } satisfies NonNullable<Task["context"]>)
					: undefined;
			const messageBody = appendTaskAttachmentsToPromptText(
				message.body,
				attachments,
			);

			// Use LLM to determine intent
			const intent = await this.mailProcessor.processMessage(
				message.subject,
				messageBody,
				systemPrompt,
			);

			this.log(`Intent: ${intent.type} (${intent.reasoning})`);

			// Handle the intent
			switch (intent.type) {
				case "new_task": {
					const task = await this.createTask(
						intent.subject || message.subject,
						intent.body || message.body,
						threadId,
						intent.priority,
						intent.domain,
						taskContext,
					);
					// Send confirmation reply
					await this.sendToHuman({
						subject: `Re: ${message.subject}`,
						body: `I've received your message and created a new task.\n\n**Task:** ${task.subject}\n**Priority:** ${task.priority}\n**Status:** ${task.status}\n\nI'll assign this to an appropriate arm and keep you updated on progress.`,
						headers: this.buildMailReplyHeaders(message, "task-created", {
							"X-Coleo-Task-Id": task.id,
						}),
					});
					break;
				}

				case "doc_update": {
					const docTask = await this.createDocUpdateTask(
						intent.subject || message.subject,
						intent.body || message.body,
						intent.targetDoc,
						threadId,
						taskContext,
					);
					// Send confirmation reply
					await this.sendToHuman({
						subject: `Re: ${message.subject}`,
						body: `I've received your documentation update request.\n\n**Target:** ${intent.targetDoc || "documentation"}\n**Task:** ${docTask.subject}\n**Priority:** ${docTask.priority}\n\nI'll have an arm update the documentation and notify you when complete.`,
						headers: this.buildMailReplyHeaders(message, "doc-task-created", {
							"X-Coleo-Task-Id": docTask.id,
						}),
					});
					break;
				}

				case "bug_report":
					// Note: createHumanBugReport already sends a confirmation email
					await this.createHumanBugReport(
						intent.title || message.subject,
						appendTaskAttachmentsToPromptText(
							intent.description || message.body,
							attachments,
						),
						threadId,
						this.buildMailReplyHeaders(message, "bug-confirmation"),
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
						headers: this.buildMailReplyHeaders(message, "approval-response"),
					});
					break;
				}

				case "query":
					await this.handleQuery(
						intent.query || "status",
						this.buildMailReplyHeaders(message, "status"),
					);
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
								threadId,
								intent.priority,
								undefined,
								taskContext,
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
								threadId,
								intent.priority,
								undefined,
								taskContext,
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
								headers: this.buildMailReplyHeaders(message, "task-queued-busy"),
							});
						} else {
							// Arm is idle, can prompt directly
							await this.sendPromptToArm(intent.armName, intent.instruction, {
								attachments,
							});
							this.log(`Prompted arm ${intent.armName} directly`);
							this.logActivity("brain", "arm_prompted", intent.armName, {
								reason: "human_mail",
								source,
								attachmentCount: attachments.length,
								instruction: intent.instruction.slice(0, 100),
							});
							// Send confirmation reply
							await this.sendToHuman({
								subject: `Re: ${message.subject}`,
								body: `I've received your request and prompted **${intent.armName}** directly.\n\nThe arm is working on:\n\n${intent.instruction.slice(0, 200)}${intent.instruction.length > 200 ? "..." : ""}\n\nYou'll receive updates as the arm progresses.`,
								headers: this.buildMailReplyHeaders(message, "arm-prompted", {
									"X-Coleo-Arm": intent.armName,
								}),
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
						headers: this.buildMailReplyHeaders(message, "mail-escalate"),
					});
					break;
				}

				default:
					this.log(`Unknown intent type: ${(intent as { type: string }).type}`);
			}

			// Mark as processed
			await mailbox.markSeen(message.id);
		}
	}

	private parseMailAttachments(message: MailMessage): TaskAttachment[] {
		const raw = message.headers["x-coleo-attachments"];
		if (!raw) {
			return [];
		}

		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) {
				return [];
			}

			return parsed.filter(isTaskAttachment);
		} catch (err) {
			this.log(
				`Failed to parse attachments for mail ${message.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return [];
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
		context?: Task["context"],
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
				context,
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
				context,
			} as Task);

		this.log(
			`Created task: ${task.subject} (${task.id}) domain=${domain || "any"} priority=${task.priority}`,
		);
		this.logActivity("brain", "task_created", task.id, {
			subject,
			priority: task.priority,
			domain,
			mailThreadId,
			attachmentCount: context?.attachments?.length || 0,
		});

		return task;
	}

	/**
	 * Process messages from arms (API queue is the single ingress channel)
	 */
	private async processArmQueue(): Promise<void> {
		// Process messages from API queue
		try {
			const messages = await this.listPendingMessagesViaApi("brain", 500);
			for (const message of messages) {
				try {
					const leased = await this.markMessageStatusViaApi(
						message.id,
						"processing",
					);
					if (!leased) {
						continue;
					}

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
	}

	/**
	 * Handle a message from an arm
	 */
	private async handleArmMessage(message: QueueMessage): Promise<void> {
		if (!isBrainInboxMessageType(message.type)) {
			this.log(`Ignoring unsupported brain inbox message type: ${message.type}`);
			return;
		}

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

			case "task_acknowledge": {
				const payload = message.payload as {
					taskId: string;
					screenshotPath?: string;
					screenshot_path?: string;
				};
				await this.updateTaskStatus(
					message.from,
					payload.taskId,
					"in_progress",
					undefined,
					payload.screenshot_path || payload.screenshotPath,
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

			case "task_validate": {
				const payload = message.payload as {
					taskId: string;
					approved: boolean;
					notes: string;
					screenshotPath?: string;
					screenshot_path?: string;
				};
				await this.handleTaskValidation(
					payload.taskId,
					message.from,
					payload.approved,
					payload.notes,
					payload.screenshot_path || payload.screenshotPath,
				);
				break;
			}

			case "task_deleted": {
				const payload = message.payload as {
					taskId: string;
					projectId: string;
					featureId: string;
					deletedBy: string;
					timestamp: string;
				};
				await this.handleTaskDeletion(payload);
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

		await this.publishEventViaApi({
			subject: `coleo.events.arm.${armId}.dependency_discovered`,
			type: "dependency_discovered",
			armId,
			data: {
				taskId: payload.taskId,
				dependsOn: payload.dependsOn,
				dependencyType: payload.type,
				description: payload.description,
				severity: payload.severity,
			},
		});
	}

	/**
	 * Handle task deletion notification from API
	 * 
	 * Performs idempotent cleanup of project plans when a task is deleted.
	 * The API attempts to remove the feature from plan files before notifying
	 * the Brain. This handler verifies the cleanup and handles any additional
	 * processing needed (reindexing, logging, etc.).
	 */
	private async handleTaskDeletion(payload: {
		taskId: string;
		projectId: string;
		featureId: string;
		deletedBy: string;
		timestamp: string;
	}): Promise<void> {
		const { taskId, projectId, featureId, deletedBy, timestamp } = payload;
		
		this.log(`Processing task deletion: ${taskId} (feature: ${featureId})`);

		try {
			// Idempotent verification: Check if feature still exists in plan files
			// The API should have already removed it, but we verify here
			const cleanupNeeded = await this.verifyAndCleanupPlanFeature(projectId, featureId);
			
			if (cleanupNeeded) {
				this.log(`Cleaned up feature ${featureId} from project plan ${projectId}`);
			}

			// Log the deletion activity
			this.logActivity("brain", "task_deleted", taskId, {
				projectId,
				featureId,
				deletedBy,
				timestamp,
				planCleanupNeeded: cleanupNeeded,
			});

			// Publish deletion event for other consumers
			await this.publishEventViaApi({
				subject: `coleo.events.task.${taskId}.deleted`,
				type: "task.deleted",
				data: {
					taskId,
					projectId,
					featureId,
					deletedBy,
					timestamp,
					planCleaned: cleanupNeeded,
				},
			});

			this.log(`Task deletion processed successfully: ${taskId}`);
		} catch (err) {
			// Log error but don't throw - deletion notification should not fail the overall flow
			this.log(`Error processing task deletion for ${taskId}: ${err}`);
			
			// Log activity about the failure for monitoring
			this.logActivity("brain", "task_deletion_failed", taskId, {
				projectId,
				featureId,
				error: err instanceof Error ? err.message : String(err),
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * Verify and cleanup a feature from project plan files
	 * 
	 * Returns true if cleanup was performed, false if feature was already absent
	 */
	private async verifyAndCleanupPlanFeature(
		projectId: string,
		featureId: string,
	): Promise<boolean> {
		try {
			// Determine the plan file path
			let planFilePath: string;
			
			// Extract file path from projectId (format: "/path/to/file:lineNumber")
			const sourceRefMatch = projectId.match(/^(.+):\d+$/);
			if (sourceRefMatch?.[1]) {
				planFilePath = sourceRefMatch[1];
			} else if (projectId === "default" || !projectId.includes("/")) {
				// No specific plan file to check
				return false;
			} else {
				// Treat projectId as file path directly
				planFilePath = projectId;
			}

			// Import the plan parser dynamically to avoid circular deps
			const { removeTaskLineFromPlan } = await import("./plan-parser");
			
			// Attempt to remove the line - this is idempotent (returns false if not found)
			const removed = await removeTaskLineFromPlan(planFilePath, featureId);
			
			return removed;
		} catch (err) {
			// If file doesn't exist or other error, log but don't fail
			this.log(`Could not verify/cleanup plan feature ${featureId}: ${err}`);
			return false;
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
		mailThreadId?: string,
		context?: Task["context"],
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
				context,
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
				context,
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
		replyHeaders?: Record<string, string>,
	): Promise<void> {
		const bugPayload = {
			id: `bug-human-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			title,
			description,
			source: "human_reported" as const,
			sourceTaskId: undefined, // Human reports don't have associated tasks
			errorDetails: undefined,
		};

		const result = await this.handleBugReport("human", bugPayload);
		if (!result) {
			return;
		}

		this.log(
			result.deduplicated
				? `Matched existing human bug report: ${title} (${result.bugId})`
				: `Created human bug report: ${title}`,
		);
		this.logActivity("brain", "bug_created", result.bugId, {
			title,
			source: "human_reported",
			mailThreadId,
			deduplicated: result.deduplicated,
		});

		if (result.deduplicated) {
			return;
		}

		// Send confirmation to human
		const body = await this.templates.renderTemplate(
			"human-bug-report-confirmation.jinja",
			{
				bug_id: result.bugId,
				title,
			},
		);
		await this.sendToHuman({
			subject: `[coleo] Bug Report Received: ${title}`,
			body,
			headers: {
				...(replyHeaders ?? {}),
				"X-Coleo-Type": "bug-confirmation",
				"X-Coleo-Bug-Id": result.bugId,
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
			const statusLabel = humanizeStatus(status);
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

	/**
	 * Fetch a single task from the API server.
	 */
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

		return response.tasks.map((task) => mapApiTask(task));
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

		return mapApiTask(response.task);
	}

	private async patchTaskViaApi(
		taskId: string,
		patch: {
			subject?: string;
			description?: string;
			status?: Task["status"];
			priority?: Task["priority"];
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

		return mapApiTask(response.task);
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

		return mapApiTask(response.task);
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
		since?: string;
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
			if (options?.since) params.set("since", options.since);

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

	private async listDiscoveriesFromApi(options?: {
		limit?: number;
		status?: string;
		since?: string;
	}): Promise<
		Array<{
			id: string;
			armId: string;
			armName: string;
			kind: string;
			title: string;
			details: string;
			filePath?: string | null;
			lineNumber?: number | null;
			severity: string;
			status: string;
			taskId?: string | null;
			phase?: string | null;
			createdAt: string;
			updatedAt: string;
		}>
	> {
		const params = new URLSearchParams({
			limit: String(Math.max(1, options?.limit ?? 100)),
			status: options?.status || "open",
		});
		if (options?.since) params.set("since", options.since);

		const response = await this.apiRequest<{
			discoveries: Array<{
				id: string;
				armId: string;
				armName: string;
				kind: string;
				title: string;
				details: string;
				filePath?: string | null;
				lineNumber?: number | null;
				severity: string;
				status: string;
				taskId?: string | null;
				phase?: string | null;
				createdAt: string;
				updatedAt: string;
			}>;
		}>(`/api/discoveries?${params.toString()}`);

		return response?.discoveries || [];
	}

	private rememberProcessedSignal(
		cache: Set<string>,
		id: string,
		limit = 500,
	): void {
		cache.add(id);
		while (cache.size > limit) {
			const oldest = cache.values().next().value;
			if (!oldest) break;
			cache.delete(oldest);
		}
	}

	private async processOperationalSignals(since?: string): Promise<void> {
		const marker = since || new Date(Date.now() - 15 * 60 * 1000).toISOString();

		try {
			const [reports, discoveries] = await Promise.all([
				this.listStatusReportsFromApi({ limit: 100, since: marker }),
				this.listDiscoveriesFromApi({ limit: 100, status: "open", since: marker }),
			]);

			for (const report of reports
				.filter((item) => !this.processedStatusReportIds.has(item.id))
				.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
				await this.processPersistedStatusReport(report);
			}

			for (const discovery of discoveries
				.filter((item) => !this.processedDiscoveryIds.has(item.id))
				.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
				await this.processPersistedDiscovery(discovery);
			}
		} catch (err) {
			this.log(`Failed to process persisted operational signals: ${err}`);
		}
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

		const validationDescription = buildVerificationTaskDescription(
			task.subject,
			task.id,
			summary,
			artifacts,
		);

		const validationTask = await this.createTaskViaApi({
			subject: buildValidationTaskSubject(task.subject),
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

	private async markArmTaskCompletedAndRelease(
		armId: string,
		taskId: string,
	): Promise<void> {
		if (this.armStateMachine) {
			await this.armStateMachine.transition(armId, {
				type: "TASK_COMPLETED",
				taskId,
			});
		}

		await this.clearArmTaskAssignment(armId);
		await this.apiRequest(`/api/arms/${encodeURIComponent(armId)}/metrics`, {
			method: "POST",
			body: JSON.stringify({ currentTask: null }),
		});
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

		if (workerArmId) {
			await this.markArmTaskCompletedAndRelease(workerArmId, taskId);
		}

		await this.patchTaskViaApi(taskId, {
			status: "completed",
			artifacts,
			assignedTo: null,
			dependencyBlocked: false,
		});

		this.state.completedToday++;
		this.state.completedTaskCount++;

		const taskSubject =
			task?.subject || (await this.getTaskSubjectFromApi(taskId));

		// Log activity
		this.logActivity("brain", "task_completed", taskId, {
			subject: taskSubject,
			artifacts,
		});

		const mirroredEventData = {
			actor: "brain",
			taskId,
			subject: taskSubject,
			artifacts,
		};
		await this.publishEventViaApi({
			subject: `coleo.events.task.${taskId}.task.completed`,
			type: "task.completed",
			armId: workerArmId,
			data: mirroredEventData,
		});
		if (workerArmId) {
			await this.publishEventViaApi({
				subject: `coleo.events.arm.${workerArmId}.task.completed`,
				type: "task.completed",
				armId: workerArmId,
				data: mirroredEventData,
			});
		}

		this.completedTaskCount = this.state.completedTaskCount;

		// Check if automations are enabled and if refactoring should run
		if (await this.shouldRunRefactorAutomation()) {
			// Priority escalation: Check for high/critical priority files (>600 lines) immediately
			// Normal priority files (400-600 lines) are checked every 5 completed tasks
			const highPriorityFiles = await findLargeFilesUtil({
				rootDir: process.cwd(),
				minLines: 600,
				thresholds: { normal: 400, high: 600, critical: 800 },
				includeGitStatus: true,
			});

			if (highPriorityFiles.length > 0) {
				// Immediate escalation for high/critical priority files
				await this.createRefactoringTask(highPriorityFiles);
			} else if (this.completedTaskCount % 5 === 0) {
				// Regular cycle for normal priority files (400-600 lines)
				const normalPriorityFiles = await findLargeFilesUtil({
					rootDir: process.cwd(),
					minLines: this.refactorFileThresholdLines,
					thresholds: { normal: this.refactorFileThresholdLines },
					includeGitStatus: true,
				});
				if (normalPriorityFiles.length > 0) {
					await this.createRefactoringTask(normalPriorityFiles);
				}
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

		const isTerminalFollowUpTask = isFollowUpTaskSubject(taskSubject);

		// Terminal follow-up tasks should not generate additional commit tasks.
		if (!isTerminalFollowUpTask) {
			await this.createCommitTask(taskId, taskSubject, summary);
		}

		this.log(`Completed task: ${taskSubject}`);
	}

	/**
	 * Create a commit task to capture unstaged changes for a completed task
	 */
	private async createCommitTask(
		taskId: string,
		taskSubject: string,
		taskSummary: string,
	): Promise<void> {
		// Defense-in-depth: never create commit tasks for follow-up tasks
		if (isFollowUpTaskSubject(taskSubject)) {
			this.log(
				`Skipping commit task creation for follow-up task ${taskId} (${taskSubject})`,
			);
			return;
		}

		try {
			const commitTaskId = `commit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		const description = buildCommitTaskDescription(taskId, taskSubject, taskSummary);

			await this.createTaskViaApi({
				id: commitTaskId,
				subject: buildCommitTaskSubject(taskSubject),
				description,
				status: "pending",
				priority: "high",
				classification: "development",
				domain: "vcs",
				sourceType: "system",
				sourceRef: taskId,
				context: {
					notes: `Auto-generated commit task for completed task ${taskId}`,
				},
			});

			this.log(`Created commit task: ${commitTaskId} for task ${taskId}`);
			this.logActivity("brain", "commit_task_created", commitTaskId, {
				originalTaskId: taskId,
				subject: taskSubject,
			});
		} catch (err) {
			this.log(`Error creating commit task for ${taskId}: ${err}`);
		}
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
		const workerArmId = task.assignedTo || null;

		const isFollowUpTask = isFollowUpTaskSubject(task.subject);

		// Follow-up QA and commit tasks are terminal. Do not recursively generate
		// additional validation or commit work from them.
		if (isFollowUpTask) {
			this.log(
				`Skipping recursive follow-up generation for ${taskId} (${task.subject})`,
			);
			await this.finalizeTaskCompletion(taskId, summary, artifacts);
			if (workerArmId) {
				await this.handOffCompletedArm(workerArmId);
			}
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
			if (workerArmId) {
				await this.handOffCompletedArm(workerArmId);
			}
			return;
		}

		await this.initiateTaskValidation(taskId, summary, artifacts, task);
		if (workerArmId) {
			await this.handOffCompletedArm(workerArmId);
		}
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
	 * Get all status reports for a task (including on_track)
	 * Used for silent completion detection
	 */
	private async getAllStatusReportsForTask(taskId: string): Promise<
		Array<{
			id: string;
			status: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
			summary: string;
			issues?: string[];
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

		return response.reports.map((report) => ({
			id: report.id,
			status: report.status,
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
			this.rememberProcessedSignal(
				this.processedStatusReportIds,
				statusReportResponse.report.id,
			);
		} else {
			this.log(`Failed to persist status report ${report.id} via API`);
		}

		await this.applyStatusReportActions(
			{
				...report,
				id: statusReportResponse?.report?.id || report.id,
			},
			task,
		);
	}

	private async processPersistedStatusReport(report: {
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
	}): Promise<void> {
		const task = await this.getTaskFromApi(report.taskId);
		if (!task) {
			this.log(`Persisted status report for unknown task: ${report.taskId}`);
			this.rememberProcessedSignal(this.processedStatusReportIds, report.id);
			return;
		}

		await this.applyStatusReportActions(report, task);
		this.rememberProcessedSignal(this.processedStatusReportIds, report.id);
	}

	private async applyStatusReportActions(
		report: {
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
			screenshotPath?: string;
		},
		task: Task,
	): Promise<void> {
		const now = new Date().toISOString();
		const issues = report.issues || [];
		const blockers = report.blockers || [];
		const filesChanged = report.filesChanged || [];
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

		// Log activity
		this.logActivity("brain", "status_report_received", report.taskId, {
			reportId: report.id,
			armId: report.armId,
			status: report.status,
			issueCount: issues.length,
			blockerCount: blockers.length,
		});

		const armLabel = this.getArmDisplayName(report.armId);
		const statusLabel = humanizeStatus(report.status);
		const trimmedSummary = report.summary?.trim();
		const testsLabel = report.testsStatus
			? humanizeStatus(report.testsStatus)
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

		const filesSection = formatList("Files changed:", filesChanged);
		const issuesSection = formatList("Issues:", issues);
		const blockersSection = formatList("Blockers:", blockers);
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
								blockers.map((b) => `- ${b}`).join("\n") ||
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
								blockers.map((b) => `- ${b}`).join("\n") ||
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
					`Issues found in task ${task.subject}: ${issues.length} issues`,
				);

				// Only notify human if decision says to forward
				if (forwardDecision.shouldForward && issues.length > 0) {
					const body = await this.templates.renderTemplate(
						"human-issues-found.jinja",
					{
						arm_id: report.armId,
						task_subject: task.subject,
						issues_list: issues.map((i) => `- ${i}`).join("\n"),
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
							filesChanged.map((f) => `- ${f}`).join("\n") ||
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
					{ ...report, issues },
					!forwardDecision.shouldForward,
				);
				await this.handOffCompletedArm(report.armId);
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
				subject: buildVerificationTaskSubject(originalTask.subject),
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
				subject: buildVerificationTaskSubject(originalTask.subject),
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

		if (originalTask.assignedTo) {
			await this.markArmTaskCompletedAndRelease(
				originalTask.assignedTo,
				originalTask.id,
			);
		}

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
		const now = new Date().toISOString();
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
				taskId: discovery.taskId || null,
				phase: discovery.phase || null,
			}),
		});
		this.log(`Stored discovery: ${discovery.title} (${discovery.kind})`);
		this.rememberProcessedSignal(this.processedDiscoveryIds, discoveryId);

		await this.applyDiscoveryActions({
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
			taskId: discovery.taskId || null,
			phase: discovery.phase || null,
			createdAt: now,
			updatedAt: now,
		});
	}

	private async processPersistedDiscovery(discovery: {
		id: string;
		armId: string;
		armName: string;
		kind: string;
		title: string;
		details: string;
		filePath?: string | null;
		lineNumber?: number | null;
		severity: string;
		status: string;
		taskId?: string | null;
		phase?: string | null;
		createdAt: string;
		updatedAt: string;
	}): Promise<void> {
		await this.applyDiscoveryActions(discovery);
		this.rememberProcessedSignal(this.processedDiscoveryIds, discovery.id);
	}

	private async applyDiscoveryActions(discovery: {
		id: string;
		armId: string;
		armName: string;
		kind: string;
		title: string;
		details: string;
		filePath?: string | null;
		lineNumber?: number | null;
		severity: string;
		status: string;
		taskId?: string | null;
		phase?: string | null;
		createdAt: string;
		updatedAt: string;
	}): Promise<void> {
		const severity = discovery.severity || "info";
		const fileInfo = discovery.filePath
			? `${discovery.filePath}${discovery.lineNumber ? `:${discovery.lineNumber}` : ""}`
			: null;

		if (discovery.taskId) {
			const taskComment = [
				`Discovery (${severity}) from ${discovery.armName || discovery.armId}: ${discovery.title}`,
				discovery.details,
				fileInfo ? `File: ${fileInfo}` : null,
				discovery.phase ? `Phase: ${discovery.phase}` : null,
			]
				.filter((part): part is string => Boolean(part))
				.join("\n\n");
			await this.appendTaskComment(discovery.taskId, taskComment, {
				armId: discovery.armId,
			});

			const task = await this.getTaskFromApi(discovery.taskId);
			if (
				task?.assignedTo &&
				task.status === "in_progress" &&
				(severity === "warning" || severity === "error")
			) {
				const followupPrompt = [
					`A new ${severity} discovery was recorded for your active task \"${task.subject}\".`,
					`Title: ${discovery.title}`,
					discovery.details,
					fileInfo ? `File: ${fileInfo}` : null,
					"Adjust your plan accordingly and send an updated status report if this changes your execution strategy.",
				]
					.filter((part): part is string => Boolean(part))
					.join("\n\n");
				await this.sendPromptToArm(task.assignedTo, followupPrompt);
			}
		}

		if (severity === "error" || severity === "warning") {
			const body = await this.templates.renderTemplate(
				"human-discovery.jinja",
				{
					arm_id: discovery.armId,
					kind: discovery.kind,
					severity,
					details: discovery.details,
					file_info: discovery.filePath
						? `**File:** ${discovery.filePath}${discovery.lineNumber ? `:${discovery.lineNumber}` : ""}`
						: "",
				},
			);
			await this.sendToHuman({
					subject: `[coleo] Discovery: ${discovery.title}`,
					body,
					headers: {
						"X-Coleo-Type": "discovery",
						"X-Coleo-From": discovery.armId,
						"X-Coleo-Severity": severity,
					},
				});

			await this.handleBugReport("system", {
				id: `bug-${discovery.id}`,
				title: discovery.title,
				description: [
					discovery.details,
					fileInfo ? `File: ${fileInfo}` : null,
					discovery.phase ? `Phase: ${discovery.phase}` : null,
				]
					.filter((part): part is string => Boolean(part))
					.join("\n\n"),
				source: "system_detected",
				sourceTaskId: discovery.taskId || undefined,
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
		this.log(
			`Approval response for ${originalId}: ${approved ? "approved" : "rejected"}`,
		);
	}

	/**
	 * Handle a status query from human
	 */
	private async handleQuery(
		query: string,
		replyHeaders: Record<string, string>,
	): Promise<void> {
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
				headers: replyHeaders,
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
	): Promise<{ bugId: string; deduplicated: boolean } | null> {
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

			const bugResponse = await this.apiRequest<{
				bugId?: string;
				deduplicated?: boolean;
			}>("/api/bugs", {
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
			const storedBugId = bugResponse?.bugId || bugId;
			const deduplicated = bugResponse?.deduplicated === true;

			this.log(
				deduplicated
					? `Matched existing bug: ${payload.title} (${storedBugId})`
					: `Bug reported: ${payload.title} (${priority} priority) by ${payload.source}`,
			);
			if (deduplicated) {
				return { bugId: storedBugId, deduplicated: true };
			}

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
						"X-Coleo-Bug-Id": storedBugId,
						"X-Coleo-Priority": priority,
					},
				});

				// Mark as human notified
				await this.apiRequest(`/api/bugs/${encodeURIComponent(storedBugId)}`, {
					method: "PATCH",
					body: JSON.stringify({ humanNotified: true }),
				});
			}

			// Handle escalation based on priority and impact
			if (priority === "medium") {
				// For medium priority bugs, evaluate impacted active tasks and log for resolution
				await this.handleMediumPriorityBugEscalation(storedBugId, payload);
			} else if (priority === "low") {
				// For low priority bugs, continue work but track for later resolution
				this.log(`Low priority bug ${storedBugId} logged for later resolution`);
			}

			// If bug blocks a task, try to assign an arm to investigate
			if (payload.sourceTaskId) {
				const task = await this.getTaskFromApi(payload.sourceTaskId);
				if (task && task.status !== "completed" && task.status !== "failed") {
					// Create investigation task
					await this.createBugInvestigationTask(storedBugId, payload);
				}
			}
			return { bugId: storedBugId, deduplicated: false };
		} catch (err) {
			this.log(`Error handling bug report: ${err}`);
			return null;
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
			pathMatchesPattern(payload.filePath, pattern),
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
					2,
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
				if (isActiveHarnessState(harnessState.state)) {
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

			const availableTasks = this.getAvailableTasksForArm(taskSnapshot, arm.id);

			if (availableTasks.length > 0) {
				// There are tasks available - prompt the arm to fetch its assignment
				this.log(
					`Arm ${arm.id} [${armDomain}]: ${availableTasks.length} task(s) available, prompting to check instructions...`,
				);

				const promptSuccess = await this.promptArmForAvailableTasks(
					arm.id,
					availableTasks,
					{
						reason: "tasks_available",
					},
				);

				if (!promptSuccess) {
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
					watchingPatterns: getDomainPatterns(armDomain),
				});
			}
		}
	}

	private getAvailableTasksForArm(taskSnapshot: Task[], armId: string): Task[] {
		const availableTasks = taskSnapshot.filter((task) => {
			if (task.status !== "pending") return false;
			if (task.assignedTo) return false;
			return true;
		});

		const myAssignedTasks = taskSnapshot.filter(
			(task) => task.assignedTo === armId && task.status === "claimed",
		);

		return [...myAssignedTasks, ...availableTasks].filter(
			(task, index, self) =>
				index === self.findIndex((candidate) => candidate.id === task.id),
		);
	}

	private async promptArmForAvailableTasks(
		armId: string,
		availableTasks: Task[],
		options?: {
			reason?: string;
			resetSession?: boolean;
		},
	): Promise<boolean> {
		if (availableTasks.length === 0) {
			return false;
		}

		const arm = this.arms.get(armId);
		const armName = arm?.name || armId;
		const armDomain =
			(arm as (Arm & { domain?: string }) | undefined)?.domain || "general";
		const taskCount = availableTasks.length;
		const domainMatchCount = availableTasks.filter(
			(task) => !task.domain || task.domain === armDomain,
		).length;

		let sessionReset = false;
		if (options?.resetSession) {
			sessionReset = await this.resetArmSession(armId);
			if (!sessionReset) {
				this.log(
					`Arm ${armId}: session reset unavailable, continuing with existing session`,
				);
			}
		}

		const prompt = await this.templates.renderTemplate(
			"arm-tasks-available-prompt.jinja",
			{
				task_count: taskCount,
			},
		);

		const promptSuccess = await this.sendPromptToArm(armName, prompt);

		if (promptSuccess) {
			this.logActivity("brain", "arm_prompted", armId, {
				reason: options?.reason || "tasks_available",
				taskCount,
				domainMatchCount,
				domain: armDomain,
				sessionReset,
			});
		}

		return promptSuccess;
	}

	private async handOffCompletedArm(armId: string): Promise<void> {
		if (this.shuttingDown) {
			return;
		}

		await this.loadTasks();
		const availableTasks = this.getAvailableTasksForArm(this.tasks, armId);
		if (availableTasks.length === 0) {
			this.log(`Arm ${armId}: no follow-up work available after completion`);
			return;
		}

		const promptSuccess = await this.promptArmForAvailableTasks(
			armId,
			availableTasks,
			{
				reason: "task_completion_handoff",
				resetSession: true,
			},
		);

		if (!promptSuccess) {
			this.log(`Failed to hand off next task to arm ${armId}`);
		}
	}

	private async getRecentArmMessageTimestampMs(
		armId: string,
		limit = 20,
	): Promise<number | null> {
		const response = await this.apiRequest<{ messages?: SessionMessage[] }>(
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
			if (!isSessionMessage(message)) {
				continue;
			}
			const timestampMs = extractMessageTimestampMs(message);
			if (
				timestampMs !== null &&
				(latestMs === null || timestampMs > latestMs)
			) {
				latestMs = timestampMs;
			}
		}

		return latestMs;
	}

	private async getRecentArmEventTimestampMs(
		armId: string,
		limit = 25,
	): Promise<number | null> {
		const params = new URLSearchParams({
			actor: armId,
			limit: String(limit),
		});
		const response = await this.apiRequest<{
			activity?: Array<{ timestamp?: string }>;
		}>(`/api/activity?${params.toString()}`, {}, 1500);
		const activity = response?.activity;
		if (!activity || activity.length === 0) {
			return null;
		}

		let latestMs: number | null = null;
		for (const entry of activity) {
			if (!entry?.timestamp) {
				continue;
			}
			const timestampMs = new Date(entry.timestamp).getTime();
			if (!Number.isFinite(timestampMs)) {
				continue;
			}
			if (latestMs === null || timestampMs > latestMs) {
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

		const latestActivityMs = await this.getRecentArmEventTimestampMs(armId, 25);
		if (latestActivityMs !== null) {
			const ageMs = nowMs - latestActivityMs;
			if (ageMs >= 0 && ageMs < thresholdMs) {
				return {
					recent: true,
					reason: `recent API arm event ${Math.round(ageMs / 1000)}s ago`,
				};
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

	private extractSessionMessageId(
		message: SessionMessage,
	): string | null {
		const info = message.info;
		if (!info) {
			return null;
		}
		const id = info.id;
		return typeof id === "string" && id.trim() ? id : null;
	}

	private extractSessionMessageRole(
		message: SessionMessage,
	): string | null {
		const info = message.info;
		if (!info) {
			return null;
		}
		const role = info.role;
		return typeof role === "string" && role.trim() ? role : null;
	}

	private extractSessionMessageText(
		message: SessionMessage,
	): string | null {
		const parts = message.parts;
		if (!Array.isArray(parts)) {
			return null;
		}

		const textParts: string[] = [];
		for (const part of parts) {
			if (!part || typeof part !== "object") {
				continue;
			}
			if (part.type !== "text") {
				continue;
			}
			const text = part.text;
			if (typeof text === "string" && text.trim()) {
				textParts.push(text.trim());
			}
		}

		if (textParts.length === 0) {
			return null;
		}
		return textParts.join("\n\n");
	}

	private hasProcessedArmOutputMessage(armId: string, messageId: string): boolean {
		const processed = this.processedArmOutputMessageIds.get(armId);
		return processed?.has(messageId) === true;
	}

	private markArmOutputMessageProcessed(armId: string, messageId: string): void {
		let processed = this.processedArmOutputMessageIds.get(armId);
		if (!processed) {
			processed = new Set<string>();
			this.processedArmOutputMessageIds.set(armId, processed);
		}
		processed.add(messageId);

		// Cap per-arm history to avoid unbounded growth.
		while (processed.size > 200) {
			const oldest = processed.values().next().value;
			if (!oldest) break;
			processed.delete(oldest);
		}
	}

	private async getRecentAssistantTextMessages(
		armId: string,
		limit = 20,
	): Promise<{
		messages: Array<{ id: string; timestampMs: number; text: string }>;
		latestAssistantHasText: boolean;
	}> {
		const response = await this.apiRequest<{ messages?: SessionMessage[] }>(
			`/api/arms/${encodeURIComponent(armId)}/messages?limit=${limit}`,
			{},
			1500,
		);
		const messages = response?.messages;
		if (!messages || messages.length === 0) {
			return { messages: [], latestAssistantHasText: false };
		}

		const parsed: Array<{ id: string; timestampMs: number; text: string }> = [];
		let latestAssistant: { timestampMs: number; hasText: boolean } | null = null;
		let sawAssistant = false;
		for (const message of messages) {
			if (!isSessionMessage(message)) {
				continue;
			}
			const role = this.extractSessionMessageRole(message);
			if (role !== "assistant") {
				continue;
			}
			sawAssistant = true;

			const text = this.extractSessionMessageText(message);
			const timestampMs = extractMessageTimestampMs(message);
			if (timestampMs !== null) {
				if (!latestAssistant || timestampMs > latestAssistant.timestampMs) {
					latestAssistant = { timestampMs, hasText: Boolean(text) };
				}
			}

			const messageId = this.extractSessionMessageId(message);
			if (!messageId) {
				continue;
			}
			if (!text) {
				continue;
			}
			if (timestampMs === null) {
				continue;
			}
			parsed.push({ id: messageId, timestampMs, text });
		}

		return {
			messages: parsed.sort((a, b) => a.timestampMs - b.timestampMs),
			latestAssistantHasText: latestAssistant?.hasText === true && sawAssistant,
		};
	}

	private isArmInStartupGracePeriod(
		armId: string,
		nowMs: number,
		startupGraceMs: number,
	): { inGrace: boolean; ageMs: number } {
		if (startupGraceMs <= 0) {
			return { inGrace: false, ageMs: Number.POSITIVE_INFINITY };
		}

		const detectionTime = this.armDetectionTimes.get(armId);
		if (!detectionTime) {
			return { inGrace: false, ageMs: Number.POSITIVE_INFINITY };
		}

		const ageMs = nowMs - detectionTime.getTime();
		if (ageMs < startupGraceMs) {
			return { inGrace: true, ageMs };
		}

		return { inGrace: false, ageMs };
	}

	private async applyArmOutputDecision(
		arm: Arm,
		decision: ArmOutputDecision,
		sourceMessages: Array<{ id: string; timestampMs: number; text: string }>,
	): Promise<void> {
		const action = decision.action;
		const promptText = decision.armPrompt?.trim();
		if (action === "no_action") {
			if (!promptText) {
				return;
			}
			const armTarget = arm.name || arm.id;
			const prompted = await this.sendPromptToArm(armTarget, promptText);
			if (!prompted) {
				this.log(
					`Arm output follow-up prompt failed for ${armTarget} after action ${action}`,
				);
				return;
			}
			this.log(
				`Arm output action no_action_with_prompt: prompted ${armTarget} to continue without waiting`,
			);
			this.logActivity("brain", "arm_output_action", arm.id, {
				action: "no_action_with_prompt",
				confidence: decision.confidence,
				messageIds: sourceMessages.map((m) => m.id),
			});
			return;
		}

		const fallbackPrompt = "Acknowledged. Continue with the next relevant step and report progress.";
		let followupPrompt = promptText || fallbackPrompt;

		if (action === "create_task") {
			const taskSubject =
				decision.task?.subject?.trim() ||
				`Follow-up from ${arm.name || arm.id}`;
			const sourceText =
				sourceMessages[sourceMessages.length - 1]?.text ||
				"Follow-up requested by arm output.";
			const taskDescription =
				decision.task?.description?.trim() || sourceText.slice(0, 2000);
			const priority =
				normalizeTaskPriority(decision.task?.priority) || "normal";

			const task = await this.createTaskViaApi({
				subject: taskSubject,
				description: taskDescription,
				priority,
				domain: decision.task?.domain || undefined,
				classification: decision.task?.classification || undefined,
				sourceType: "system",
				sourceRef: `arm-output:${arm.id}`,
				metadata: {
					origin: "arm_output_processor",
					armId: arm.id,
					messageIds: sourceMessages.map((m) => m.id),
				},
			});

			if (!task) {
				this.log(
					`Arm output action create_task failed for ${arm.id}: task creation returned null`,
				);
				return;
			}

			this.log(
				`Arm output action create_task: created ${task.id} from assistant output on ${arm.id}`,
			);
			this.logActivity("brain", "arm_output_action", arm.id, {
				action,
				taskId: task.id,
				confidence: decision.confidence,
			});
			followupPrompt =
				promptText ||
				`I created task ${task.id}: ${task.subject}. Continue with the next concrete step and report status updates.`;
		} else if (action === "log_bug") {
			const sourceText =
				sourceMessages[sourceMessages.length - 1]?.text ||
				"Bug reported by arm assistant output.";
			const priority =
				normalizeBugPriority(decision.bug?.priority) || "medium";
			const bugTitle =
				decision.bug?.title?.trim() || `Bug report from ${arm.name || arm.id}`;
			const bugDescription =
				decision.bug?.description?.trim() || sourceText.slice(0, 2000);
			const bugCreate = await this.apiRequest<{ bugId?: string }>(
				"/api/bugs",
				{
					method: "POST",
					body: JSON.stringify({
						title: bugTitle,
						description: bugDescription,
						source: "arm_reported",
						sourceArmId: arm.id,
						sourceTaskId: decision.bug?.sourceTaskId,
						priority,
						metadata: {
							origin: "arm_output_processor",
							messageIds: sourceMessages.map((m) => m.id),
						},
					}),
				},
			);

			if (!bugCreate?.bugId) {
				this.log(
					`Arm output action log_bug failed for ${arm.id}: bug creation returned no bugId`,
				);
				return;
			}

			this.log(
				`Arm output action log_bug: created ${bugCreate.bugId} from assistant output on ${arm.id}`,
			);
			this.logActivity("brain", "arm_output_action", arm.id, {
				action,
				bugId: bugCreate.bugId,
				confidence: decision.confidence,
			});
			followupPrompt =
				promptText ||
				`I logged bug ${bugCreate.bugId}: ${bugTitle}. Continue investigating or proceed with the next task-safe step.`;
		} else if (action === "update_task") {
			const taskId = decision.update?.taskId?.trim();
			if (!taskId) {
				this.log(
					`Arm output action update_task ignored for ${arm.id}: missing taskId`,
				);
				return;
			}

			const taskPatch: {
				subject?: string;
				description?: string;
				status?: Task["status"];
				priority?: Task["priority"];
				metadata?: Record<string, unknown>;
			} = {
				metadata: {
					origin: "arm_output_processor",
					armId: arm.id,
					messageIds: sourceMessages.map((m) => m.id),
				},
			};
			if (decision.update?.subject?.trim()) {
				taskPatch.subject = decision.update.subject.trim();
			}
			if (decision.update?.description?.trim()) {
				taskPatch.description = decision.update.description.trim();
			}
			if (decision.update?.status) {
				taskPatch.status = decision.update.status;
			}
			const updatePriority = normalizeTaskPriority(decision.update?.priority);
			if (updatePriority) {
				taskPatch.priority = updatePriority;
			}

			if (
				!taskPatch.subject &&
				!taskPatch.description &&
				!taskPatch.status &&
				!taskPatch.priority
			) {
				this.log(
					`Arm output action update_task ignored for ${arm.id}: no update fields`,
				);
				return;
			}

			const task = await this.patchTaskViaApi(taskId, taskPatch);
			if (!task) {
				this.log(
					`Arm output action update_task failed for ${arm.id}: task ${taskId} not updated`,
				);
				return;
			}

			this.log(
				`Arm output action update_task: updated ${task.id} from assistant output on ${arm.id}`,
			);
			this.logActivity("brain", "arm_output_action", arm.id, {
				action,
				taskId: task.id,
				confidence: decision.confidence,
			});
			followupPrompt =
				promptText ||
				`I updated task ${task.id} (${task.status}). Continue with the next concrete step and report progress.`;
		}

		const armTarget = arm.name || arm.id;
		const prompted = await this.sendPromptToArm(armTarget, followupPrompt);
		if (!prompted) {
			this.log(
				`Arm output follow-up prompt failed for ${armTarget} after action ${action}`,
			);
		}
	}

	private async processArmAssistantOutputs(): Promise<void> {
		const activeArms = Array.from(this.arms.values()).filter(
			(arm) => arm.status !== "stopped" && arm.status !== "error",
		);
		if (activeArms.length === 0) {
			return;
		}
		const startupGraceMinutes = await this.getBrainConfigNumber(
			"brain_arm_grace_period_minutes",
			2,
		);
		const startupGraceMs = Math.max(0, startupGraceMinutes) * 60 * 1000;

		const taskSnapshot = this.tasks
			.slice(0, 30)
			.map((task) => `${task.id} [${task.status}] ${task.subject}`)
			.join("\n");

		for (const arm of activeArms) {
			try {
				const assistantSnapshot = await this.getRecentAssistantTextMessages(
					arm.id,
					20,
				);
				const graceState = this.isArmInStartupGracePeriod(
					arm.id,
					Date.now(),
					startupGraceMs,
				);
				if (graceState.inGrace) {
					// Drop startup chatter so it doesn't get replayed when grace expires.
					for (const message of assistantSnapshot.messages) {
						this.markArmOutputMessageProcessed(arm.id, message.id);
					}
					this.log(
						`Arm ${arm.id}: skipping assistant-output processing during startup grace (${Math.round(graceState.ageMs / 1000)}s/${Math.round(startupGraceMs / 1000)}s)`,
					);
					continue;
				}
				// Avoid racing active tool-use turns: only process when the newest
				// assistant message is textual (not a tool/reasoning-only turn).
				if (!assistantSnapshot.latestAssistantHasText) {
					continue;
				}
				const assistantMessages = assistantSnapshot.messages;
				if (assistantMessages.length === 0) {
					continue;
				}

				const unprocessed = assistantMessages.filter(
					(message) => !this.hasProcessedArmOutputMessage(arm.id, message.id),
				);
				if (unprocessed.length === 0) {
					continue;
				}

				const recent = unprocessed.slice(-2);
				for (const message of recent) {
					this.markArmOutputMessageProcessed(arm.id, message.id);
				}

				const outputText = recent
					.map(
						(message, idx) =>
							`Assistant message ${idx + 1} (${new Date(message.timestampMs).toISOString()}):\n${message.text}`,
					)
					.join("\n\n---\n\n");

				const armDomain =
					(arm as Arm & { domain?: string }).domain || "general";
				const systemPrompt =
					await this.templates.loadArmOutputProcessorSystemPrompt({
						armName: arm.name,
						armDomain,
						pendingTasks: this.state.pendingTasks,
						taskSnapshot: taskSnapshot || "none",
					});
				const decision = await this.armOutputProcessor.processOutput(
					arm.id,
					arm.name,
					outputText,
					systemPrompt,
				);

				await this.applyArmOutputDecision(arm, decision, recent);
			} catch (err) {
				this.log(`Failed to process assistant output for arm ${arm.id}: ${err}`);
			}
		}
	}

	/**
	 * Send a prompt to an arm via the API server
	 */
	private async sendPromptToArm(
		armName: string,
		message: string,
		options?: { interrupt?: boolean; attachments?: TaskAttachment[] },
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
					attachments: options?.attachments,
				}),
			});

			if (response.ok) {
				this.healthMonitor?.recordPromptSent(armName);
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
		const systemStatus = await this.apiRequest<{
			status?: string;
			infrastructure?: {
				database?: { healthy: boolean; error?: string };
				nats?: { healthy: boolean; optional?: boolean; error?: string };
				maildir?: { healthy: boolean; error?: string };
			};
		}>("/api/status", {}, 5000);
		const infrastructureFromApi = systemStatus?.infrastructure;

		if (!systemStatus || !infrastructureFromApi) {
			const healthStatus = await this.apiRequest<{ status?: string }>(
				"/api/health",
				{},
				1500,
			);
			const apiReachable = healthStatus?.status === "ok";

			// If API is unreachable, treat it as a hard failure.
			if (!apiReachable) {
				this.infrastructureHealth.apiServer = {
					healthy: false,
					lastCheck: now,
					error: "API health unavailable",
				};
				this.infrastructureHealth.database = {
					healthy: false,
					lastCheck: now,
					error: "API health unavailable",
				};
				this.infrastructureHealth.nats = {
					healthy: false,
					lastCheck: now,
					error: "API health unavailable",
					optional: true,
				};
				this.infrastructureHealth.maildir = {
					healthy: false,
					lastCheck: now,
					error: "API health unavailable",
				};

				issues.push(`API server unavailable at ${this.apiBaseUrl} (health endpoint)`);
			} else {
				// API is up but /api/status is slow/unavailable.
				// The API server is healthy, but we can't verify other components.
				// Keep last-known values for other components - don't mark as healthy with errors.
				this.infrastructureHealth.apiServer = { healthy: true, lastCheck: now };

				// Only initialize components if they haven't been checked before.
				// Don't mark them as healthy/unhealthy - we simply don't know their status.
				if (!this.infrastructureHealth.database.lastCheck) {
					this.infrastructureHealth.database = {
						healthy: true, // Assume healthy since API is working (API needs DB)
						lastCheck: now,
					};
				}
				if (!this.infrastructureHealth.nats.lastCheck) {
					this.infrastructureHealth.nats = {
						healthy: true, // NATS is optional, assume healthy
						lastCheck: now,
						optional: true,
					};
				}
				if (!this.infrastructureHealth.maildir.lastCheck) {
					this.infrastructureHealth.maildir = {
						healthy: true, // Assume healthy since API is working
						lastCheck: now,
					};
				}
			}
		} else {
			this.infrastructureHealth.apiServer = { healthy: true, lastCheck: now };

			const dbHealth = infrastructureFromApi.database;
			if (!dbHealth) {
				this.infrastructureHealth.database = {
					healthy: false,
					lastCheck: now,
					error: "Database health unavailable from /api/status",
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

			const natsHealth = infrastructureFromApi.nats;
			this.infrastructureHealth.nats = {
				healthy: natsHealth?.healthy === true,
				lastCheck: now,
				error: natsHealth?.error,
				optional: natsHealth?.optional ?? true,
			};

			const maildirHealth = infrastructureFromApi.maildir;
			this.infrastructureHealth.maildir = {
				healthy: maildirHealth?.healthy === true,
				lastCheck: now,
				error: maildirHealth?.error || (maildirHealth ? undefined : "Maildir health unavailable from /api/status"),
			};
			if (!this.infrastructureHealth.maildir.healthy) {
				issues.push(
					`Maildir error: ${this.infrastructureHealth.maildir.error || "Maildir unhealthy"}`,
				);
			}
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

		// Persist infrastructure health to API server (only when API is reachable)
		if (this.infrastructureHealth.apiServer.healthy) {
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

		if (!this.infrastructureHealth.apiServer.healthy) {
			try {
				const status = await this.apiRequest<{ status: string }>("/api/health");
				if (status?.status === "ok") {
					this.log("Recovered API connection");
					recovered = true;
				}
			} catch (err) {
				this.log(`Failed to recover API connection: ${err}`);
			}
			return recovered;
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
			return stripTerminalArtifacts(rawOutput);
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
					// For API harnesses, trust the processing state - don't override to idle
					// even if there's no recent activity signal (long-running tasks are valid)
					const isApi = await this.isApiHarness(arm.id);
					if (isApi) {
						this.log(
							`Arm ${arm.name}: API harness confirmed processing, keeping busy`,
						);
						continue;
					}
					// Fall through to log analysis to check if it's stuck
				}
				// Could not get harness state or state is error/unknown - decide how to proceed based on harness type
				const isApi = await this.isApiHarness(arm.id);
				if (isApi) {
					// For API harnesses, we can't reliably analyze logs
					// Instead, check if the arm is sending heartbeats. Heartbeat alone
					// is not enough for recovery because API arms can keep heartbeating
					// long after real work has stalled.
					const hasRecentHb = await this.hasRecentHeartbeat(arm.id, 60);
					if (hasRecentHb) {
						const staleMinutes = await this.getBrainConfigNumber(
							"brain_api_arm_stale_activity_minutes",
							5,
						);
						const staleThresholdMs = staleMinutes * 60 * 1000;
						const recentSignal = await this.getRecentArmActivitySignal(
							arm.id,
							staleThresholdMs,
						);
						if (recentSignal.recent) {
							this.log(
								`Arm ${arm.name}: API harness heartbeat is fresh and ${recentSignal.reason || "activity is recent"}, keeping busy`,
							);
							continue;
						}

						const lastActivityAgeMinutes = arm.lastActivity
							? (Date.now() - arm.lastActivity.getTime()) / 1000 / 60
							: null;
						const lastActivitySuffix =
							lastActivityAgeMinutes !== null &&
							Number.isFinite(lastActivityAgeMinutes)
								? ` (last activity ${lastActivityAgeMinutes.toFixed(1)}m ago)`
								: "";
						this.log(
							`Arm ${arm.name}: API harness heartbeat is fresh but no activity signal for ${staleMinutes}m${lastActivitySuffix}, marking idle so the next poll can nudge it`,
						);
						await this.syncArmStatus(arm.id, "idle");
						arm.status = "idle";
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

			// Check for silent completion (arm completed task but didn't call complete_task)
			const silentCheck = await this.detectSilentCompletion(arm);
			if (silentCheck.isComplete) {
				this.log(
					`Arm ${arm.name}: detected silent completion for task ${silentCheck.taskId} (confidence: ${silentCheck.confidence})`,
				);
				this.logActivity("brain", "silent_completion_detected", arm.id, {
					taskId: silentCheck.taskId,
					confidence: silentCheck.confidence,
					reasoning: silentCheck.reasoning,
				});

				// Create analysis for silent completion
				const analysis: StuckAnalysis = {
					isStuck: true,
					stuckType: "silent_completion",
					reasoning: silentCheck.reasoning,
					suggestedAction: "prompt_complete_task",
					confidence: silentCheck.confidence,
					silentCompletion: {
						taskId: silentCheck.taskId!,
						filesChanged: [],
						isReadyForCompletion: silentCheck.confidence >= 0.75,
					},
				};

				await this.handleStuckArm(arm, analysis);
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

			case "prompt_complete_task": {
				// Arm has silently completed task - prompt to call complete_task
				await this.promptArmToCompleteTask(arm, analysis);
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
	 * Detect if an arm has silently completed its task without calling complete_task
	 * Analyzes status reports, recent activity, and task state
	 */
	private async detectSilentCompletion(
		arm: Arm,
	): Promise<{
		isComplete: boolean;
		taskId?: string;
		confidence: number;
		reasoning: string;
	}> {
		const taskId = arm.currentTask;
		if (!taskId) {
			return { isComplete: false, confidence: 0, reasoning: "No current task" };
		}

		// Get task details
		const task = await this.getTaskFromApi(taskId);
		if (!task) {
			return { isComplete: false, confidence: 0, reasoning: "Task not found" };
		}

		// Get recent status reports for this task (including on_track)
		const statusReports = await this.getAllStatusReportsForTask(taskId);
		if (statusReports.length === 0) {
			return { isComplete: false, confidence: 0, reasoning: "No status reports" };
		}

		const latestReport = statusReports[statusReports.length - 1];
		if (!latestReport) {
			return { isComplete: false, confidence: 0, reasoning: "No valid status report" };
		}

		// Check if status indicates completion
		const isOnTrack = latestReport.status === "on_track";
		const isCompletedWithIssues = latestReport.status === "completed_with_issues";
		const testsPassing = latestReport.testsStatus === "passing";
		const noBlockers = latestReport.issues?.length === 0;

		// Calculate confidence
		let confidence = 0;
		let reasoning = "";

		if (isOnTrack) {
			confidence += 0.3;
			reasoning += "Status is 'on_track'. ";
		} else if (isCompletedWithIssues) {
			confidence += 0.25;
			reasoning += "Status is 'completed_with_issues'. ";
		}

		if (testsPassing) {
			confidence += 0.25;
			reasoning += "Tests are passing. ";
		}

		if (noBlockers) {
			confidence += 0.2;
			reasoning += "No blockers reported. ";
		}

		// Check for recent activity indicating completion
		const recentOutput = await this.readArmLogs(arm.name, 50);
		const completionIndicators = [
			/done/i,
			/completed/i,
			/finished/i,
			/success/i,
			/ready for review/i,
		];

		const hasCompletionIndicator = completionIndicators.some((pattern) =>
			pattern.test(recentOutput),
		);

		if (hasCompletionIndicator) {
			confidence += 0.2;
			reasoning += "Recent output indicates completion. ";
		}

		return {
			isComplete: confidence >= 0.6,
			taskId,
			confidence,
			reasoning: reasoning.trim() || "Insufficient indicators",
		};
	}

	/**
	 * Prompt an arm to complete its task by calling complete_task
	 */
	private async promptArmToCompleteTask(
		arm: Arm,
		analysis: StuckAnalysis,
	): Promise<void> {
		const taskId = arm.currentTask;
		if (!taskId) {
			this.log(`Cannot prompt ${arm.name} to complete task - no current task`);
			return;
		}

		const task = await this.getTaskFromApi(taskId);
		const taskSubject = task?.subject || taskId;

		// Generate prompt message
		const promptText = await this.templates.renderTemplate(
			"arm-prompt-complete-task.jinja",
			{
				arm_name: arm.name,
				task_subject: taskSubject,
				task_id: taskId,
				confidence: analysis.confidence,
				reasoning: analysis.reasoning,
			},
		);

		this.log(
			`Prompting ${arm.name} to complete task ${taskId}: "${promptText.slice(0, 50)}..."`,
		);

		// Send prompt to arm
		const success = await this.sendPromptToArm(arm.name, promptText);

		if (success) {
			this.logActivity("brain", "arm_prompted_complete_task", arm.id, {
				taskId,
				confidence: analysis.confidence,
				reasoning: analysis.reasoning,
			});

			// If confidence is very high, auto-complete the task
			if (analysis.confidence >= 0.85 && analysis.silentCompletion?.isReadyForCompletion) {
				this.log(
					`Auto-completing task ${taskId} for ${arm.name} with high confidence`,
				);
				await this.completeTask(
					taskId,
					`Auto-completed: ${analysis.reasoning}`,
					analysis.silentCompletion.filesChanged || [],
				);
			}
		} else {
			this.log(`Failed to prompt ${arm.name} to complete task`);
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
	 * Reads activity via API (API uses JetStream as source of truth).
	 */
	private async getRecentArmActivity(
		armId: string,
		minutes: number,
	): Promise<Array<{
		timestamp: string;
		action: string;
		details: string;
	}> | null> {
		const since = new Date(Date.now() - minutes * 60 * 1000);
		try {
			const params = new URLSearchParams({
				actor: armId,
				limit: "100",
			});
			const response = await this.apiRequest<{
				activity?: Array<{
					timestamp: string;
					action: string;
					details?: Record<string, unknown>;
				}>;
			}>(`/api/activity?${params.toString()}`, {}, 1500);
			const events = response?.activity || [];

			// Filter to events within the time window and transform to expected format
			return events
				.filter((e) => new Date(e.timestamp).getTime() > since.getTime())
				.map((e) => ({
					timestamp: e.timestamp,
					action: e.action,
					details: JSON.stringify(e.details || {}),
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

		// Check for file claim conflicts before bug blocking
		await this.checkAndBlockTasksForClaimConflicts(pendingTasks);

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
	 * Check tasks for file claim conflicts and block them if found.
	 * This prevents multiple arms from working on files claimed by others.
	 */
	private async checkAndBlockTasksForClaimConflicts(
		tasks: Task[],
	): Promise<void> {
		try {
			// Get all active file claims from the database
			const activeClaims = await this.getActiveFileClaims();
			if (activeClaims.length === 0) {
				return; // No active claims, nothing to check
			}

			for (const task of tasks) {
				// Extract file paths from task (from artifacts, description, or context)
				const taskFiles = this.extractFilePathsFromTask(task);
				if (taskFiles.length === 0) {
					continue; // No files associated with this task
				}

				// Check for conflicts with active claims
				const conflicts = this.findClaimConflicts(taskFiles, activeClaims);
				if (conflicts.length > 0) {
					this.log(
						`Task ${task.id} blocked due to ${conflicts.length} file claim conflict(s)`,
					);

					// Mark task as blocked
					await this.patchTaskViaApi(task.id, {
						status: "blocked",
					});

					// Notify human about the conflict
					await this.notifyHumanOfClaimConflict(task, conflicts);

					// If active resolution is enabled, attempt to resolve
					if (this.resolveClaimsActive) {
						await this.attemptClaimConflictResolution(task, conflicts);
					}
				}
			}
		} catch (err) {
			this.log(`Error checking file claim conflicts: ${err}`);
		}
	}

	/**
	 * Get all active file claims from the database
	 */
	private async getActiveFileClaims(): Promise<
		Array<{ armId: string; filePath: string; claimType: string; claimedAt: string }>
	> {
		try {
			const response = await this.apiRequest<{
				claims?: Array<{
					armId: string;
					filePath: string;
					claimType: string;
					claimedAt: string;
				}>;
			}>("/api/garden/claims");

			return response?.claims || [];
		} catch (err) {
			this.log(`Failed to get active file claims: ${err}`);
			return [];
		}
	}

	/**
	 * Extract file paths associated with a task
	 */
	private extractFilePathsFromTask(task: Task): string[] {
		const files: string[] = [];

		// Add files from artifacts
		if (task.artifacts) {
			for (const artifact of task.artifacts) {
				// Check if artifact looks like a file path
				if (artifact.includes("/") || artifact.includes(".")) {
					files.push(artifact);
				}
			}
		}

		// Add files from discoveries in context
		if (task.context?.discoveries) {
			for (const discovery of task.context.discoveries) {
				if (discovery.filePath) {
					files.push(discovery.filePath);
				}
			}
		}

		// Parse description for file paths (simple heuristic)
		const filePathRegex = /(?:src\/|\.\/|\/)?[\w\/\-]+\.(?:ts|tsx|js|jsx|json|md)/g;
		const descriptionFiles = task.description.match(filePathRegex) || [];
		files.push(...descriptionFiles);

		// Remove duplicates
		return [...new Set(files)];
	}

	/**
	 * Find conflicts between task files and active claims
	 */
	private findClaimConflicts(
		taskFiles: string[],
		activeClaims: Array<{ armId: string; filePath: string; claimType: string; claimedAt: string }>,
	): Array<{ armId: string; filePath: string; claimType: string; claimedAt: string }> {
		const conflicts: Array<{ armId: string; filePath: string; claimType: string; claimedAt: string }> = [];

		for (const taskFile of taskFiles) {
			// Normalize the task file path
			const normalizedTaskFile = taskFile.replace(/^\.\//, "").replace(/^\//, "");

			for (const claim of activeClaims) {
				// Check for exact match or if task file is within claimed directory
				const normalizedClaimFile = claim.filePath.replace(/^\.\//, "").replace(/^\//, "");

				if (
					normalizedTaskFile === normalizedClaimFile ||
					normalizedTaskFile.startsWith(normalizedClaimFile + "/") ||
					normalizedClaimFile.startsWith(normalizedTaskFile + "/")
				) {
					conflicts.push(claim);
				}
			}
		}

		return conflicts;
	}

	/**
	 * Notify human about a claim conflict
	 */
	private async notifyHumanOfClaimConflict(
		task: Task,
		conflicts: Array<{ armId: string; filePath: string; claimType: string; claimedAt: string }>,
	): Promise<void> {
		const conflictList = conflicts
			.map((c) => `- \`${c.filePath}\` claimed by ${c.armId} (${c.claimType}) since ${c.claimedAt}`)
			.join("\n");

		const body = `## Task Blocked: File Claim Conflict

**Task:** ${task.subject} (${task.id})

This task cannot proceed because the following files are already claimed by other arms:

${conflictList}

### Next Steps

1. **Wait for claims to be released** - The blocking arms will release their claims when done
2. **Coordinate with blocking arms** - Contact them to negotiate file access
3. **Enable auto-resolution** - Set \`brain.resolve_claims_active=true\` to allow automatic conflict resolution

---
*This is a conservative conflict prevention mechanism. Tasks remain blocked until conflicts are resolved.*`;

		await this.sendToHuman({
			subject: `[coleo] Task Blocked: File Claim Conflict - ${task.subject}`,
			body,
			headers: {
				"X-Coleo-Type": "task-blocked-claim-conflict",
				"X-Coleo-Task-Id": task.id,
			},
		});
	}

	private async attemptClaimConflictResolution(
		task: Task,
		conflicts: Array<{ armId: string; filePath: string; claimType: string; claimedAt: string }>,
	): Promise<void> {
		this.log(
			`Active claim resolution enabled but not yet implemented. Task ${task.id} has ${conflicts.length} conflict(s).`,
		);
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
		// Always write to local inbox
		await this.inbox.write({
			from: "brain@coleo.local",
			to: "human@local",
			subject: stripTerminalArtifacts(message.subject),
			date: new Date(),
			body: stripTerminalArtifacts(message.body),
			headers: message.headers || {},
		});

		// Also send via Postmark if configured
		if (this.mailConfig?.toAddress) {
			try {
				await this.apiRequest("/api/mail/gateway/postmark/send", {
					method: "POST",
					body: JSON.stringify({
						from: this.mailConfig.fromAddress,
						to: this.mailConfig.toAddress,
						subject: stripTerminalArtifacts(message.subject),
						body: stripTerminalArtifacts(message.body),
						replyTo: this.mailConfig.fromAddress,
						headers: message.headers || {},
					}),
				});
				this.log(`Email sent to ${this.mailConfig.toAddress}`);
			} catch (err) {
				this.log(`Failed to send email: ${err}`);
			}
		}
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
				activeTasks.filter((t) => isVerificationTaskSubject(t.subject)).map((t) => t.subject),
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
				if (isValidationTaskSubject(task.subject) || isVerificationTaskSubject(task.subject)) {
					continue;
				}

				const verifySubject = buildVerificationTaskSubject(task.subject);
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
				subject: buildVerificationTaskSubject(originalTask.subject),
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
				subject: buildVerificationTaskSubject(originalTask.subject),
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

		const previouslyTracked = new Set(this.arms.keys());
		const activeArmIds = new Set<string>();
		this.arms.clear();
		for (const row of armsFromApi) {
			if (row.status === "stopped") continue;
			activeArmIds.add(row.id);

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
			if (!previouslyTracked.has(arm.id)) {
				this.armDetectionTimes.set(arm.id, new Date());
			}

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
		for (const trackedArmId of Array.from(this.armDetectionTimes.keys())) {
			if (!activeArmIds.has(trackedArmId)) {
				this.armDetectionTimes.delete(trackedArmId);
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
		const { appendFile, mkdir } = await import("fs/promises");
		await mkdir(join(this.options.coleoDir, "logs"), { recursive: true });
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
		const description = buildDocUpdateDescription(context);

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
	 * Check if refactor automation should run based on config and state
	 */
	private async shouldRunRefactorAutomation(): Promise<boolean> {
		const config = await loadConfig(this.options.coleoDir);
		const autoConfig = config.automations;

		// Check if automations are enabled
		if (!autoConfig.enabled || !autoConfig.refactorLargeFiles.enabled) {
			return false;
		}

		const refactorConfig = autoConfig.refactorLargeFiles;

		// Check if there's an existing refactor task
		const existingRefactorTasks = await this.listTasksFromApi({
			status: ["pending", "in_progress", "claimed"],
			limit: 100,
		});
		const hasExistingRefactorTask = existingRefactorTasks.some(
			(t) =>
				t.subject?.startsWith("Refactor large files") &&
				t.classification === "refactoring",
		);
		if (hasExistingRefactorTask) {
			this.log("Skipping refactor automation: existing refactor task found");
			return false;
		}

		// Check if queue should be empty
		if (refactorConfig.requireEmptyQueue) {
			// Check for pending tasks
			const pendingTasks = await this.listTasksFromApi({
				status: ["pending", "claimed"],
				limit: 10,
			});
			if (pendingTasks.length > 0) {
				this.log(
					`Skipping refactor automation: ${pendingTasks.length} pending tasks in queue`,
				);
				return false;
			}

			// Check for open bugs
			const openBugs = await this.listBugsFromApi(100, {
				statuses: ["open", "investigating", "fixing"],
			});
			if (openBugs.length > 0) {
				this.log(
					`Skipping refactor automation: ${openBugs.length} open bugs`,
				);
				return false;
			}
		}

		// Check minimum interval
		if (refactorConfig.lastRunAt) {
			const lastRun = new Date(refactorConfig.lastRunAt).getTime();
			const hoursSinceLastRun = (Date.now() - lastRun) / (1000 * 60 * 60);
			if (hoursSinceLastRun < refactorConfig.minIntervalHours) {
				this.log(
					`Skipping refactor automation: only ${hoursSinceLastRun.toFixed(1)}h since last run (min: ${refactorConfig.minIntervalHours}h)`,
				);
				return false;
			}
		}

		return true;
	}

	/**
	 * Update the last run timestamp for refactor automation
	 */
	private async updateRefactorAutomationLastRun(): Promise<void> {
		try {
			const { updateConfig } = await import("../config");
			await updateConfig(
				{
					automations: {
						refactorLargeFiles: {
							lastRunAt: new Date().toISOString(),
						},
					},
				},
				this.options.coleoDir,
			);
		} catch (err) {
			this.log(`Failed to update refactor automation lastRunAt: ${err}`);
		}
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

			// Update last run timestamp
			await this.updateRefactorAutomationLastRun();

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
