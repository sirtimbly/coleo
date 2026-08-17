/**
 * Reusable inbox projection presentation.
 *
 * Brain, Arm, project-message, and attention inboxes share card and virtualized
 * data-grid modes, search, bulk-action, and empty-state language.
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
import { CheckCheck, Inbox, Mail, RefreshCw } from "lucide-react";

import {
	ProjectionFilterMenu,
	ProjectionSearch,
	type ProjectionFilterOption,
} from "@/design-system/ProjectionControls";
import { useCollectionViewToolbarWidgets } from "@/design-system/CollectionViewToolbar";
import { WorkbenchEmptyState } from "@/design-system/WorkbenchSurface";
import {
	ToolbarTemplateRows,
	type ToolbarWidgetRegistry,
} from "@/design-system/toolbar-template";
import { cn } from "@/lib";
import { AdaptiveCardCollection } from "./AdaptiveCardCollection";
import { useToolbarTemplate } from "./toolbar-template-context";
import type { CollectionDisplayPreferences } from "./collection-display";
import type { CardPresentationMode } from "@/adaptive-cards/card-presentation";

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
	display,
	onDisplayChange,
	toolbarScreenId = "inbox",
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
	renderCard: (item: InboxProjectionItem, presentation: CardPresentationMode) => ReactNode;
	onRefresh?: () => void;
	onMarkAllRead?: (items: InboxProjectionItem[]) => void;
	toolbarContent?: ReactNode;
	display: CollectionDisplayPreferences;
	onDisplayChange: (updates: Partial<CollectionDisplayPreferences>) => void;
	toolbarScreenId?: "inbox" | "mail";
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
	const facetOptions = useMemo<ProjectionFilterOption[]>(() =>
		facets.map((item) => ({
			id: item.id,
			label: item.label,
			count: items.reduce((count, candidate) => {
				const matches = item.predicate
					? item.predicate(candidate)
					: !item.kinds || item.kinds.includes(candidate.kind);
				return count + (matches ? 1 : 0);
			}, 0),
		})), [facets, items]);
	const unread = filtered.filter((item) => item.unread);
	const isMail = toolbarScreenId === "mail";
	const template = useToolbarTemplate(toolbarScreenId);
	const toolbarPrefix = isMail ? "mail" : "inbox";
	const IdentityIcon = isMail ? Mail : Inbox;
	const collectionWidgets = useCollectionViewToolbarWidgets({
		resourceName: isMail ? "mail threads" : "inbox items",
		display,
		onChange: onDisplayChange,
	});
	const toolbarWidgets: ToolbarWidgetRegistry = {
		[`${toolbarPrefix}.identity`]: (
			<div className="flex min-w-44 shrink-0 items-center gap-2">
				<span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-surface-secondary text-muted-foreground">
					<IdentityIcon className="h-3.5 w-3.5" aria-hidden="true" />
				</span>
				<div className="min-w-0">
					<h1 className="truncate text-sm font-semibold tracking-tight text-foreground">{title}</h1>
					{description ? (
						<p className="max-w-72 truncate text-[0.68rem] text-muted-foreground">{description}</p>
					) : null}
				</div>
			</div>
		),
		[`${toolbarPrefix}.search`]: (
			<ProjectionSearch
				value={search}
				onChange={setSearch}
				placeholder={isMail ? "Search mail…" : "Search this inbox…"}
				className="min-w-48 max-w-xs"
			/>
		),
		[`${toolbarPrefix}.mark-read`]: onMarkAllRead ? (
			<Button
				size="sm"
				variant="ghost"
				isDisabled={unread.length === 0}
				onPress={() => onMarkAllRead(unread)}
				className="shrink-0"
			>
				<CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
				Mark read
			</Button>
		) : null,
		[`${toolbarPrefix}.refresh`]: onRefresh ? (
			<Button isIconOnly size="sm" variant="ghost" onPress={onRefresh} aria-label={isMail ? "Refresh mail" : "Refresh inbox"}>
				<RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
			</Button>
		) : null,
		...collectionWidgets,
		...(isMail ? {
			"mail.mailbox-actions": toolbarContent,
		} : {
			"inbox.facet": (
				<ProjectionFilterMenu
					label="View"
					value={activeFacet}
					options={facetOptions}
					onChange={onFacetChange}
				/>
			),
			"inbox.context.messages": activeFacet === "messages" ? toolbarContent : null,
			"inbox.context.brain": activeFacet === "brain" ? toolbarContent : null,
		}),
	};

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
			<ToolbarTemplateRows template={template} widgets={toolbarWidgets} />
			<div className="min-h-0 flex-1">
				{filtered.length === 0 ? (
					<WorkbenchEmptyState
						title={loading ? (isMail ? "Loading mail" : "Loading inbox") : "Nothing in this view"}
						description={loading
							? (isMail ? "Coleo is collecting the latest project mail." : "Coleo is collecting the latest project state.")
							: isMail
								? "New project messages will appear here."
								: "New Brain, Arm, and project activity will stream into this projection."}
					/>
				) : display.mode === "cards" ? (
					<AdaptiveCardCollection
						items={filtered}
						columns={display.cardColumns}
						presentation={display.cardPresentation}
						getKey={(item) => item.id}
						renderCard={renderCard}
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
							renderCard={(item) => renderCard(item, display.cardPresentation)}
							onOpen={onOpen}
							density={display.density}
						/>
					</Suspense>
				)}
			</div>
		</div>
	);
}
