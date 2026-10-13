/**
 * Reusable inbox projection presentation.
 *
 * Brain, Arm, project-message, and attention inboxes share card and virtualized
 * data-grid modes, search, bulk-action, and empty-state language.
 */

import {
	lazy,
	Suspense,
	useCallback,
	useDeferredValue,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import { Button } from "@heroui/react";
import { ChartNoAxesCombined, CheckCheck, Inbox, Keyboard, Mail, RefreshCw } from "lucide-react";

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
import { ResourceViewToolbar } from "./ResourceViewToolbar";
import type { ResourceToolbarExtra } from "./ResourceViewToolbar";
import { ResourceInteractionHelp } from "./ResourceInteractionHelp";
import { formatKeyboardBinding, matchInteractionKey } from "../../../src/workbench/interaction-definition";
import type { ResolvedNamedResourceView } from "../../../src/workbench/named-resource-views";
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
	identitySubtitle,
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
	searchText,
	onSearchChange,
	serverProjected = false,
	resultCount,
	feedback,
	selectionContent,
	paginationContent,
	secondaryContent,
	serverSort,
	loadError,
	readActionLabel = "Mark read",
	readActionDisabled = false,
	readActionHasTargets,
	queryControlsDisabled = false,
	resolvedView,
	namedPresentationId,
	onNamedPresentationChange,
	listFields,
	gridFields,
	insightsActive,
	onInsightsChange,
	metadataContent,
	toolbarExtras,
	overflowSecondaryContent,
	selectionSummary,
}: {
	title: string;
	description?: string;
	identitySubtitle?: ReactNode;
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
	searchText?: string;
	onSearchChange?: (value: string) => void;
	serverProjected?: boolean;
	resultCount?: number | null;
	feedback?: ReactNode;
	selectionContent?: ReactNode;
	paginationContent?: ReactNode;
	secondaryContent?: ReactNode;
	serverSort?: "asc" | "desc";
	loadError?: string | null;
	readActionLabel?: string;
	readActionDisabled?: boolean;
	readActionHasTargets?: boolean;
	queryControlsDisabled?: boolean;
	resolvedView?: ResolvedNamedResourceView;
	namedPresentationId?: string;
	onNamedPresentationChange?: (id: string) => void;
	listFields?: readonly string[];
	gridFields?: readonly string[];
	insightsActive?: string | null;
	onInsightsChange?: (id: string | null) => void;
	metadataContent?: ReactNode;
	toolbarExtras?: readonly ResourceToolbarExtra[];
	overflowSecondaryContent?: ReactNode;
	selectionSummary?: ReactNode;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const helpRef = useRef<HTMLDivElement>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const [helpOpen, setHelpOpen] = useState(false);
	const attachHelp = useCallback((element: HTMLDivElement | null) => {
		helpRef.current = element;
		element?.focus();
	}, []);
	const [search, setSearch] = useState("");
	const effectiveSearch = searchText ?? search;
	const deferredSearch = useDeferredValue(effectiveSearch);
	const facet = facets.find((item) => item.id === activeFacet) ?? facets[0];
	const filtered = useMemo(() => {
		if (serverProjected) return items;
		const query = deferredSearch.trim().toLowerCase();
		return items.filter((item) => {
			const facetMatches = facet?.predicate
				? facet.predicate(item)
				: !facet?.kinds || facet.kinds.includes(item.kind);
			if (!facetMatches) return false;
			if (!query) return true;
			return `${item.title} ${item.summary} ${item.source ?? ""}`.toLowerCase().includes(query);
		});
	}, [deferredSearch, facet, items, serverProjected]);
	const facetOptions = useMemo<ProjectionFilterOption[]>(() =>
		facets.map((item) => ({
			id: item.id,
			label: item.label,
			count: serverProjected ? item.id === activeFacet ? resultCount ?? undefined : undefined : items.reduce((count, candidate) => {
				const matches = item.predicate
					? item.predicate(candidate)
					: !item.kinds || item.kinds.includes(candidate.kind);
				return count + (matches ? 1 : 0);
			}, 0),
		})), [facets, items, serverProjected, activeFacet, resultCount]);
	const unread = filtered.filter((item) => item.unread);
	const shortcut = (operation: string) => resolvedView?.interactions.bindings.find((binding) => binding.operation === operation && binding.available)
		?.keyboard.map(formatKeyboardBinding).join(", ");
	const closeHelp = () => { setHelpOpen(false); previousFocus.current?.focus(); };
	const showHelp = () => {
		previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setHelpOpen(true);
	};
	const toggleHelp = () => { if (helpOpen) closeHelp(); else showHelp(); };
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!resolvedView || event.defaultPrevented || event.nativeEvent.isComposing || event.repeat) return;
		const target = event.target;
		if (!(target instanceof HTMLElement) || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')) return;
		const binding = matchInteractionKey(resolvedView.interactions.bindings, event.nativeEvent,
			helpOpen && helpRef.current?.contains(target) ? "help" : "collection", /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other");
		if (!binding) return;
		if (binding.operation === "collection.search" && !queryControlsDisabled) {
			containerRef.current?.querySelector<HTMLInputElement>('input[name="projection-search"]')?.focus();
		} else if (binding.operation === "collection.refresh" && !queryControlsDisabled && !loading && onRefresh) onRefresh();
		else if (binding.operation === "collection.help") toggleHelp();
		else if (binding.operation === "collection.back" && helpOpen) closeHelp();
		else return;
		event.preventDefault();
		event.stopPropagation();
	};
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
			<div className={cn("flex shrink-0 items-center gap-2", resolvedView ? "w-56 max-w-full min-w-0" : "min-w-44")}>
				<span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-surface-secondary text-muted-foreground">
					<IdentityIcon className="h-3.5 w-3.5" aria-hidden="true" />
				</span>
				<div className="min-w-0">
					<h1 className="truncate text-sm font-semibold tracking-tight text-foreground">{title}</h1>
					{identitySubtitle ?? description ? (
						<p className="max-w-72 truncate text-[0.68rem] text-muted-foreground">{identitySubtitle ?? description}</p>
					) : null}
				</div>
			</div>
		),
		[`${toolbarPrefix}.search`]: (
			<ProjectionSearch
				value={effectiveSearch}
				isDisabled={queryControlsDisabled}
				onChange={onSearchChange ?? setSearch}
				placeholder={isMail ? "Search mail…" : "Search this inbox…"}
				className="min-w-48 max-w-xs"
				shortcut={shortcut("collection.search")}
			/>
		),
		[`${toolbarPrefix}.mark-read`]: onMarkAllRead ? (
			<Button
				size="sm"
				variant="ghost"
				isDisabled={readActionDisabled || !(readActionHasTargets ?? unread.length > 0)}
				aria-label={readActionLabel}
				onPress={() => onMarkAllRead(unread)}
				className="shrink-0"
			>
				<CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
				<span data-toolbar-label>{readActionLabel}</span>
			</Button>
		) : null,
		[`${toolbarPrefix}.refresh`]: onRefresh ? (
			<span title={shortcut("collection.refresh") ? `Refresh (${shortcut("collection.refresh")})` : undefined}>
			<Button isIconOnly={!resolvedView} size="sm" variant="ghost" onPress={onRefresh} aria-label={isMail ? "Refresh mail" : "Refresh inbox"}
				isDisabled={!!resolvedView && (queryControlsDisabled || loading)}
				aria-keyshortcuts={shortcut("collection.refresh")}>
				<RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
				{resolvedView && <span data-toolbar-label>Refresh</span>}
			</Button>
			</span>
		) : null,
		...collectionWidgets,
		...(isMail ? {
			"mail.mailbox-actions": toolbarContent,
		} : {
			"inbox.facet": (
				<ProjectionFilterMenu
					label="View"
					isDisabled={queryControlsDisabled}
					value={activeFacet}
					options={facetOptions}
					onChange={onFacetChange}
				/>
			),
			"inbox.context.messages": activeFacet === "messages" ? toolbarContent : null,
			"inbox.context.brain": activeFacet === "brain" ? toolbarContent : null,
		}),
	};
	const namedWidgets: ToolbarWidgetRegistry = {
		"resource.identity": toolbarWidgets[`${toolbarPrefix}.identity`],
		"inbox.facet": toolbarWidgets["inbox.facet"],
		"collection.search": toolbarWidgets[`${toolbarPrefix}.search`],
		"inbox.mark-read": toolbarWidgets[`${toolbarPrefix}.mark-read`],
		"collection.refresh": toolbarWidgets[`${toolbarPrefix}.refresh`],
		"collection.freshness": <span role="status" className="text-xs text-muted-foreground">{identitySubtitle ?? description}</span>,
		"collection.count": <span role="status" className="shrink-0 text-xs text-muted-foreground">{resultCount ?? "Incomplete"} results</span>,
		"collection.sort": secondaryContent,
		"collection.presentation": resolvedView ? <ProjectionFilterMenu label="Presentation" value={namedPresentationId ?? resolvedView.definition.presentation.active}
			isDisabled={queryControlsDisabled} onChange={(id) => onNamedPresentationChange?.(id)}
			options={resolvedView.definition.presentation.renderers.filter((renderer) => resolvedView.features.presentation.some((feature) => feature.id === renderer.id && feature.implementation))
				.map((renderer) => ({ id: renderer.id, label: renderer.label }))} /> : null,
		"collection.selection": (selectionSummary !== undefined ? selectionSummary : selectionContent) ?? null,
		"collection.insights": resolvedView?.definition.insights?.panels.length ? <Button size="sm" variant={insightsActive ? "secondary" : "ghost"} aria-pressed={!!insightsActive}
			aria-expanded={!!insightsActive} className={cn(insightsActive && "bg-accent/15 text-accent")}
			aria-label="Metadata overview"
			isDisabled={!resolvedView.features.insights.some((feature) => feature.implementation)}
			onPress={() => onInsightsChange?.(insightsActive ? null : resolvedView.definition.insights!.panels[0]!.id)}>
			<ChartNoAxesCombined className="h-3.5 w-3.5" aria-hidden="true" /><span data-toolbar-label>Metadata overview</span>
		</Button> : null,
	};
	const overflowWidgets: ToolbarWidgetRegistry = {
		"inbox.facet": <ProjectionFilterMenu inline label="View" value={activeFacet} options={facetOptions} isDisabled={queryControlsDisabled} onChange={onFacetChange} />,
		"collection.sort": overflowSecondaryContent ?? secondaryContent,
		"collection.presentation": resolvedView ? <ProjectionFilterMenu inline label="Presentation" value={namedPresentationId ?? resolvedView.definition.presentation.active}
			isDisabled={queryControlsDisabled} onChange={(id) => onNamedPresentationChange?.(id)}
			options={resolvedView.definition.presentation.renderers.filter((renderer) => resolvedView.features.presentation.some((feature) => feature.id === renderer.id && feature.implementation))
				.map((renderer) => ({ id: renderer.id, label: renderer.label }))} /> : null,
	};
	const activePresentation = resolvedView?.features.presentation.find((feature) => feature.id === namedPresentationId);

	return (
		<div ref={containerRef} tabIndex={resolvedView ? 0 : undefined} aria-label={resolvedView ? `Named Inbox view ${resolvedView.definition.id}` : undefined}
			onKeyDown={handleKeyDown} className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
			{resolvedView ? <ResourceViewToolbar view={resolvedView} widgets={namedWidgets} overflowWidgets={overflowWidgets} extras={[
				...toolbarExtras ?? [{ id: "scope-controls", slot: "toolbar.primary.context" as const, label: "Context",
					content: toolbarContent, layout: { priority: 85, collapse: "none" as const, overflow: true } }],
				{ id: "pagination", slot: "toolbar.primary.actions", label: "Load older", content: paginationContent,
					layout: { priority: 20, collapse: "icon", overflow: true } },
				{ id: "keyboard-help", slot: "toolbar.primary.actions", label: "Keyboard help",
					layout: { kind: "action", priority: 5, collapse: "icon", overflow: true },
					content: <Button size="sm" variant={helpOpen ? "secondary" : "ghost"} onPress={toggleHelp}
						aria-pressed={helpOpen} aria-expanded={helpOpen} className={cn(helpOpen && "bg-accent/15 text-accent")}
						aria-label="Keyboard help" aria-keyshortcuts={shortcut("collection.help")}>
						<Keyboard className="h-3.5 w-3.5" aria-hidden="true" /><span data-toolbar-label>Keyboard help</span>
					</Button> },
			]} /> : <ToolbarTemplateRows template={template} widgets={toolbarWidgets}
				rowExtras={{ [template.rows[1].id]: <>{secondaryContent}{selectionContent}</>, [template.rows[0].id]: paginationContent }} />}
			{helpOpen && resolvedView && <div ref={attachHelp} tabIndex={-1} role="region" aria-label="Interaction help">
				<Button size="sm" variant="ghost" onPress={closeHelp}>Close keyboard help</Button>
				<ResourceInteractionHelp interactions={resolvedView.interactions} />
			</div>}
			{activePresentation?.diagnostic && <p role="status" className="border-b border-border p-2 text-xs text-muted-foreground">{activePresentation.diagnostic}</p>}
			{metadataContent}
			{feedback}
			<div className="min-h-0 flex-1">
				{filtered.length === 0 ? (
					<WorkbenchEmptyState
						title={loadError ? (isMail ? "Mail unavailable" : "Inbox unavailable") : loading ? (isMail ? "Loading mail" : "Loading inbox") : "Nothing in this view"}
						description={loadError ?? (loading
							? (isMail ? "Coleo is collecting the latest project mail." : "Coleo is collecting the latest project state.")
							: isMail
								? "New project messages will appear here."
								: "New Brain, Arm, and project activity will stream into this projection.")}
					/>
				) : listFields ? <ul aria-label="Inbox text list" className="h-full overflow-auto p-3">
					{filtered.map((item) => <li key={item.id} className="border-b border-border py-2">
						<button type="button" onClick={() => onOpen(item)} className="text-left text-xs">
							{listFields.map((field) => <span key={field} className="mr-3">{field}: {String(item[field as keyof InboxProjectionItem] ?? "—")}</span>)}
						</button>
					</li>)}
				</ul> : display.mode === "cards" ? (
					<AdaptiveCardCollection
						projectedItems={filtered}
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
								serverSort={serverSort}
								fields={gridFields}
						/>
					</Suspense>
				)}
			</div>
		</div>
	);
}
