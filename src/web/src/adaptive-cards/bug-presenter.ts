import { presentResourceDetail, presentResourceEditor } from "./presenters";

import type { Bug } from "@/lib";
import type { CardCreator, CardEnvelope } from "../../../types/adaptive-cards";

function label(value: string): string {
	return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function stateColor(bug: Bug): "Default" | "Accent" | "Good" | "Warning" | "Attention" {
	if (bug.status === "resolved" || bug.status === "closed") return "Good";
	if (bug.status === "open") return "Attention";
	if (bug.status === "investigating" || bug.status === "verifying") return "Warning";
	return "Accent";
}

export function presentBugCard(
	bug: Bug,
	editing: boolean,
	creator: CardCreator,
): CardEnvelope {
	if (editing) {
		return presentResourceEditor({
			id: bug.id,
			kind: "bug",
			title: bug.title,
			description: bug.description,
			resourceVersion: bug.updatedAt,
			creator,
		});
	}

	return presentResourceDetail({
		id: bug.id,
		kind: "bug",
		title: bug.title,
		description: bug.description,
		creator,
		facts: [
			{ label: "Priority", value: label(bug.priority) },
			{ label: "Assigned", value: bug.assigneeArmName ?? "Unassigned" },
		],
		technicalFacts: [
			{ label: "ID", value: bug.id },
			{ label: "Source", value: label(bug.source) },
			...(bug.sourceTaskId ? [{ label: "Source task", value: bug.sourceTaskId }] : []),
			{ label: "Created", value: new Date(bug.createdAt).toLocaleString() },
			{ label: "Updated", value: new Date(bug.updatedAt).toLocaleString() },
		],
		stateLabel: label(bug.status),
		stateColor: stateColor(bug),
		timestampLabel: `Updated ${new Date(bug.updatedAt).toLocaleDateString()}`,
		noticeText: bug.errorDetails?.trim() || undefined,
		noticeTone: "attention",
	});
}
