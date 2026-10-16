/**
 * Compact immutable-event timeline.
 *
 * Timelines are diagnostic projections, distinct from inbox attention and
 * sampled metrics. They keep dense technical detail available without turning
 * every event into a notification.
 */

import { useDeferredValue, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { RefreshCw } from "lucide-react";

import { CollectionRow } from "@/design-system/CollectionRow";
import { ProjectionSearch } from "@/design-system/ProjectionControls";
import {
	WorkbenchEmptyState,
	WorkbenchHeader,
	WorkbenchToolbar,
} from "@/design-system/WorkbenchSurface";
import type { ActivityEntry } from "@/lib";

function eventTone(action: string): string {
	const value = action.toLowerCase();
	if (value.includes("error") || value.includes("failed")) return "bg-danger";
	if (value.includes("blocked") || value.includes("warning")) return "bg-warning";
	if (value.includes("completed") || value.includes("resolved")) return "bg-success";
	return "bg-accent";
}

export function EventTimeline({
	events,
	total,
	loading,
	onRefresh,
	onLoadMore,
	hasMore,
}: {
	events: ActivityEntry[];
	total: number;
	loading: boolean;
	onRefresh: () => void;
	onLoadMore?: () => void;
	hasMore?: boolean;
}) {
	const [search, setSearch] = useState("");
	const query = useDeferredValue(search).trim().toLowerCase();
	const visible = useMemo(() => query
		? events.filter((event) =>
			`${event.actor} ${event.action} ${event.target ?? ""}`.toLowerCase().includes(query)
		)
		: events, [events, query]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkbenchHeader
				title="Event timeline"
				description={`${total} immutable project events`}
				actions={(
					<Button isIconOnly size="sm" variant="ghost" onPress={onRefresh} aria-label="Refresh events">
						<RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
					</Button>
				)}
			/>
			<WorkbenchToolbar>
				<ProjectionSearch value={search} onChange={setSearch} placeholder="Filter events" className="max-w-sm" />
				<span className="ml-auto text-xs text-muted-foreground">
					Events are not inbox notifications or metric samples
				</span>
			</WorkbenchToolbar>
			<div className="min-h-0 flex-1 overflow-auto">
				{visible.length === 0 ? (
					<WorkbenchEmptyState
						title={loading ? "Loading events" : "No matching events"}
						description="The complete diagnostic event stream appears here."
					/>
				) : visible.map((event) => (
					<CollectionRow
						key={event.id}
						title={event.action.replaceAll("_", " ").replaceAll(".", " ")}
						description={event.target ?? "No target"}
						meta={event.actor}
						leading={<span className={`h-2 w-2 rounded-full ${eventTone(event.action)}`} />}
						trailing={(
							<time dateTime={event.timestamp} title={new Date(event.timestamp).toLocaleString()}>
								{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
							</time>
						)}
					/>
				))}
				{hasMore && onLoadMore ? (
					<div className="flex justify-center border-t border-border p-3">
						<Button size="sm" variant="ghost" onPress={onLoadMore} isDisabled={loading}>
							Load older events
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}
