import { MESSAGING_BRAIN_CATEGORIES, MESSAGING_FACETS, MESSAGING_MAILBOXES } from "./messaging-query";

import type { InteractionRegistry, KeyboardBinding } from "./interaction-definition";

/** Host shortcuts are part of validation, not bindings a view is allowed to replace. */
export const WORKBENCH_RESERVED_KEYS: readonly KeyboardBinding[] = [
	{ key: "p", modifiers: ["primary"], scope: "collection" },
	{ key: "p", modifiers: ["primary", "shift"], scope: "collection" },
	{ key: "k", modifiers: ["primary"], scope: "collection" },
	...["l", "r", "t", "w", "n", "f", "+", "-", "0"].flatMap((key): KeyboardBinding[] => [
		{ key, modifiers: ["primary"], scope: "collection" },
		{ key, modifiers: ["primary", "shift"], scope: "collection" },
	]),
];

export const MESSAGING_INTERACTIONS: InteractionRegistry = {
	operations: {
		"collection.previous": { label: "Previous item", kind: "navigation", target: "focused-item" },
		"collection.next": { label: "Next item", kind: "navigation", target: "focused-item" },
		"collection.open": { label: "Open item", kind: "navigation", command: "inbox.open", target: "focused-item",
			value: { type: "string" } },
		"collection.back": { label: "Back / dismiss", kind: "navigation" },
		"collection.search": { label: "Search", kind: "query", binding: "query.search", value: { type: "string" } },
		"inbox.facet": { label: "View", kind: "query", binding: "query.facet", value: { type: "string", choices: MESSAGING_FACETS } },
		"inbox.mailbox": { label: "Mailbox", kind: "query", binding: "query.mailbox", value: { type: "string", choices: MESSAGING_MAILBOXES } },
		"inbox.brain-category": { label: "Brain category", kind: "query", binding: "query.brainCategory", value: { type: "string", choices: MESSAGING_BRAIN_CATEGORIES } },
		"collection.sort": { label: "Timestamp order", kind: "query", binding: "query.sort.direction", value: { type: "string", choices: ["asc", "desc"] } },
		"collection.limit": { label: "Page size", kind: "query", binding: "query.limit", value: { type: "integer", minimum: 1, maximum: 200 } },
		"collection.presentation": { label: "Presentation", kind: "presentation", binding: "presentation.active", value: { type: "string", choices: ["grid", "cards", "timeline"] } },
		"collection.select": { label: "Toggle item selection", kind: "navigation", target: "focused-item" },
		"collection.select-branch": { label: "Toggle loaded branch selection", kind: "navigation", target: "loaded-descendants" },
		"collection.collapse": { label: "Collapse branch", kind: "navigation", target: "focused-item" },
		"collection.expand": { label: "Expand branch", kind: "navigation", target: "focused-item" },
		"collection.refresh": { label: "Refresh", kind: "navigation", command: "inbox.refresh" },
		"inbox.mark-read": { label: "Mark selected read", kind: "command", command: "inbox.mark-read", target: "selected-items",
			value: { type: "string-list" } },
		"collection.help": { label: "Show interaction help", kind: "navigation" },
	},
	profiles: {
		"collection-navigation": { schemaVersion: 1, id: "collection-navigation", bindings: [
			{ id: "previous", operation: "collection.previous", keyboard: { shared: [{ key: "ArrowUp", scope: "item" }, { key: "k", scope: "item" }] } },
			{ id: "next", operation: "collection.next", keyboard: { shared: [{ key: "ArrowDown", scope: "item" }, { key: "j", scope: "item" }] } },
			{ id: "open", operation: "collection.open", keyboard: { shared: [{ key: "Enter", scope: "item" }] }, cli: { subcommand: "show" } },
			{ id: "back", operation: "collection.back", keyboard: { shared: [{ key: "Escape", scope: "help" }] } },
			{ id: "search", operation: "collection.search", keyboard: { shared: [{ key: "/" }] }, cli: { flag: "--search", alias: "-s" } },
			{ id: "select", operation: "collection.select", keyboard: { shared: [{ key: "Space", scope: "item" }] } },
			{ id: "select-branch", operation: "collection.select-branch", keyboard: { shared: [{ key: "Space", scope: "tree" }] } },
			{ id: "collapse", operation: "collection.collapse", keyboard: { shared: [{ key: "ArrowLeft", scope: "item" }, { key: "ArrowLeft", scope: "tree" }] } },
			{ id: "expand", operation: "collection.expand", keyboard: { shared: [{ key: "ArrowRight", scope: "item" }, { key: "ArrowRight", scope: "tree" }] } },
			{ id: "refresh", operation: "collection.refresh", keyboard: { shared: [{ key: "r" }] } },
			{ id: "help", operation: "collection.help", keyboard: { shared: [{ key: "?" }] }, cli: { flag: "--help", alias: "-h" } },
		] },
	},
};
