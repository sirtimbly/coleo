import { z } from "zod";
import { getApiConfig } from "../context";
import { interactionBindingSchema, keyboardBindingSchema } from "../../workbench/interaction-definition";
import { MESSAGING_VIEW_REGISTRY } from "../../workbench/messaging-view-registry";
import { normalizeMessagingQuery, messagingQueryIdentity } from "../../workbench/messaging-query";
import { parseResourceViewDefinition } from "../../workbench/resource-view-definition";
import { validateMessagingResponseIdentity } from "../../workbench/messaging-response";
import { indexResourceHierarchy } from "../../workbench/resource-hierarchy";
import { resourceReference } from "../../workbench/resource-reference";

import type { ApiConfig } from "../context";
import type { MessagingCollectionPage } from "../../workbench/messaging-collection";
import type { MessagingQuery } from "../../workbench/messaging-query";
import type { ResolvedNamedResourceView } from "../../workbench/named-resource-views";
import type { MessagingReferenceTarget } from "../../workbench/resource-reference";

const feature = z.object({ id: z.string(), implementation: z.string().nullable(), diagnostic: z.string().optional() });
const binding = z.object({ id: z.string(), operation: z.string(), label: z.string(), kind: z.enum(["navigation", "query", "presentation", "command"]),
	binding: z.string().optional(), command: z.string().optional(), target: z.enum(["focused-item", "selected-items", "loaded-descendants"]).optional(),
	value: z.object({ type: z.enum(["string", "string-list", "integer"]), choices: z.array(z.string()).optional(), minimum: z.number().optional(), maximum: z.number().optional() }).optional(),
	keyboard: z.array(keyboardBindingSchema), cli: interactionBindingSchema.shape.cli, available: z.boolean(), diagnostic: z.string().optional(),
});
const resolved = z.object({ schemaVersion: z.literal(1), client: z.enum(["cli", "tui"]), definition: z.unknown(), queryIdentity: z.string(),
	features: z.object({ slots: z.record(z.string(), z.array(feature)), insights: z.array(feature), presentation: z.array(feature) }),
	interactions: z.object({ schemaVersion: z.literal(1), profileId: z.string().nullable(), client: z.enum(["cli", "tui"]), bindings: z.array(binding) }),
});
const mailbox = z.enum(["inbox", "sent", "archive"]);
const location = z.object({ mailbox, messageId: z.string(), seen: z.boolean() });
const thread = z.object({ id: z.string(), mailbox, subject: z.string(), revision: z.string().min(1),
	messageCount: z.number().int().min(1), mailboxMessageCount: z.number().int(), unreadCount: z.number().int(), lastMessageAt: z.string(),
	aliases: z.array(z.string()).optional(), diagnostics: z.array(z.object({ code: z.string(), nodeId: z.string(), message: z.string() })),
	hierarchy: z.object({ schemaVersion: z.literal(1), rootIds: z.array(z.string()), complete: z.boolean(),
		nodes: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), kind: z.enum(["group", "resource"]),
			selectable: z.boolean(), childrenComplete: z.boolean(), data: z.object({ title: z.string(), summary: z.string(), timestamp: z.string(),
				source: z.string(), unread: z.boolean(), requiresAction: z.boolean(), locations: z.array(location), from: z.string().optional(),
				mailbox: mailbox.optional(), messageId: z.string().optional(), missingParent: z.string().optional() }) })),
	}),
});
const detail = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("record"), itemKey: z.string() }),
	z.object({ kind: z.literal("thread"), threadId: z.string(), mailbox }),
	z.object({ kind: z.literal("message"), threadId: z.string(), messageId: z.string(), mailbox }),
	z.object({ kind: z.literal("activity"), activityId: z.string(), sequence: z.number().int().positive().nullable() }),
	z.object({ kind: z.literal("event"), itemKey: z.string(), sequence: z.number().int().positive() }),
]);

export class InboxApiError extends Error {
	/** Preserve an optional HTTP status for callers distinguishing API failures. */
	constructor(message: string, readonly status?: number) { super(message); this.name = "InboxApiError"; }
}
export type InboxFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Validate a resolved view's schema, client, resource, ID, and normalized query identity. */
export function parseResolvedInboxView(value: unknown, expectedId?: string, client: "cli" | "tui" = "cli"): ResolvedNamedResourceView {
	const result = resolved.parse(value);
	if (result.client !== client || result.interactions.client !== client) throw new Error("Named Inbox response belongs to another client");
	const definition = parseResourceViewDefinition(result.definition, MESSAGING_VIEW_REGISTRY);
	if (definition.resource !== "messaging" || expectedId && definition.id !== expectedId) throw new Error("Named Inbox response belongs to another resource or view");
	if (result.queryIdentity !== messagingQueryIdentity(normalizeMessagingQuery(definition.query))) throw new Error("Named Inbox query identity is incompatible");
	return { ...result, definition };
}

export class InboxApi {
	/** Bind authenticated API configuration, an injectable fetcher, and a bounded request timeout. */
	constructor(private readonly config: ApiConfig = getApiConfig(), private readonly fetcher: InboxFetch = fetch, private readonly timeoutMs = 15_000) {}
	/** Make a timed GET/POST request and convert transport and HTTP failures into safe Inbox errors. */
	async request(path: string, body?: unknown): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetcher(`${this.config.apiUrl.replace(/\/$/, "")}${path}`, {
				headers: this.config.headers, method: body === undefined ? "GET" : "POST",
				body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) { throw new InboxApiError(`Inbox API request failed (${error instanceof Error ? error.name : "network error"}). Check COLEO_API_URL and start the API server.`); }
		const value: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const parsed = z.object({ error: z.string() }).safeParse(value);
			throw new InboxApiError(parsed.success ? parsed.data.error : `Inbox API returned HTTP ${response.status}`, response.status);
		}
		if (value === null) throw new InboxApiError("Inbox API returned invalid JSON");
		return value;
	}
	/** Resolve and validate one named view for the selected terminal client. */
	async view(id: string, client: "cli" | "tui" = "cli"): Promise<ResolvedNamedResourceView> {
		return parseResolvedInboxView(await this.request(`/api/workbench/named-views/${encodeURIComponent(id)}?client=${client}`), id, client);
	}
	/** List API-published named view IDs. */
	async views(): Promise<readonly string[]> {
		return z.object({ schemaVersion: z.literal(1), views: z.array(z.string()) }).parse(await this.request("/api/workbench/named-views")).views;
	}
	/** Resolve a stable reference to its canonical resource and supported detail endpoint. */
	async reference(reference: string, profileId: string): Promise<MessagingReferenceTarget> {
		const result = z.object({ schemaVersion: z.literal(1), id: z.string(), detail, complete: z.boolean(), diagnostics: z.array(z.string()) }).parse(
			await this.request(`/api/workbench/inbox/references/${encodeURIComponent(reference)}?profileId=${encodeURIComponent(profileId)}`));
		if (result.id !== reference && resourceReference(result.id) !== reference) throw new Error("Reference lookup returned a different resource");
		return result;
	}
	/** Fetch one query page, checking response identity and validating loaded thread hierarchies. */
	async page(query: MessagingQuery, cursor?: string): Promise<MessagingCollectionPage> {
		const params = new URLSearchParams({ query: JSON.stringify(query) });
		if (cursor) params.set("cursor", cursor);
		const value = await this.request(`/api/workbench/inbox?${params}`);
		const identity = z.object({ schemaVersion: z.number().optional(), queryId: z.string().optional() }).parse(value);
		validateMessagingResponseIdentity(identity, messagingQueryIdentity(query));
		const page = z.object({ schemaVersion: z.literal(1), queryId: z.string(), query: z.unknown(), cursor: z.string().nullable(), nextCursor: z.string().nullable(),
			items: z.array(z.object({ id: z.string().min(1), revision: z.string(), sourceId: z.enum(["records", "mail", "activity", "events"]),
				kind: z.enum(["brain", "arm", "project", "status", "proposal", "system"]), representation: z.enum(["resource", "event", "thread", "message"]),
				title: z.string(), summary: z.string(), timestamp: z.iso.datetime({ offset: true }), source: z.string(), unread: z.boolean(), requiresAction: z.boolean(),
				severity: z.enum(["info", "success", "warning", "danger"]), detail, thread: thread.optional(), locations: z.array(location).optional(),
				resource: z.object({ kind: z.string(), id: z.string() }).optional(),
				actor: z.object({ kind: z.enum(["brain", "arm", "user"]), id: z.string(), displayName: z.string() }).optional(),
				facts: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
			}).passthrough()),
			sources: z.array(z.object({ id: z.enum(["records", "mail", "activity", "events"]), status: z.enum(["fresh", "stale", "unavailable"]),
				revision: z.string().nullable(), asOf: z.string().nullable(), complete: z.boolean(), error: z.object({ code: z.string(), message: z.string() }).optional() })),
			summaries: z.object({ scope: z.literal("query"), total: z.number().nullable(), unread: z.number().nullable(), requiresAction: z.number().nullable(), complete: z.boolean() }),
		}).parse(value);
		if (messagingQueryIdentity(normalizeMessagingQuery(page.query)) !== page.queryId) throw new Error("Messaging page query does not match its identity");
		if (page.cursor !== (cursor ?? null)) throw new Error("Messaging response belongs to another page");
		const result: MessagingCollectionPage = { ...page, query: normalizeMessagingQuery(page.query) };
		for (const item of result.items) {
			if (item.representation === "thread" && !item.thread) throw new Error("Messaging thread is missing reply context");
			if (item.thread) indexResourceHierarchy(item.thread.hierarchy);
		}
		return result;
	}
}
