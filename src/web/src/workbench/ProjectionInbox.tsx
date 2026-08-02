/**
 * Reusable inbox projection presentation.
 *
 * Brain, Arm, project-message, and attention inboxes share this compact list,
 * selection, keyboard, search, bulk-action, and empty-state language.
 */

import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { CheckCheck, RefreshCw } from "lucide-react";

import { CollectionRow } from "@/design-system/CollectionRow";
import { ProjectionSearch } from "@/design-system/ProjectionControls";
import {
	WorkbenchEmptyState,
	WorkbenchHeader,
	WorkbenchToolbar,
} from "@/design-system/WorkbenchSurface";
import { cn } from "@/lib";

export type InboxItemKind =
	| "brain"
	| "arm"
	| "project"
	| "status"
	| "proposal"
	| "system";

export interface InboxProjectionItem {
	id: string;
	kind: InboxItemKind;
	title: string;
	summary: string;
	timestamp: string;
	source?: string;
	resourceId?: string;
	unread: boolean;
	requiresAction: boolean;
	severity?: "info" | "success" | "warning" | "danger";
	detail?: ReactNode;
}

export interface InboxFacet {
	id: string;
	label: string;
	kinds?: InboxItemKind[];
	predicate?: (item: InboxProjectionItem) => boolean;
}

function relativeTime(timestamp: string): string {
	const milliseconds = Date.now() - new Date(timestamp).getTime();
	const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function ProjectionInbox({
	title,
	description,
	items,
	facets,
	activeFacet,
	onFacetChange,
	onOpen,
	onRefresh,
	onMarkAllRead,
	loading = false,
	className,
}: {
	title: string;
	description?: string;
	items: InboxProjectionItem[];
	facets: InboxFacet[];
	activeFacet: string;
	onFacetChange: (facet: string) => void;
	onOpen: (item: InboxProjectionItem) => void;
	onRefresh?: () => void;
	onMarkAllRead?: (items: InboxProjectionItem[]) => void;
	loading?: boolean;
	className?: string;
}) {
	const [search, setSearch] = useState("");
	const deferredSearch = useDeferredValue(search);
	const facet = facets.find((item) => item.id === activeFacet) ?? facets[0];
	const filtered = useMemo(() => {
		const query = deferredSearch.trim().toLowerCase();
		return items.filter((item) => {
			const facetMatches = facet?.predicate
				? facet.predicate(item)
				: !facet?.kinds || facet.kinds.includes(item.kind);
			if (!facetMatches) return false;
			if (!query) return true;
			return `${item.title} ${item.summary} ${item.source ?? ""}`.toLowerCase().includes(query);
		});
	}, [deferredSearch, facet, items]);
	const unread = filtered.filter((item) => item.unread);

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
			<WorkbenchHeader
				title={title}
				description={description}
				actions={(
					<>
						{onMarkAllRead ? (
							<Button
								size="sm"
								variant="ghost"
								isDisabled={unread.length === 0}
								onPress={() => onMarkAllRead(unread)}
							>
								<CheckCheck className="h-3.5 w-3.5" />
								Mark read
							</Button>
						) : null}
						{onRefresh ? (
							<Button isIconOnly size="sm" variant="ghost" onPress={onRefresh} aria-label="Refresh inbox">
								<RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
							</Button>
						) : null}
					</>
				)}
			/>
			<WorkbenchToolbar>
				<div className="flex max-w-full items-center gap-1 overflow-x-auto">
					{facets.map((item) => {
						const count = items.filter((candidate) => item.predicate
							? item.predicate(candidate)
							: !item.kinds || item.kinds.includes(candidate.kind)).filter((candidate) =>
								candidate.unread || candidate.requiresAction
							).length;
						return (
							<button
								key={item.id}
								type="button"
								aria-pressed={activeFacet === item.id}
								onClick={() => onFacetChange(item.id)}
								className={cn(
									"h-7 shrink-0 border px-2.5 text-xs font-medium transition-colors",
									activeFacet === item.id
										? "border-accent/40 bg-accent/10 text-accent"
										: "border-transparent text-muted-foreground hover:border-border hover:bg-surface",
								)}
							>
								{item.label}
								{count > 0 ? <span className="ml-1.5 tabular-nums">{count}</span> : null}
							</button>
						);
					})}
				</div>
				<ProjectionSearch
					value={search}
					onChange={setSearch}
					placeholder="Search this inbox"
					className="ml-auto max-w-xs"
				/>
			</WorkbenchToolbar>
			<div className="min-h-0 flex-1 overflow-y-auto [content-visibility:auto]">
				{filtered.length === 0 ? (
					<WorkbenchEmptyState
						title={loading ? "Loading inbox" : "Nothing in this view"}
						description={loading
							? "Coleo is collecting the latest project state."
							: "New Brain, Arm, and project activity will stream into this projection."}
					/>
				) : filtered.map((item) => (
					<CollectionRow
						key={item.id}
						title={item.title}
						description={item.summary}
						meta={item.source}
						unread={item.unread}
						onOpen={() => onOpen(item)}
						leading={(
							<span className={cn(
								"h-2 w-2 rounded-full",
								item.severity === "danger" && "bg-danger",
								item.severity === "warning" && "bg-warning",
								item.severity === "success" && "bg-success",
								(!item.severity || item.severity === "info") && "bg-accent",
							)} />
						)}
						trailing={(
							<div className="flex items-center gap-2">
								{item.requiresAction ? (
									<span className="border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide text-warning">
										Action
									</span>
								) : null}
								<time dateTime={item.timestamp} title={new Date(item.timestamp).toLocaleString()}>
									{relativeTime(item.timestamp)}
								</time>
							</div>
						)}
					/>
				))}
			</div>
		</div>
	);
}
