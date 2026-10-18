import inboxTriage from "./examples/inbox-triage.json" with { type: "json" };
import { resolveInteractions } from "./interaction-definition";
import { MESSAGING_INTERACTIONS, WORKBENCH_RESERVED_KEYS } from "./messaging-interactions";
import { normalizeMessagingQuery, messagingQueryIdentity } from "./messaging-query";
import { MESSAGING_VIEW_REGISTRY } from "./messaging-view-registry";
import { parseResourceViewDefinition, resolveResourceViewFeatures } from "./resource-view-definition";

import type { InteractionClient, ResolvedInteractions } from "./interaction-definition";
import type { ResourceViewDefinition } from "./resource-view-definition";

export const NAMED_RESOURCE_VIEWS: Readonly<Record<string, unknown>> = {
	"inbox-triage": inboxTriage,
};

const CLIENT_CAPABILITIES: Readonly<Record<InteractionClient, readonly string[]>> = {
	web: ["table", "adaptive-cards", "text"],
	cli: ["table", "text"],
	tui: ["table", "text"],
	native: ["table", "adaptive-cards", "text", "timeline"],
};
// These describe the bounded browser adapter, the one-shot CLI, the live TUI mappings,
// and the native macOS client (SwiftUI grid/cards/timeline renderers).
// Resolving client capabilities does not start a client or a live transport.
const CLIENT_OPERATIONS: Readonly<Record<InteractionClient, readonly string[]>> = {
	web: ["collection.search", "collection.refresh", "collection.help", "collection.back"],
	cli: ["collection.search", "inbox.facet", "inbox.mailbox", "inbox.brain-category", "collection.sort", "collection.limit",
		"collection.presentation", "collection.open", "inbox.mark-read", "collection.help"],
	tui: Object.keys(MESSAGING_INTERACTIONS.operations),
	native: Object.keys(MESSAGING_INTERACTIONS.operations),
};

export interface ResolvedNamedResourceView {
	readonly schemaVersion: 1;
	readonly client: InteractionClient;
	readonly definition: ResourceViewDefinition;
	readonly queryIdentity: string;
	readonly features: ReturnType<typeof resolveResourceViewFeatures>;
	readonly interactions: ResolvedInteractions;
}

/** Resource semantics are identical across clients; only feature/interaction implementations differ. */
/** Resolve one named definition for a client, including validated features and effective interactions. */
export function resolveNamedResourceView(value: unknown, client: InteractionClient): ResolvedNamedResourceView {
	const definition = parseResourceViewDefinition(value, MESSAGING_VIEW_REGISTRY);
	return { schemaVersion: 1, client, definition,
		queryIdentity: messagingQueryIdentity(normalizeMessagingQuery(definition.query)),
		features: resolveResourceViewFeatures(definition, MESSAGING_VIEW_REGISTRY, new Set(CLIENT_CAPABILITIES[client])),
		interactions: resolveInteractions(definition, MESSAGING_INTERACTIONS, client, new Set(CLIENT_OPERATIONS[client]),
			{ web: WORKBENCH_RESERVED_KEYS }),
	};
}

/** Look up a registered named view and resolve it for the requested client, if present. */
export function getNamedResourceView(id: string, client: InteractionClient): ResolvedNamedResourceView | undefined {
	const value = Object.hasOwn(NAMED_RESOURCE_VIEWS, id) ? NAMED_RESOURCE_VIEWS[id] : undefined;
	return value ? resolveNamedResourceView(value, client) : undefined;
}
