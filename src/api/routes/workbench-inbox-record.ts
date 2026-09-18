import { HttpError } from "../middleware";
import type { Database } from "bun:sqlite";
import type { WorkbenchInboxRecord } from "../../types/adaptive-cards";

// Detail identity is independent of inbox eligibility, sorting and pagination.
export function getWorkbenchInboxRecord(db: Database, itemKey: string): WorkbenchInboxRecord {
	const id = itemKey.slice(itemKey.indexOf(":") + 1);
	if (itemKey.startsWith("task:")) {
		const row = db.query(`SELECT id, subject, description, status, updated_at AS timestamp
			FROM tasks WHERE id = ?`).get(id) as {
			id: string; subject: string; description: string; status: string; timestamp: string;
		} | null;
		if (!row) throw HttpError.notFound("Inbox task not found");
		return { itemKey, source: "task", kind: "task", title: row.subject,
			summary: row.description.slice(0, 500), timestamp: row.timestamp,
			resource: { kind: "task", id }, severity: row.status === "failed" ? "danger" : "warning",
			requiresAction: row.status === "blocked" || row.status === "failed" };
	}
	if (itemKey.startsWith("bug:")) {
		const row = db.query(`SELECT title, description, priority, status, archived, updated_at AS timestamp
			FROM bugs WHERE id = ?`).get(id) as {
			title: string; description: string; priority: string; status: string; archived: number; timestamp: string;
		} | null;
		if (!row) throw HttpError.notFound("Inbox bug not found");
		return { itemKey, source: "bug", kind: "bug", title: row.title,
			summary: row.description.slice(0, 500), timestamp: row.timestamp,
			resource: { kind: "bug", id }, severity: row.priority === "critical" ? "danger" : "warning",
			requiresAction: !row.archived && ["critical", "high"].includes(row.priority) && !["resolved", "closed"].includes(row.status) };
	}
	if (itemKey === "brain:planning-gate") {
		const row = db.query(`SELECT healthy, error, last_check AS timestamp
			FROM infrastructure_health WHERE component = 'brain_planning_gate'`).get() as {
			healthy: number; error: string | null; timestamp: string;
		} | null;
		if (!row) throw HttpError.notFound("Planning gate not found");
		return { itemKey, source: "planning-gate", kind: "brain", title: row.healthy ? "Project planning is ready" : "Project planning is blocked",
			summary: row.error ?? "", timestamp: row.timestamp, resource: { kind: "brain", id: "planning-gate" },
			severity: row.healthy ? "info" : "danger", requiresAction: !row.healthy };
	}
	throw HttpError.notFound("Unsupported inbox record");
}
