/**
 * Shared presentation tokens for task and bug lifecycle statuses.
 *
 * Burndown charts and resource sheets use this single palette so a status keeps
 * the same label and color across analytical and editable projections.
 */

import type { StatusSeriesEntity } from "@/lib";

export interface ResourceStatusStyle {
	label: string;
	color: string;
}

export const RESOURCE_STATUS_STYLES: Record<
	StatusSeriesEntity,
	Record<string, ResourceStatusStyle>
> = {
	task: {
		pending: { label: "Pending", color: "#94a3b8" },
		claimed: { label: "Claimed", color: "#3b82f6" },
		in_progress: { label: "In progress", color: "#eab308" },
		blocked: { label: "Blocked", color: "#f97316" },
		completing: { label: "Completing", color: "#8b5cf6" },
		completed: { label: "Completed", color: "#22c55e" },
		failed: { label: "Failed", color: "#ef4444" },
		cancelled: { label: "Cancelled", color: "#64748b" },
	},
	bug: {
		open: { label: "Open", color: "#ef4444" },
		investigating: { label: "Investigating", color: "#eab308" },
		fixing: { label: "Fixing", color: "#3b82f6" },
		verifying: { label: "Verifying", color: "#8b5cf6" },
		resolved: { label: "Resolved", color: "#22c55e" },
		closed: { label: "Closed", color: "#64748b" },
	},
};

export function getResourceStatusStyle(
	entity: StatusSeriesEntity,
	status: string,
): ResourceStatusStyle | undefined {
	return RESOURCE_STATUS_STYLES[entity][status];
}
