import type { InboxProjectionItem } from "@/workbench/ProjectionInbox";
import {
	BRAIN_CARD_CREATOR,
	inferMessageCreator,
	USER_CARD_CREATOR,
} from "./card-creators";
import type {
	CardCreator,
	CardEnvelope,
	CardJsonObject,
	CardSurface,
} from "../../../types/adaptive-cards";

export interface CardFact {
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
		creator?: CardCreator;
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
		creator: options.creator ?? BRAIN_CARD_CREATOR,
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
	technicalFacts?: CardFact[];
	stateLabel?: string;
	stateColor?: "Default" | "Accent" | "Good" | "Warning" | "Attention";
	timestampLabel?: string;
	noticeText?: string;
	noticeTone?: "default" | "emphasis" | "good" | "warning" | "attention";
	creator?: CardCreator;
	targetRoute?: { pathname: string; search?: string; title?: string };
}): CardEnvelope {
	return {
		id: `detail:${input.kind}:${input.id}`,
		template: { id: "workbench.resource-detail", version: 2 },
		schemaVersion: "1.5",
		presentation: { surface: "detail", title: input.title },
		resource: { kind: input.kind, id: input.id },
		creator: input.creator ?? USER_CARD_CREATOR,
		createdAt: new Date().toISOString(),
		data: {
			kindLabel: input.kind.replace(/(^|\s)\S/g, (value) => value.toUpperCase()),
			title: input.title,
			description: input.description,
			facts: jsonFacts(input.facts),
			technicalFacts: jsonFacts(input.technicalFacts ?? []),
			stateLabel: input.stateLabel,
			stateColor: input.stateColor ?? "Default",
			timestampLabel: input.timestampLabel,
			noticeText: input.noticeText,
			noticeTone: input.noticeTone ?? "emphasis",
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
	creator?: CardCreator;
	taskFields?: {
		priority: "critical" | "high" | "normal" | "low";
		dueDate?: string | null;
		progress?: number;
		phase?: string | null;
		domain?: string | null;
	};
}): CardEnvelope {
	return {
		id: `edit:${input.kind}:${input.id}`,
		template: { id: "workbench.resource-editor", version: 2 },
		schemaVersion: "1.5",
		presentation: {
			surface: "editor",
			title: `Edit ${input.kind}: ${input.title}`,
		},
		resource: { kind: input.kind, id: input.id },
		creator: input.creator ?? USER_CARD_CREATOR,
		createdAt: new Date().toISOString(),
		data: {
			kindLabel: input.kind.toUpperCase(),
			title: input.title,
			description: input.description,
			showTaskFields: input.kind === "task",
			priority: input.taskFields?.priority ?? "normal",
			dueDate: input.taskFields?.dueDate?.slice(0, 10) ?? "",
			progress: input.taskFields?.progress ?? 0,
			phase: input.taskFields?.phase ?? "",
			domain: input.taskFields?.domain ?? "",
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
	creator?: CardCreator;
	sent?: boolean;
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
		creator: input.creator ?? inferMessageCreator(input.from, input.sent),
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
