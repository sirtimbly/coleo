/**
 * Brain Setup and Initialization
 * 
 * Extracted initialization logic from brain.ts.
 * Provides setup functions for brain subsystems.
 */

import { mkdir } from "fs/promises";
import { join } from "path";
import { loadConfig } from "../config";
import { DocUpdateTracker } from "./doc-tracker";
import {
	ArmStateMachine,
} from "./arm-state-machine";
import {
	ArmHealthMonitor,
	type HealthMonitorCallbacks,
	type HealthCheckResult,
} from "./health-monitor";
import { createArmStateApiDatabase } from "./arm-state-api-db";
import type { ArmStateStore } from "./db-client";

export interface BrainSetupOptions {
	coleoDir: string;
	apiBaseUrl: string;
	apiKey: string;
	refactorFileThresholdDefault: number;
}

export interface BrainSetupResult {
	refactorFileThresholdLines: number;
	armStateDb: ArmStateStore;
	docTracker: DocUpdateTracker;
	armStateMachine: ArmStateMachine;
	healthMonitor: ArmHealthMonitor;
}

export interface SetupCallbacks {
	log: (message: string) => void;
	logActivity: (actor: string, action: string, entityId?: string, meta?: Record<string, unknown>) => void;
	handleStateMachineSideEffect: (effect: unknown) => Promise<void>;
	sendPromptToArm: (armId: string, message: string) => Promise<void>;
	patchArmViaApi: (armId: string, data: Record<string, unknown>) => Promise<void>;
	sendToHuman: (msg: { subject: string; body: string }) => Promise<void>;
	getArmHarnessState: (armId: string) => Promise<unknown>;
	listArmsFromApi: (includeAll: boolean) => Promise<Array<{ id: string; status: string }>>;
	arms: Map<string, unknown>;
	refreshDashboard: () => void;
}

/**
 * Required directories for brain operation
 */
export const BRAIN_DIRECTORIES = [
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

/**
 * Load brain configuration and get file threshold
 */
export async function loadBrainConfig(
	coleoDir: string,
	defaultThreshold: number,
): Promise<{ refactorFileThresholdLines: number }> {
	const config = await loadConfig(coleoDir);
	return {
		refactorFileThresholdLines: config.refactoring.fileSizeThreshold ?? defaultThreshold,
	};
}

/**
 * Create required directories for brain operation
 */
export async function createBrainDirectories(
	coleoDir: string,
	log: (msg: string) => void,
): Promise<void> {
	for (const dir of BRAIN_DIRECTORIES) {
		await mkdir(join(coleoDir, dir), { recursive: true });
	}
	log("Created brain directories");
}

/**
 * Initialize arm state database
 */
export function initArmStateDb(
	apiBaseUrl: string,
	apiKey: string,
): ArmStateStore {
	return createArmStateApiDatabase(apiBaseUrl, apiKey);
}

/**
 * Initialize documentation tracker
 */
export function initDocTracker(
	apiBaseUrl: string,
	apiKey: string,
	coleoDir: string,
	projectRoot: string,
): DocUpdateTracker {
	return new DocUpdateTracker(apiBaseUrl, apiKey, coleoDir, projectRoot);
}

/**
 * Initialize arm state machine
 */
export function initArmStateMachine(
	armStateDb: ArmStateStore,
	handleSideEffect: (effect: unknown) => Promise<void>,
): ArmStateMachine {
	return new ArmStateMachine(armStateDb, handleSideEffect);
}

/**
 * Create health monitor callbacks
 */
export function createHealthMonitorCallbacks(
	callbacks: SetupCallbacks,
): HealthMonitorCallbacks {
	return {
		getActiveArmIds: async () => {
			const arms = await callbacks.listArmsFromApi(true);
			return arms
				.filter((arm) => arm.status !== "stopped" && arm.status !== "error")
				.map((arm) => arm.id);
		},
		sendPromptToArm: callbacks.sendPromptToArm,
		interruptArm: async (armId: string) => {
			await callbacks.sendPromptToArm(armId, "/compact");
		},
		killArm: async (armId: string, reason: string) => {
			callbacks.log(`Health monitor requested kill for arm ${armId}: ${reason}`);
			await callbacks.patchArmViaApi(armId, {
				status: "stopped",
				lastActivityAt: new Date().toISOString(),
			});
			callbacks.arms.delete(armId);
			callbacks.logActivity("brain", "arm_killed", armId, {
				reason,
				source: "health_monitor",
			});
		},
		notifyHuman: async (subject: string, body: string) => {
			await callbacks.sendToHuman({ subject, body });
		},
		replyToPermission: async (armId: string, _requestId: string, approved: boolean) => {
			const response = approved ? "Yes, proceed." : "No, do not proceed.";
			await callbacks.sendPromptToArm(armId, response);
		},
		getArmRuntimeState: async (armId: string) => {
			return await callbacks.getArmHarnessState(armId) as { state: string; hasSession?: boolean } | null;
		},
	};
}

/**
 * Initialize health monitor
 */
export function initHealthMonitor(
	callbacks: SetupCallbacks,
	log: (msg: string) => void,
	refreshDashboard: () => void,
): {
	healthMonitor: ArmHealthMonitor;
	setLastHealthCheck: (result: HealthCheckResult | null) => void;
} {
	let lastHealthCheck: HealthCheckResult | null = null;
	
	const healthCallbacks = createHealthMonitorCallbacks(callbacks);
	
	const healthMonitor = new ArmHealthMonitor(healthCallbacks, {
		log,
		config: {
			checkIntervalMs: 30 * 1000,
			eventWindowMs: 10 * 60 * 1000,
			idlePromptDelayMs: 12 * 60 * 1000,
			startupGracePeriodMs: 2 * 60 * 1000,
			autoInterventionEnabled: true,
		},
		onResult: (result: HealthCheckResult) => {
			lastHealthCheck = result;
			refreshDashboard();
		},
	});

	const setLastHealthCheck = (result: HealthCheckResult | null) => {
		lastHealthCheck = result;
	};

	return { healthMonitor, setLastHealthCheck };
}

/**
 * Setup documentation watcher
 */
export async function setupDocWatcher(
	projectRoot: string,
	log: (msg: string) => void,
	reqDocsChangeCallback: (event: { relativePath: string; type: string }) => void,
): Promise<{ stop: () => void }> {
	try {
		const { getDocWatcher } = await import("../docs/watcher");
		const docWatcher = getDocWatcher(projectRoot);
		docWatcher.onChange(reqDocsChangeCallback);
		await docWatcher.start();
		return { stop: () => docWatcher.stop() };
	} catch (err) {
		log(`Could not start doc watcher: ${err}`);
		return { stop: () => {} };
	}
}

/**
 * Full brain initialization
 * 
 * This is the main entry point for brain initialization.
 * Returns all initialized components.
 */
export async function initializeBrainComponents(
	options: BrainSetupOptions,
	callbacks: SetupCallbacks,
): Promise<BrainSetupResult> {
	// Load config
	const { refactorFileThresholdLines } = await loadBrainConfig(
		options.coleoDir,
		options.refactorFileThresholdDefault,
	);

	// Initialize arm state database
	const armStateDb = initArmStateDb(options.apiBaseUrl, options.apiKey);

	// Initialize doc tracker
	const docTracker = initDocTracker(
		options.apiBaseUrl,
		options.apiKey,
		options.coleoDir,
		process.cwd(),
	);

	// Initialize arm state machine
	const armStateMachine = initArmStateMachine(
		armStateDb,
		callbacks.handleStateMachineSideEffect,
	);

	// Initialize health monitor
	const { healthMonitor } = initHealthMonitor(
		callbacks,
		callbacks.log,
		callbacks.refreshDashboard,
	);

	// Create directories
	await createBrainDirectories(options.coleoDir, callbacks.log);

	return {
		refactorFileThresholdLines,
		armStateDb,
		docTracker,
		armStateMachine,
		healthMonitor,
	};
}

export default {
	loadBrainConfig,
	createBrainDirectories,
	initArmStateDb,
	initDocTracker,
	initArmStateMachine,
	initHealthMonitor,
	setupDocWatcher,
	initializeBrainComponents,
	BRAIN_DIRECTORIES,
};
