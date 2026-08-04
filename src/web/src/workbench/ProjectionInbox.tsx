/**
 * Reusable inbox projection presentation.
 *
 * Brain, Arm, project-message, and attention inboxes share this virtualized
 * table, expandable card, search, bulk-action, and empty-state language.
 */

import {
	lazy,
	Suspense,
	useDeferredValue,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { Button } from "@heroui/react";
import { CheckCheck, RefreshCw } from "lucide-react";

import { ProjectionSearch } from "@/design-system/ProjectionControls";
import {
	WorkbenchEmptyState,
	WorkbenchHeader,
	WorkbenchToolbar,
} from "@/design-system/WorkbenchSurface";
import { cn } from "@/lib";

const InboxCardTable = lazy(() =>
	import("./InboxCardTable").then((module) => ({ default: module.InboxCardTable }))
);

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

export function ProjectionInbox({
	title,
	description,
	items,
	facets,
	activeFacet,
	onFacetChange,
	onOpen,
	renderCard,
	onRefresh,
	onMarkAllRead,
	toolbarContent,
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
	renderCard: (item: InboxProjectionItem) => ReactNode;
	onRefresh?: () => void;
	onMarkAllRead?: (items: InboxProjectionItem[]) => void;
	toolbarContent?: ReactNode;
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
				{toolbarContent}
				<ProjectionSearch
					value={search}
					onChange={setSearch}
					placeholder="Search this inbox"
					className="ml-auto max-w-xs"
				/>
			</WorkbenchToolbar>
			<div className="min-h-0 flex-1">
				{filtered.length === 0 ? (
					<WorkbenchEmptyState
						title={loading ? "Loading inbox" : "Nothing in this view"}
						description={loading
							? "Coleo is collecting the latest project state."
							: "New Brain, Arm, and project activity will stream into this projection."}
					/>
				) : (
					<Suspense
						fallback={(
							<WorkbenchEmptyState
								title="Preparing inbox"
								description="Building the expandable card table…"
							/>
						)}
					>
						<InboxCardTable
							items={filtered}
							renderCard={renderCard}
							onOpen={onOpen}
						/>
					</Suspense>
				)}
			</div>
		</div>
	);
}
