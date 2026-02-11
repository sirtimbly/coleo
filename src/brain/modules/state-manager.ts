/**
 * BrainStateManager - Manages brain state, arms, and task tracking
 * 
 * Extracted from brain.ts to reduce file size and improve maintainability.
 * Handles: state properties, arm tracking, task tracking, and related utilities.
 */

import type {
	BrainState,
	Task,
	Arm,
} from "../../types";
import type {
	StateManagerOptions,
	InfrastructureHealth,
	StuckStateInfo,
	IdleArmInfo,
	StateSnapshot,
	StateChangeListener,
	StateManagerDependencies,
} from "./state-types";

export class BrainStateManager {
	private options: StateManagerOptions;
	private state: BrainState;
	private tasks: Task[] = [];
	private arms: Map<string, Arm> = new Map();
	private initializedArmIds: Set<string> = new Set();
	private initializedArmIdsLoaded = false;
	private running = false;
	private shuttingDown = false;
	private abortController: AbortController | null = null;
	private completedTaskCount = 0;
	private resolveClaimsActive = false;

	// Tracking Maps
	private lastStuckState: Map<string, StuckStateInfo> = new Map();
	private idleArmPromptTracker: Map<string, IdleArmInfo> = new Map();
	private armDetectionTimes: Map<string, Date> = new Map();
	private lastArmEventTime: Map<string, Date> = new Map();
	private processedArmOutputMessageIds: Map<string, Set<string>> = new Map();
	private fileSubscriptions: Map<string, Set<string>> = new Map();
	private planFileHashes: Map<string, string> = new Map();

	// Infrastructure health
	private infrastructureHealth: InfrastructureHealth = {
		database: { healthy: false, lastCheck: null },
		apiServer: { healthy: false, lastCheck: null },
		nats: { healthy: false, lastCheck: null, optional: true },
		maildir: { healthy: false, lastCheck: null },
	};
	private lastInfraFailureNotification: Date | null = null;

	// Dependencies (injected)
	private deps: StateManagerDependencies = {};

	// Listeners for state changes
	private listeners: StateChangeListener[] = [];

	constructor(options: StateManagerOptions) {
		this.options = options;
		this.state = {
			status: "stopped",
			pollIntervalMs: options.pollIntervalMs,
			activeArms: [],
			pendingTasks: 0,
			completedToday: 0,
			completedTaskCount: 0,
		};
	}

	// Dependency injection
	setDependencies(deps: StateManagerDependencies): void {
		this.deps = { ...this.deps, ...deps };
	}

	getDependencies(): StateManagerDependencies {
		return this.deps;
	}

	// Subscription pattern for state changes
	subscribe(listener: StateChangeListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index > -1) {
				this.listeners.splice(index, 1);
			}
		};
	}

	private notifyChange(property: string, oldValue: unknown, newValue: unknown): void {
		for (const listener of this.listeners) {
			try {
				listener({ property, oldValue, newValue });
			} catch (err) {
				console.error(`[BrainStateManager] Error in state change listener: ${err}`);
			}
		}
	}

	// Getters
	getState(): BrainState {
		return this.state;
	}

	getTasks(): Task[] {
		return this.tasks;
	}

	getArms(): Map<string, Arm> {
		return this.arms;
	}

	getArm(armId: string): Arm | undefined {
		return this.arms.get(armId);
	}

	isRunning(): boolean {
		return this.running;
	}

	isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	// Setters with notification
	setRunning(running: boolean): void {
		const oldValue = this.running;
		this.running = running;
		this.notifyChange("running", oldValue, running);
	}

	setShuttingDown(shuttingDown: boolean): void {
		const oldValue = this.shuttingDown;
		this.shuttingDown = shuttingDown;
		this.notifyChange("shuttingDown", oldValue, shuttingDown);
	}

	// Arm management
	addArm(arm: Arm): void {
		const oldCount = this.arms.size;
		this.arms.set(arm.id, arm);
		this.notifyChange("arms.count", oldCount, this.arms.size);
	}

	removeArm(armId: string): boolean {
		const oldCount = this.arms.size;
		const result = this.arms.delete(armId);
		if (result) {
			this.notifyChange("arms.count", oldCount, this.arms.size);
		}
		return result;
	}

	hasArm(armId: string): boolean {
		return this.arms.has(armId);
	}

	getArmCount(): number {
		return this.arms.size;
	}

	// Task management
	setTasks(tasks: Task[]): void {
		const oldCount = this.tasks.length;
		this.tasks = tasks;
		this.notifyChange("tasks.length", oldCount, tasks.length);
		this.updatePendingTaskCount();
	}

	addTask(task: Task): void {
		this.tasks.push(task);
		this.notifyChange("tasks.length", this.tasks.length - 1, this.tasks.length);
		this.updatePendingTaskCount();
	}

	removeTask(taskId: string): boolean {
		const index = this.tasks.findIndex((t) => t.id === taskId);
		if (index >= 0) {
			this.tasks.splice(index, 1);
			this.notifyChange("tasks.length", this.tasks.length + 1, this.tasks.length);
			this.updatePendingTaskCount();
			return true;
		}
		return false;
	}

	getPendingTaskCount(): number {
		return this.tasks.filter((t) => t.status === "pending").length;
	}

	private updatePendingTaskCount(): void {
		const oldValue = this.state.pendingTasks;
		this.state.pendingTasks = this.getPendingTaskCount();
		if (oldValue !== this.state.pendingTasks) {
			this.notifyChange("state.pendingTasks", oldValue, this.state.pendingTasks);
		}
	}

	// State updates
	updateState(updates: Partial<BrainState>): void {
		const oldState = { ...this.state };
		this.state = { ...this.state, ...updates };
		
		// Notify for each changed property
		for (const key of Object.keys(updates) as Array<keyof BrainState>) {
			if (oldState[key] !== this.state[key]) {
				this.notifyChange(`state.${key}`, oldState[key], this.state[key]);
			}
		}
	}

	setStatus(status: BrainState["status"]): void {
		const oldValue = this.state.status;
		this.state.status = status;
		this.notifyChange("state.status", oldValue, status);
	}

	// Tracking methods
	getLastArmEventTime(armId: string): Date | undefined {
		return this.lastArmEventTime.get(armId);
	}

	setLastArmEventTime(armId: string, time: Date): void {
		this.lastArmEventTime.set(armId, time);
	}

	getArmDetectionTime(armId: string): Date | undefined {
		return this.armDetectionTimes.get(armId);
	}

	setArmDetectionTime(armId: string, time: Date): void {
		this.armDetectionTimes.set(armId, time);
	}

	// File subscriptions
	getFileSubscriptions(armId: string): Set<string> | undefined {
		return this.fileSubscriptions.get(armId);
	}

	setFileSubscriptions(armId: string, files: Set<string>): void {
		this.fileSubscriptions.set(armId, files);
	}

	addFileSubscription(armId: string, filePath: string): void {
		if (!this.fileSubscriptions.has(armId)) {
			this.fileSubscriptions.set(armId, new Set());
		}
		this.fileSubscriptions.get(armId)!.add(filePath);
	}

	removeFileSubscription(armId: string, filePath: string): boolean {
		const subs = this.fileSubscriptions.get(armId);
		if (subs) {
			return subs.delete(filePath);
		}
		return false;
	}

	// Plan file hashes
	getPlanFileHash(filePath: string): string | undefined {
		return this.planFileHashes.get(filePath);
	}

	setPlanFileHash(filePath: string, hash: string): void {
		this.planFileHashes.set(filePath, hash);
	}

	// Infrastructure health
	getInfrastructureHealth(): InfrastructureHealth {
		return this.infrastructureHealth;
	}

	updateInfrastructureHealth(
		service: keyof InfrastructureHealth,
		healthy: boolean,
		error?: string,
	): void {
		const oldHealth = this.infrastructureHealth[service];
		
		// Build new health object explicitly to satisfy TypeScript
		if (service === "nats") {
			this.infrastructureHealth.nats = {
				healthy,
				lastCheck: new Date(),
				error,
				optional: true,
			};
		} else {
			this.infrastructureHealth[service] = {
				healthy,
				lastCheck: new Date(),
				error,
			};
		}
		
		this.notifyChange(`infrastructureHealth.${service}`, oldHealth, this.infrastructureHealth[service]);
	}

	// Abort controller
	getAbortController(): AbortController | null {
		return this.abortController;
	}

	setAbortController(controller: AbortController | null): void {
		this.abortController = controller;
	}

	abort(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	// Task completion tracking
	incrementCompletedTaskCount(): void {
		this.completedTaskCount++;
		this.state.completedTaskCount = this.completedTaskCount;
		this.state.completedToday = this.completedTaskCount;
		this.notifyChange("completedTaskCount", this.completedTaskCount - 1, this.completedTaskCount);
	}

	getCompletedTaskCount(): number {
		return this.completedTaskCount;
	}

	// Claims resolution
	isResolveClaimsActive(): boolean {
		return this.resolveClaimsActive;
	}

	setResolveClaimsActive(active: boolean): void {
		this.resolveClaimsActive = active;
	}

	// Stuck state tracking
	getLastStuckState(armId: string): StuckStateInfo | undefined {
		return this.lastStuckState.get(armId);
	}

	setLastStuckState(armId: string, info: StuckStateInfo): void {
		this.lastStuckState.set(armId, info);
	}

	// Idle arm tracking
	getIdleArmInfo(armId: string): IdleArmInfo | undefined {
		return this.idleArmPromptTracker.get(armId);
	}

	setIdleArmInfo(armId: string, info: IdleArmInfo): void {
		this.idleArmPromptTracker.set(armId, info);
	}

	// Snapshot for persistence
	createSnapshot(): StateSnapshot {
		return {
			brainState: { ...this.state },
			tasks: [...this.tasks],
			arms: new Map(this.arms),
			running: this.running,
			shuttingDown: this.shuttingDown,
			completedTaskCount: this.completedTaskCount,
			infrastructureHealth: { ...this.infrastructureHealth },
		};
	}

	restoreSnapshot(snapshot: StateSnapshot): void {
		this.state = { ...snapshot.brainState };
		this.tasks = [...snapshot.tasks];
		this.arms = new Map(snapshot.arms);
		this.running = snapshot.running;
		this.shuttingDown = snapshot.shuttingDown;
		this.completedTaskCount = snapshot.completedTaskCount;
		this.infrastructureHealth = { ...snapshot.infrastructureHealth };
	}

	// Cleanup
	clear(): void {
		this.arms.clear();
		this.tasks = [];
		this.initializedArmIds.clear();
		this.lastStuckState.clear();
		this.idleArmPromptTracker.clear();
		this.armDetectionTimes.clear();
		this.lastArmEventTime.clear();
		this.processedArmOutputMessageIds.clear();
		this.fileSubscriptions.clear();
		this.planFileHashes.clear();
		this.listeners = [];
	}
}
