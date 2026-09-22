/**
 * ApiEventStore - IEventStore implementation backed by the authenticated
 * Brain API event routes (GET /api/events/...).
 *
 * This is the only event-store implementation Brain runtime code may use.
 * Direct JetStream access belongs to the API server and ArmAgent; Brain
 * reads events exclusively through this API boundary (ADR-015, Phase 2 of
 * the Brain/API boundary execution plan).
 *
 * Only the reads Brain actually performs are supported (getArmEvents,
 * getRecentEvents). Stream-internals operations (sequences, metrics,
 * subject queries) have no API equivalent and throw explicitly.
 */
import {
	apiRequest,
	type ApiClientOptions,
} from "./brain-api-client";
import type {
	EventData,
	IEventStore,
	QueryOptions,
	StreamMetrics,
} from "../nats/jetstream-types";

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

interface WindowResponse {
	window?: {
		events?: Array<{
			type?: unknown;
			timestamp?: unknown;
			data?: unknown;
			sequence?: unknown;
		}>;
	};
}

interface RecentResponse {
	events?: Array<{
		type?: unknown;
		armId?: unknown;
		timestamp?: unknown;
		data?: unknown;
		sequence?: unknown;
	}>;
}

function toEventData(
	raw: {
		type?: unknown;
		armId?: unknown;
		timestamp?: unknown;
		data?: unknown;
		sequence?: unknown;
	},
	fallbackArmId?: string,
): EventData | null {
	if (typeof raw.type !== "string" || typeof raw.timestamp !== "string") {
		return null;
	}
	if (raw.data !== undefined && (typeof raw.data !== "object" || raw.data === null)) {
		return null;
	}
	const armId =
		typeof raw.armId === "string" ? raw.armId : fallbackArmId;
	return {
		type: raw.type,
		armId,
		data: (raw.data ?? {}) as Record<string, unknown>,
		timestamp: raw.timestamp,
		sequence: typeof raw.sequence === "number" ? raw.sequence : undefined,
	};
}

export class ApiEventStore implements IEventStore {
	private options?: ApiClientOptions;

	/**
	 * @param options API connection. When omitted the store reports
	 * unavailable and reads return [] (same degraded behavior Brain
	 * previously had with an uninitialized JetStream store).
	 */
	constructor(options?: ApiClientOptions) {
		this.options = options;
	}

	isInitialized(): boolean {
		return !!this.options;
	}

	private requireOptions(): ApiClientOptions {
		if (!this.options) {
			throw new Error("ApiEventStore is not configured with API options");
		}
		return this.options;
	}

	async getArmEvents(
		armId: string,
		limit = 200,
		since?: Date,
	): Promise<EventData[]> {
		const options = this.requireOptions();
		const windowMs = since
			? Math.max(0, Date.now() - since.getTime())
			: DEFAULT_WINDOW_MS;
		const response = await apiRequest<WindowResponse>({
			...options,
			endpoint: `/api/events/arms/${encodeURIComponent(armId)}/window?windowMs=${windowMs}&limit=${limit}`,
			method: "GET",
		});
		const raw = response?.window?.events ?? [];
		const events: EventData[] = [];
		for (const entry of raw) {
			const parsed = toEventData(entry, armId);
			if (parsed) events.push(parsed);
		}
		return events;
	}

	async getRecentEvents(limit = 50, since?: Date): Promise<EventData[]> {
		const options = this.requireOptions();
		const sinceMs = since ? Math.max(0, Date.now() - since.getTime()) : 0;
		const response = await apiRequest<RecentResponse>({
			...options,
			endpoint: `/api/events/recent?limit=${limit}&sinceMs=${sinceMs}`,
			method: "GET",
		});
		const raw = response?.events ?? [];
		const events: EventData[] = [];
		for (const entry of raw) {
			const parsed = toEventData(entry);
			if (parsed) events.push(parsed);
		}
		return events;
	}

	async getEvent(_sequence: number): Promise<EventData | null> {
		throw new Error("getEvent is not available through the API boundary");
	}

	async publishEvent(_subject: string, _data: EventData): Promise<void> {
		throw new Error(
			"publishEvent is not available on ApiEventStore; use publishEventViaApi (POST /api/events/internal/publish)",
		);
	}

	async queryEvents(_options: QueryOptions): Promise<EventData[]> {
		throw new Error("queryEvents is not available through the API boundary");
	}

	async getEventsByType(
		_eventType: string,
		_limit?: number,
	): Promise<EventData[]> {
		throw new Error(
			"getEventsByType is not available through the API boundary",
		);
	}

	async getStreamMetrics(): Promise<StreamMetrics> {
		throw new Error(
			"getStreamMetrics is not available through the API boundary",
		);
	}
}
