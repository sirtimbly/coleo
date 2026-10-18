import { normalizeMessagingQuery } from "./messaging-query";
import { MESSAGING_INTERACTIONS } from "./messaging-interactions";

import type { ResourceViewRegistry } from "./resource-view-definition";

/** Messaging recipe registrations shared by API resolution, validation, and the illustrative report. */
export const MESSAGING_VIEW_REGISTRY: ResourceViewRegistry = {
	interactions: MESSAGING_INTERACTIONS,
	resources: { messaging: {
		fields: ["title", "summary", "source", "timestamp", "unread", "requiresAction"],
		commands: ["inbox.open", "inbox.mark-read", "inbox.refresh"], parseQuery: normalizeMessagingQuery,
	} },
	widgets: {
		"resource.identity": { slots: ["toolbar.primary.identity"], bindings: [], capabilities: [], layout: { priority: 0, collapse: "hide", overflow: false } },
		"inbox.facet": { slots: ["toolbar.primary.context"], bindings: ["query.facet"], capabilities: [], layout: { kind: "choice", priority: 90, collapse: "value", overflow: true } },
		"collection.search": { slots: ["toolbar.primary.search"], bindings: ["query.search"], capabilities: [], layout: { kind: "value", priority: 100, collapse: "value", overflow: false } },
		"inbox.mark-read": { slots: ["toolbar.primary.actions"], bindings: [], commands: ["inbox.mark-read"], capabilities: [], layout: { priority: 60, collapse: "icon", overflow: true } },
		"collection.refresh": { slots: ["toolbar.primary.actions"], bindings: [], commands: ["inbox.refresh"], capabilities: [], layout: { priority: 70, collapse: "icon", overflow: true } },
		"collection.freshness": { slots: ["toolbar.primary.state"], bindings: [], capabilities: [], layout: { priority: 20, collapse: "none", overflow: true } },
		"collection.count": { slots: ["toolbar.primary.state"], bindings: [], capabilities: [], layout: { priority: 20, collapse: "none", overflow: true } },
		"collection.sort": { slots: ["toolbar.secondary.sort"], bindings: ["query.sort"], capabilities: [], layout: { kind: "choice", priority: 40, collapse: "value", overflow: true } },
		"collection.presentation": { slots: ["toolbar.secondary.presentation"], bindings: ["presentation.active"], capabilities: [], layout: { kind: "choice", priority: 30, collapse: "value", overflow: true } },
		"collection.selection": { slots: ["toolbar.secondary.selection"], bindings: [], capabilities: [], layout: { priority: 80, collapse: "none", overflow: true } },
		"collection.hierarchy": { slots: ["toolbar.secondary.presentation"], bindings: ["hierarchy.expandedIds"], capabilities: [] },
		"collection.insights": { slots: ["toolbar.secondary.insights"], bindings: ["insights.active"], capabilities: [], layout: { kind: "toggle", priority: 10, collapse: "icon", overflow: true } },
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
