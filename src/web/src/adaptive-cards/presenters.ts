import type { InboxProjectionItem } from "@/workbench/ProjectionInbox";
import type {
	CardEnvelope,
	CardJsonObject,
	CardSurface,
} from "../../../types/adaptive-cards";

interface CardFact {
	label: string;
	value: string;
}

function jsonFacts(facts: CardFact[]): CardJsonObject[] {
	return facts.map((fact) => ({ label: fact.label, value: fact.value }));
}

function toneForSeverity(severity: InboxProjectionItem["severity"]): string {
	if (severity === "danger") return "attention";
	if (severity === "warning") return "warning";
	if (severity === "success") return "good";
	return "emphasis";
}

export function presentInboxItem(
	item: InboxProjectionItem,
	options: {
		surface?: CardSurface;
		targetRoute?: { pathname: string; search?: string; title?: string };
		facts?: CardFact[];
	} = {},
): CardEnvelope {
	const targetRoute = options.targetRoute;
	return {
		id: item.id,
		template: { id: "workbench.event", version: 1 },
		schemaVersion: "1.5",
		presentation: {
			surface: options.surface ?? "inbox",
			compact: options.surface === "stream",
			title: item.title,
		},
		resource: item.resourceId
			? { kind: item.kind, id: item.resourceId }
			: undefined,
		createdAt: item.timestamp,
		data: {
			eyebrow: item.source ?? item.kind,
			title: item.title,
			summary: item.summary,
			tone: toneForSeverity(item.severity),
			timestampLabel: new Date(item.timestamp).toLocaleString(),
			requiresAction: item.requiresAction,
			facts: jsonFacts(options.facts ?? []),
			openLabel: targetRoute ? "Open target" : undefined,
			openVerb: targetRoute ? "resource.open" : undefined,
			targetRoute: targetRoute
				? {
					pathname: targetRoute.pathname,
					search: targetRoute.search ?? "",
					title: targetRoute.title ?? item.title,
				}
				: undefined,
		},
	};
}

export function presentResourceDetail(input: {
	id: string;
	kind: string;
	title: string;
	description?: string;
	facts: CardFact[];
	targetRoute?: { pathname: string; search?: string; title?: string };
}): CardEnvelope {
	return {
		id: `detail:${input.kind}:${input.id}`,
		template: { id: "workbench.resource-detail", version: 1 },
		schemaVersion: "1.5",
		presentation: { surface: "detail", title: input.title },
		resource: { kind: input.kind, id: input.id },
		createdAt: new Date().toISOString(),
		data: {
			kindLabel: input.kind.replace(/(^|\s)\S/g, (value) => value.toUpperCase()),
			title: input.title,
			description: input.description,
			facts: jsonFacts(input.facts),
			openVerb: input.targetRoute ? "resource.open" : undefined,
			openLabel: input.targetRoute ? "Open full view" : undefined,
			targetRoute: input.targetRoute
				? {
					pathname: input.targetRoute.pathname,
					search: input.targetRoute.search ?? "",
					title: input.targetRoute.title ?? input.title,
				}
				: undefined,
		},
	};
}

export function presentResourceEditor(input: {
	id: string;
	kind: "task" | "bug";
	title: string;
	description: string;
	resourceVersion?: string;
}): CardEnvelope {
	return {
		id: `edit:${input.kind}:${input.id}`,
		template: { id: "workbench.resource-editor", version: 1 },
		schemaVersion: "1.5",
		presentation: {
			surface: "editor",
			title: `Edit ${input.kind}: ${input.title}`,
		},
		resource: { kind: input.kind, id: input.id },
		createdAt: new Date().toISOString(),
		data: {
			title: input.title,
			description: input.description,
			saveVerb: `${input.kind}.update`,
			resourceVersion: input.resourceVersion,
		},
	};
}

export function presentMessage(input: {
	id: string;
	from: string;
	subject: string;
	preview: string;
	timestamp: string;
	surface?: CardSurface;
	canArchive?: boolean;
}): CardEnvelope {
	return {
		id: `message:${input.id}`,
		template: { id: "workbench.message", version: 1 },
		schemaVersion: "1.5",
		presentation: {
			surface: input.surface ?? "detail",
			title: input.subject,
		},
		resource: { kind: "message", id: input.id },
		createdAt: input.timestamp,
		data: {
			from: input.from,
			subject: input.subject,
			preview: input.preview,
			timestampLabel: new Date(input.timestamp).toLocaleString(),
			openVerb: null,
			canArchive: input.canArchive ?? false,
		},
	};
}
