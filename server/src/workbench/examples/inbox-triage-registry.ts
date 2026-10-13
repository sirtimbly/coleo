import { normalizeMessagingQuery } from "../messaging-query";

import type { ResourceViewRegistry } from "../resource-view-definition";

/** Example recipe registrations; client implementations are supplied by each host, including the report demo. */
export const INBOX_TRIAGE_REGISTRY: ResourceViewRegistry = {
	resources: { messaging: {
		fields: ["title", "summary", "source", "timestamp", "unread", "requiresAction"],
		commands: ["inbox.open", "inbox.mark-read", "inbox.refresh"], parseQuery: normalizeMessagingQuery,
	} },
	widgets: {
		"resource.identity": { slots: ["toolbar.primary.identity"], bindings: [], capabilities: [] },
		"inbox.facet": { slots: ["toolbar.primary.context"], bindings: ["query.facet"], capabilities: [] },
		"collection.search": { slots: ["toolbar.primary.search"], bindings: ["query.search"], capabilities: [] },
		"inbox.mark-read": {
			slots: ["toolbar.primary.actions"], bindings: [], commands: ["inbox.mark-read"], capabilities: [],
		},
		"collection.refresh": {
			slots: ["toolbar.primary.actions"], bindings: [], commands: ["inbox.refresh"], capabilities: [],
		},
		"collection.freshness": { slots: ["toolbar.primary.state"], bindings: [], capabilities: [] },
		"collection.sort": { slots: ["toolbar.secondary.sort"], bindings: ["query.sort"], capabilities: [] },
		"collection.presentation": {
			slots: ["toolbar.secondary.presentation"], bindings: ["presentation.active"], capabilities: [],
		},
		"collection.selection": { slots: ["toolbar.secondary.selection"], bindings: [], capabilities: [] },
		"collection.hierarchy": {
			slots: ["toolbar.secondary.presentation"], bindings: ["hierarchy.expandedIds"], capabilities: [],
		},
		"collection.insights": { slots: ["toolbar.secondary.insights"], bindings: ["insights.active"], capabilities: [] },
	},
	renderers: {
		"collection.grid": { kinds: ["grid"], capabilities: ["table"] },
		"collection.cards": { kinds: ["cards"], capabilities: ["adaptive-cards"], fallback: "collection.list" },
		"messaging.timeline": { kinds: ["custom"], capabilities: ["timeline"], fallback: "collection.list" },
		"collection.list": { kinds: ["custom"], capabilities: ["text"] },
		"messaging.overview": { kinds: ["insight"], capabilities: ["charts"], fallback: "metadata.summary" },
		"metadata.summary": { kinds: ["insight"], capabilities: ["text"] },
	},
};
