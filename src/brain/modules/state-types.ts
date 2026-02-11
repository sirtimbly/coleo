/**
 * State Types - Shared types for brain state management
 * 
 * Extracted from brain.ts to support modular architecture
 */

import type { BrainState, Task, Arm } from "../../types";
import type { ArmStateStore } from "../db-client";
import type { HealthCheckResult } from "../health-monitor";
import type { ArmStateMachine } from "../arm-state-machine";
import type { ArmHealthMonitor } from "../health-monitor";
import type { TerminalDashboard } from "../terminal-dashboard";
import type { DocUpdateTracker } from "../doc-tracker";
import type { BrainTemplateManager } from "../template-manager";
import type { MailProcessor } from "../mail-processor";
import type { ArmOutputProcessor } from "../arm-output-processor";
import type { StuckArmAnalyzer } from "../activity-analyzer";
import type { NatsClient } from "../../nats";
import type { Maildir } from "../../mail";

export interface StateManagerOptions {
	coleoDir: string;
	pollIntervalMs: number;
	verbose: boolean;
	apiBaseUrl: string;
	apiKey: string;
}

export interface InfrastructureHealth {
	database: { healthy: boolean; lastCheck: Date | null; error?: string };
	apiServer: { healthy: boolean; lastCheck: Date | null; error?: string };
	nats: {
		healthy: boolean;
		lastCheck: Date | null;
		error?: string;
		optional: boolean;
	};
	maildir: { healthy: boolean; lastCheck: Date | null; error?: string };
}

export interface StuckStateInfo {
	stuckType: string;
	escalatedAt: Date;
}

export interface IdleArmInfo {
	promptCount: number;
	lastPromptAt: Date;
	lastProductiveAt: Date | null;
	escalationLevel: number;
}

export interface StateSnapshot {
	brainState: BrainState;
	tasks: Task[];
	arms: Map<string, Arm>;
	running: boolean;
	shuttingDown: boolean;
	completedTaskCount: number;
	infrastructureHealth: InfrastructureHealth;
}

export type StateChangeListener = (change: {
	property: string;
	oldValue: unknown;
	newValue: unknown;
}) => void;

export interface StateManagerDependencies {
	armStateDb?: ArmStateStore | null;
	natsClient?: NatsClient | null;
	armStateMachine?: ArmStateMachine | null;
	healthMonitor?: ArmHealthMonitor | null;
	dashboard?: TerminalDashboard | null;
	docTracker?: DocUpdateTracker | null;
	templates?: BrainTemplateManager;
	mailProcessor?: MailProcessor;
	armOutputProcessor?: ArmOutputProcessor;
	stuckArmAnalyzer?: StuckArmAnalyzer;
	inbox?: Maildir;
	sent?: Maildir;
}
