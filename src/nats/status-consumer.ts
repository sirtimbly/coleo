/**
 * Status Events Consumer
 * 
 * A specialized JetStream consumer for real-time status events.
 * Filters and processes arm status changes, task status changes, and system status events.
 */

import { DeliverPolicy, AckPolicy } from "nats";
import type { ConsumerInfo, JetStreamClient, JsMsg } from "nats";
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
	/** Optional JetStream client override for tests or embedded consumers */
	jetstream?: JetStreamClient;
}

type StatusEventType = StatusEvent["type"];

function isStatusEventType(type: string): type is StatusEventType {
	return (
		type === "arm.status_changed" ||
		type === "task.status_changed" ||
		type === "system.status"
	);
}

function valueAsString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
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
		const entityId = this.options.entityId;

		if (this.options.entityType) {
			// Filter by entity type
			switch (this.options.entityType) {
				case "arm":
					return [
						entityId
							? `coleo.events.arm.${entityId}.status_changed`
							: "coleo.events.arm.*.status_changed",
					];
				case "task":
					return [
						entityId
							? `coleo.events.task.${entityId}.status_changed`
							: "coleo.events.task.*.status_changed",
					];
				case "system":
					return ["coleo.events.system.status"];
			}
		}

		// All status events
		return [
			"coleo.events.arm.*.status_changed",
			"coleo.events.task.*.status_changed",
			"coleo.events.system.status",
		];
	}

	/**
	 * Consume messages from the consumer
	 */
	private async consumeMessages(): Promise<void> {
		if (!this.consumer) return;

		try {
			const js = this.options.jetstream ?? (eventStore as unknown as { js?: JetStreamClient }).js;
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
	parseStatusEvent(data: EventData): StatusEvent | null {
		// Determine event type and extract status info
		const eventType = data.type === "status_changed" ? "arm.status_changed" : data.type;
		if (!isStatusEventType(eventType)) return null;

		if (eventType === "arm.status_changed") {
			const newStatus = valueAsString(data.data.to) ?? valueAsString(data.data.newStatus);
			if (!newStatus) return null;

			return {
				type: "arm.status_changed",
				entityId: data.armId || valueAsString(data.data.armId) || "unknown",
				oldStatus: valueAsString(data.data.from) ?? valueAsString(data.data.oldStatus),
				newStatus,
				timestamp: data.timestamp,
				data: data.data,
			};
		}

		if (eventType === "task.status_changed") {
			const taskId = valueAsString(data.data.taskId) ?? valueAsString(data.data.id);
			const newStatus =
				valueAsString(data.data.to) ??
				valueAsString(data.data.newStatus) ??
				valueAsString(data.data.status);
			if (!taskId || !newStatus) return null;

			return {
				type: "task.status_changed",
				entityId: taskId,
				oldStatus: valueAsString(data.data.from) ?? valueAsString(data.data.oldStatus),
				newStatus,
				timestamp: data.timestamp,
				data: data.data,
			};
		}

		if (eventType === "system.status") {
			const newStatus = valueAsString(data.data.status) ?? valueAsString(data.data.newStatus);
			if (!newStatus) return null;

			return {
				type: "system.status",
				entityId: "system",
				newStatus,
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
