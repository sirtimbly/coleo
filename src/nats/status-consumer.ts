/**
 * Status Events Consumer
 * 
 * A specialized JetStream consumer for real-time status events.
 * Filters and processes arm status changes, task status changes, and system status events.
 */

import { DeliverPolicy, AckPolicy } from "nats";
import type { ConsumerConfig, ConsumerInfo, JsMsg } from "nats";
import { eventStore, EventStore, type EventData } from "./jetstream";

export interface StatusEvent {
	type: "arm.status_changed" | "task.status_changed" | "system.status";
	entityId: string;
	oldStatus?: string;
	newStatus: string;
	timestamp: string;
	data: Record<string, unknown>;
}

export interface StatusConsumerOptions {
	/** Consumer name (must be unique) */
	name: string;
	/** Callback for status events */
	onStatusChange: (event: StatusEvent) => void | Promise<void>;
	/** Optional filter by entity type */
	entityType?: "arm" | "task" | "system";
	/** Optional filter by specific entity ID */
	entityId?: string;
}

/**
 * StatusEventsConsumer provides real-time monitoring of status changes
 * using a durable JetStream consumer with appropriate filtering.
 */
export class StatusEventsConsumer {
	private consumer: ConsumerInfo | null = null;
	private isRunning = false;
	private options: StatusConsumerOptions;

	constructor(options: StatusConsumerOptions) {
		this.options = options;
	}

	/**
	 * Start consuming status events
	 */
	async start(): Promise<void> {
		if (!eventStore.isInitialized()) {
			throw new Error("EventStore not initialized");
		}

		if (this.isRunning) {
			console.log(`[StatusConsumer:${this.options.name}] Already running`);
			return;
		}

		// Build filter subject based on options
		const filterSubjects = this.buildFilterSubjects();

		// Create durable consumer
		// Cast to EventStore to access consumer management methods
		const store = eventStore as EventStore;
		this.consumer = await store.createDurableConsumer(this.options.name, {
			durable_name: this.options.name,
			filter_subjects: filterSubjects,
			deliver_policy: DeliverPolicy.Last, // Start from latest
			ack_policy: AckPolicy.None, // Auto-ack for status events
		});

		this.isRunning = true;
		console.log(
			`[StatusConsumer:${this.options.name}] Started with filters:`,
			filterSubjects,
		);

		// Start consuming messages
		this.consumeMessages();
	}

	/**
	 * Stop consuming status events
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
		console.log(`[StatusConsumer:${this.options.name}] Stopped`);
	}

	/**
	 * Delete the consumer (cleanup)
	 */
	async delete(): Promise<void> {
		// Cast to EventStore to access consumer management methods
		const store = eventStore as EventStore;
		await store.deleteConsumer(this.options.name);
		this.consumer = null;
		console.log(`[StatusConsumer:${this.options.name}] Deleted`);
	}

	/**
	 * Build filter subjects based on options
	 */
	private buildFilterSubjects(): string[] {
		const subjects: string[] = [];

		if (this.options.entityType) {
			// Filter by entity type
			switch (this.options.entityType) {
				case "arm":
					subjects.push("coleo.events.arm.status_changed");
					break;
				case "task":
					subjects.push("coleo.events.task.status_changed");
					break;
				case "system":
					subjects.push("coleo.events.system.status");
					break;
			}
		} else {
			// All status events
			subjects.push("coleo.events.*.status_changed");
			subjects.push("coleo.events.system.status");
		}

		return subjects;
	}

	/**
	 * Consume messages from the consumer
	 */
	private async consumeMessages(): Promise<void> {
		if (!this.consumer) return;

		try {
			// Get the JetStream client
			const js = (eventStore as any).js;
			if (!js) {
				console.error(`[StatusConsumer:${this.options.name}] JetStream not available`);
				return;
			}

			// Get consumer instance
			const consumer = await js.consumers.get("coleo-events", this.options.name);

			// Consume messages
			while (this.isRunning) {
				try {
					const messages = await consumer.fetch({ max_messages: 10, expires: 5000 });

					for await (const msg of messages) {
						await this.processMessage(msg);
					}
				} catch (err) {
					if (this.isRunning) {
						console.error(
							`[StatusConsumer:${this.options.name}] Error consuming messages:`,
							err,
						);
					}
				}
			}
		} catch (err) {
			console.error(`[StatusConsumer:${this.options.name}] Fatal error:`, err);
		}
	}

	/**
	 * Process a single message
	 */
	private async processMessage(msg: JsMsg): Promise<void> {
		try {
			const data = JSON.parse(msg.string()) as EventData;

			// Convert to StatusEvent
			const statusEvent = this.parseStatusEvent(data);
			if (!statusEvent) return;

			// Filter by entity ID if specified
			if (this.options.entityId && statusEvent.entityId !== this.options.entityId) {
				return;
			}

			// Call the handler
			await this.options.onStatusChange(statusEvent);
		} catch (err) {
			console.error(`[StatusConsumer:${this.options.name}] Error processing message:`, err);
		}
	}

	/**
	 * Parse EventData into StatusEvent
	 */
	private parseStatusEvent(data: EventData): StatusEvent | null {
		// Determine event type and extract status info
		if (data.type === "arm.status_changed") {
			return {
				type: "arm.status_changed",
				entityId: data.armId || (data.data.armId as string) || "unknown",
				oldStatus: data.data.from as string,
				newStatus: data.data.to as string,
				timestamp: data.timestamp,
				data: data.data,
			};
		}

		if (data.type === "task.status_changed") {
			return {
				type: "task.status_changed",
				entityId: data.data.taskId as string,
				oldStatus: data.data.from as string,
				newStatus: data.data.to as string,
				timestamp: data.timestamp,
				data: data.data,
			};
		}

		if (data.type === "system.status") {
			return {
				type: "system.status",
				entityId: "system",
				newStatus: data.data.status as string,
				timestamp: data.timestamp,
				data: data.data,
			};
		}

		return null;
	}
}

/**
 * Create a status consumer for monitoring arm status changes
 */
export async function createArmStatusConsumer(
	name: string,
	onStatusChange: (event: StatusEvent) => void | Promise<void>,
	armId?: string,
): Promise<StatusEventsConsumer> {
	const consumer = new StatusEventsConsumer({
		name: `arm-status-${name}`,
		onStatusChange,
		entityType: "arm",
		entityId: armId,
	});

	await consumer.start();
	return consumer;
}

/**
 * Create a status consumer for monitoring task status changes
 */
export async function createTaskStatusConsumer(
	name: string,
	onStatusChange: (event: StatusEvent) => void | Promise<void>,
	taskId?: string,
): Promise<StatusEventsConsumer> {
	const consumer = new StatusEventsConsumer({
		name: `task-status-${name}`,
		onStatusChange,
		entityType: "task",
		entityId: taskId,
	});

	await consumer.start();
	return consumer;
}

/**
 * Create a status consumer for monitoring all status changes
 */
export async function createSystemStatusConsumer(
	name: string,
	onStatusChange: (event: StatusEvent) => void | Promise<void>,
): Promise<StatusEventsConsumer> {
	const consumer = new StatusEventsConsumer({
		name: `system-status-${name}`,
		onStatusChange,
	});

	await consumer.start();
	return consumer;
}
