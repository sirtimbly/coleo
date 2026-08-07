import { presentResourceDetail, presentResourceEditor } from "./presenters";

import type { Task } from "@/lib/api";
import type { CardCreator, CardEnvelope } from "../../../types/adaptive-cards";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

function formatDate(value: string): string {
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? value : DATE_FORMAT.format(timestamp);
}

function formatDateTime(value: string): string {
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? value : DATE_TIME_FORMAT.format(timestamp);
}

export function stripCardMarkdown(value: string): string {
	return value
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/(^|\s)#{1,6}\s+/g, "$1")
		.replace(/(\*\*|__|`)/g, "")
		.replace(/^\s*[-*_]{3,}\s*$/gm, "")
		.replace(/\s+[-*_]{3,}\s*$/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

function comparable(value: string): string {
	return stripCardMarkdown(value)
		.toLocaleLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export function taskCardDescription(task: Task): string | undefined {
	const title = comparable(task.subject);
	const paragraphs = task.description
		.split(/\n\s*\n/)
		.map(stripCardMarkdown)
		.filter(Boolean)
		.flatMap((paragraph) => {
			const phaseMatch = paragraph.match(/^plan phase\s*:\s*(.+)$/i);
			if (phaseMatch) return [];
			const objectiveMatch = paragraph.match(/^task objective\s*:\s*(.+)$/is);
			if (objectiveMatch?.[1]) {
				const objective = objectiveMatch[1].trim();
				const normalized = comparable(objective);
				if (normalized === title || normalized.startsWith(title) || title.startsWith(normalized)) {
					return [];
				}
				return [objective];
			}
			const contextMatch = paragraph.match(/^phase context\s*:\s*(.+)$/is);
			return contextMatch?.[1] ? [`Context — ${contextMatch[1].trim()}`] : [paragraph];
		});

	const unique = paragraphs.filter((paragraph, index) => {
		const normalized = comparable(paragraph);
		if (!normalized || normalized === title) return false;
		return paragraphs.findIndex((candidate) => comparable(candidate) === normalized) === index;
	});
	return unique.length > 0 ? unique.join("\n\n") : undefined;
}

function taskStateColor(task: Task): "Default" | "Accent" | "Good" | "Warning" | "Attention" {
	if (task.status === "completed") return "Good";
	if (task.status === "blocked" || task.status === "failed" || task.status === "cancelled") return "Attention";
	if (task.status === "draft") return "Warning";
	if (task.status === "claimed" || task.status === "in_progress" || task.status === "completing") return "Accent";
	return "Default";
}

function label(value: string): string {
	return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function presentTaskCard(
	task: Task,
	editing: boolean,
	creator: CardCreator,
): CardEnvelope {
	if (editing) {
		return presentResourceEditor({
			id: task.id,
			kind: "task",
			title: task.subject,
			description: task.description,
			resourceVersion: task.updatedAt,
			creator,
			taskFields: {
				priority: task.priority,
				dueDate: task.dueDate,
				progress: task.progress,
				phase: task.phase,
				domain: task.domain,
			},
		});
	}

	const completedChecklist = task.checklist?.filter((item) => item.completed).length ?? 0;
	const primaryFacts = [
		{ label: "Priority", value: label(task.priority) },
		{ label: "Assigned", value: task.assignedArmName ?? "Unassigned" },
		...(task.progress === undefined
			? []
			: [{ label: "Progress", value: `${Math.round(task.progress)}%` }]),
		...(task.dueDate ? [{ label: "Due", value: formatDate(task.dueDate) }] : []),
		...(task.checklist?.length
			? [{ label: "Checklist", value: `${completedChecklist} of ${task.checklist.length} complete` }]
			: []),
	];
	const technicalFacts = [
		{ label: "ID", value: task.id },
		...(task.phase ? [{ label: "Phase", value: task.phase }] : []),
		...(task.classification ? [{ label: "Classification", value: task.classification }] : []),
		...(task.domain ? [{ label: "Domain", value: task.domain }] : []),
		{ label: "Source", value: label(task.sourceType) },
		...(task.sourceRef ? [{ label: "Source reference", value: task.sourceRef }] : []),
		{ label: "Created", value: formatDateTime(task.createdAt) },
		{ label: "Updated", value: formatDateTime(task.updatedAt) },
	];
	const blockedReason = task.blockedReason?.trim();
	const noticeText = blockedReason
		? `Blocked — ${stripCardMarkdown(blockedReason)}`
		: task.dependencyBlocked
			? "Blocked by an unfinished dependency."
			: undefined;

	return presentResourceDetail({
		id: task.id,
		kind: "task",
		title: stripCardMarkdown(task.subject),
		description: taskCardDescription(task),
		creator,
		facts: primaryFacts,
		technicalFacts,
		stateLabel: label(task.status),
		stateColor: taskStateColor(task),
		timestampLabel: `Created ${formatDate(task.createdAt)}`,
		noticeText,
		noticeTone: "warning",
	});
}
