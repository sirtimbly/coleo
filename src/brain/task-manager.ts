/**
 * Task Manager - Extracted from brain.ts
 * 
 * Manages task lifecycle: creation, assignment, and tracking.
 */

import type { Task, QueueMessage, MessageType } from "../types";
import { isBrainInboxMessageType } from "../types/brain-inbox";

export interface TaskManagerOptions {
	apiBaseUrl: string;
	apiKey: string;
	coleoDir: string;
}

export interface TaskManagerCallbacks {
	log: (message: string) => void;
	logActivity: (
		actor: string,
		action: string,
		entityId: string,
		meta?: Record<string, unknown>,
	) => void;
	createTaskViaApi: (task: Partial<Task>) => Promise<Task | null>;
	listPendingMessagesViaApi: (queue: string, limit: number) => Promise<Array<{
		id: string;
		from: string;
		to: string;
		type: string;
		payload: unknown;
		createdAt: string;
	}>>;
	markMessageStatusViaApi: (
		messageId: string,
		status: string,
		error?: string,
	) => Promise<boolean>;
	cleanupMessagesViaApi: (olderThanDays: number) => Promise<void>;
	handleArmMessage: (message: QueueMessage) => Promise<void>;
}

export class TaskManager {
	private options: TaskManagerOptions;
	private callbacks: TaskManagerCallbacks;

	constructor(options: TaskManagerOptions, callbacks: TaskManagerCallbacks) {
		this.options = options;
		this.callbacks = callbacks;
	}

	/**
	 * Create a new task
	 */
	async createTask(
		subject: string,
		description: string,
		mailThreadId?: string,
		priority?: "critical" | "high" | "normal" | "low",
		domain?: string,
		context?: Task["context"],
	): Promise<Task> {
		const requestedId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const task =
			(await this.callbacks.createTaskViaApi({
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

		this.callbacks.log(
			`Created task: ${task.subject} (${task.id}) domain=${domain || "any"} priority=${task.priority}`,
		);
		this.callbacks.logActivity("brain", "task_created", task.id, {
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
	async processArmQueue(): Promise<void> {
		try {
			const messages = await this.callbacks.listPendingMessagesViaApi("brain", 500);
			for (const message of messages) {
				try {
					const leased = await this.callbacks.markMessageStatusViaApi(
						message.id,
						"processing",
					);
					if (!leased) {
						continue;
					}

					await this.callbacks.handleArmMessage({
						id: message.id,
						from: message.from,
						to: message.to,
						type: message.type as MessageType,
						payload: message.payload,
						timestamp: new Date(message.createdAt),
					});

					await this.callbacks.markMessageStatusViaApi(message.id, "completed");
				} catch (err) {
					this.callbacks.log(`Error processing queue message ${message.id}: ${err}`);
					try {
						await this.callbacks.markMessageStatusViaApi(
							message.id,
							"failed",
							String(err),
						);
					} catch (markErr) {
						this.callbacks.log(
							`Failed to mark queue message ${message.id} as failed: ${markErr}`,
						);
					}
				}
			}

			// Periodically cleanup old messages (once per hour via modulo check)
			// Note: This should be handled by the caller based on poll interval
		} catch (err) {
			this.callbacks.log(`Error listing API queue messages: ${err}`);
		}
	}

	/**
	 * Validate if a message type is supported for brain inbox
	 */
	isValidBrainMessageType(type: string): boolean {
		return isBrainInboxMessageType(type as MessageType);
	}
}

export default TaskManager;
