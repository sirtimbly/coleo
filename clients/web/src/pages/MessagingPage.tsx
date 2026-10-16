/** Scoped, API-owned Messaging projection. Detail panels use targeted reads and do not mount this collection. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { ArrowUpRight, History, MessageSquarePlus, XCircle } from "lucide-react";

import { DeferredAdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import { BRAIN_CARD_CREATOR } from "@/adaptive-cards/card-creators";
import { presentInboxItem, presentMessage } from "@/adaptive-cards/presenters";
import { ProjectionControlGroup, ProjectionFilterMenu } from "@/design-system/ProjectionControls";
import { WorkbenchStatusDot } from "@/design-system/WorkbenchSurface";
import { usePageTitle } from "@/hooks/usePageTitle";
import { api, useMessage } from "@/lib";
import { useCollectionDisplayPreferences } from "@/workbench/collection-display";
import { useLiveProjections } from "@/workbench/live-projections";
import { MessagingThreadTree } from "@/workbench/MessagingThreadTree";
import { ProjectionInbox } from "@/workbench/ProjectionInbox";
import { useMessagingCollection } from "@/workbench/use-messaging-collection";
import { useWorkspaceOpenRoute, useWorkspaceSearchParams } from "@/workspace/route-context";
import { BRAIN_ACTIVITY_CATEGORY_LABELS } from "../../../../server/src/workbench/brain-activity";
import { MESSAGING_FACETS, MESSAGING_MAILBOXES, normalizeMessagingQuery } from "../../../../server/src/workbench/messaging-query";
import { indexResourceHierarchy, toggleHierarchySelection } from "../../../../server/src/workbench/resource-hierarchy";
import { projectMessagingItems } from "../../../../server/src/workbench/messaging-collection";
import { messagingMetadata } from "../../../../server/src/workbench/messaging-metadata";
import { InboxItemPage } from "./InboxItemPage";
import { inboxItemQueryKey } from "./load-inbox-item";
import { MessagingThreadDetail } from "./MessagingThreadDetail";

import type { InboxFacet, InboxProjectionItem } from "@/workbench/ProjectionInbox";
import type { CardPresentationMode } from "@/adaptive-cards/card-presentation";
import type { MessagingItem } from "../../../../server/src/workbench/messaging-collection";
import type { CardActionRequest } from "../../../../server/src/types/adaptive-cards";
import type { ResolvedNamedResourceView } from "../../../../server/src/workbench/named-resource-views";
import type { ResourceToolbarExtra } from "@/workbench/ResourceViewToolbar";

const FACETS: InboxFacet[] = [
	{ id: "attention", label: "Needs attention" }, { id: "messages", label: "Messages" },
	{ id: "brain", label: "Brain" }, { id: "arms", label: "Arms" }, { id: "history", label: "History" }, { id: "all", label: "All" },
];
const MAILBOXES = [{ id: "inbox", label: "Inbox" }, { id: "sent", label: "Sent" }, { id: "archive", label: "Archived" }];

function projectionItem(item: MessagingItem): InboxProjectionItem {
	return { id: item.id, kind: item.kind, title: item.title, summary: item.summary, timestamp: item.timestamp,
		source: item.source, resourceId: item.resource?.id, unread: item.unread, requiresAction: item.requiresAction, severity: item.severity };
}

function targetRoute(item: MessagingItem): { pathname: string; search: string } | undefined {
	const ref = item.resource;
	if (!ref) return;
	if (ref.kind === "task") return { pathname: "/tasks", search: `?task=${encodeURIComponent(ref.id)}&view=details` };
	if (ref.kind === "bug") return { pathname: "/bugs", search: `?bug=${encodeURIComponent(ref.id)}` };
	if (ref.kind === "arm") return { pathname: "/viewer", search: `?arm=${encodeURIComponent(ref.id)}` };
}

export function MessagingPage({ projection = "inbox" }: { projection?: "inbox" | "mail" } = {}) {
	const [params] = useWorkspaceSearchParams();
	const itemId = params.get("item");
	const threadId = params.get("thread");
	if (itemId && !threadId) return <InboxItemPage key={itemId} itemId={itemId} sequence={params.get("sequence")} />;
	if (threadId) return <MessagingThreadDetail threadId={threadId}
		mailbox={params.get("mailbox") === "sent" ? "sent" : params.get("mailbox") === "archive" ? "archive" : "inbox"}
		routePath={projection === "mail" ? "/mail" : "/messaging"} />;
	const namedViewId = params.get("view");
	if (namedViewId) return <NamedMessagingCollection key={namedViewId} id={namedViewId} projection={projection} />;
	return <MessagingCollection projection={projection} />;
}

function NamedMessagingCollection({ id, projection }: { id: string; projection: "inbox" | "mail" }) {
	const view = useQuery({ queryKey: ["named-resource-view", id, "web"], queryFn: async ({ signal }) => {
		const result = await api.getNamedResourceView(id, signal);
		if (result.schemaVersion !== 1 || result.client !== "web" || result.definition?.id !== id || result.definition.resource !== "messaging") {
			throw new Error("The named-view API is incompatible. Restart the Coleo API server, then refresh this view.");
		}
		if (normalizeMessagingQuery(result.definition.query).scope !== projection) throw new Error("This named view belongs to a different Messaging scope");
		return result;
	}, staleTime: 60_000, retry: false });
	if (!view.data) return <div className="p-4" role={view.error ? "alert" : "status"}>
		{view.error ? `Named Inbox view unavailable: ${view.error.message}` : "Resolving named Inbox view…"}
		{view.error && <Button size="sm" variant="ghost" onPress={() => void view.refetch()}>Retry named view</Button>}
	</div>;
	return <MessagingCollection projection={projection} resolvedView={view.data} />;
}

function MessagingCollection({ projection, resolvedView }: { projection: "inbox" | "mail"; resolvedView?: ResolvedNamedResourceView }) {
	const defaults = useMemo(() => normalizeMessagingQuery(resolvedView?.definition.query ?? { scope: projection }), [resolvedView, projection]);
	const mailOnly = projection === "mail";
	const routePath = mailOnly ? "/mail" : "/messaging";
	usePageTitle(`Coleo Observatory - ${mailOnly ? "Mail" : "Inbox"}`);
	const [params, setParams] = useWorkspaceSearchParams();
	const openRoute = useWorkspaceOpenRoute();
	const queryClient = useQueryClient();
	const { openNewMessage } = useMessage();
	const { connected, authenticated } = useLiveProjections();
	const [search, setSearch] = useState(defaults.search);
	const [settledSearch, setSettledSearch] = useState(defaults.search);
	const [actionError, setActionError] = useState<string | null>(null);
	const [acting, setActing] = useState(false);
	const [sortDirection, setSortDirection] = useState<"asc" | "desc">(defaults.sort.direction);
	const [presentationId, setPresentationId] = useState(resolvedView?.definition.presentation.active ?? "grid");
	const [insightsActive, setInsightsActive] = useState(resolvedView?.definition.insights?.active ?? null);
	const [selection, setSelection] = useState<{ scope: string; ids: ReadonlySet<string> }>({ scope: "", ids: new Set() });
	useEffect(() => {
		if (acting) return;
		const timer = setTimeout(() => setSettledSearch(search), 200);
		return () => clearTimeout(timer);
	}, [search, acting]);
	const facetParam = params.get("facet");
	const category = params.get("brainCategory");
	const query = useMemo(() => normalizeMessagingQuery({ ...defaults, scope: projection,
		facet: mailOnly ? "messages" : MESSAGING_FACETS.includes(facetParam as typeof MESSAGING_FACETS[number]) ? facetParam : defaults.facet,
		mailbox: MESSAGING_MAILBOXES.includes(params.get("mailbox") as typeof MESSAGING_MAILBOXES[number]) ? params.get("mailbox") : defaults.mailbox,
		brainCategory: category && category in BRAIN_ACTIVITY_CATEGORY_LABELS ? category : defaults.brainCategory, search: settledSearch,
		sort: { field: "timestamp", direction: sortDirection },
	}), [defaults, projection, mailOnly, facetParam, category, params, settledSearch, sortDirection]);
	const state = useMessagingCollection(query);
	const items = useMemo(() => state.pendingQuery ? projectMessagingItems(state.value?.items ?? [], query)
		: state.value?.items ?? [], [state.pendingQuery, state.value, query]);
	const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
	const scope = JSON.stringify({ ...query, sort: null, limit: null });
	if (!state.pendingQuery && state.value?.summaries.complete && selection.scope === scope && selection.ids.size) {
		const known = new Set(items.flatMap((item) => item.thread
			? item.thread.hierarchy.nodes.filter((node) => node.selectable).map((node) => node.id) : [item.id]));
		const retained = new Set([...selection.ids].filter((id) => known.has(id)));
		if (retained.size !== selection.ids.size) setSelection({ scope, ids: retained });
	}
	const selectedIds = useMemo(() => selection.scope === scope ? selection.ids : new Set<string>(), [selection, scope]);
	const selectedUnread = items.some((item) => item.thread
		? item.thread.hierarchy.nodes.some((node) => selectedIds.has(node.id) &&
			node.data.locations.some((location) => location.mailbox === "inbox" && !location.seen))
		: selectedIds.has(item.id) && item.unread);
	const setSelectedIds = useCallback((ids: ReadonlySet<string>) => setSelection({ scope, ids }), [scope]);
	const { display: savedDisplay, updateDisplay } = useCollectionDisplayPreferences({ viewId: resolvedView ? `named:${resolvedView.definition.id}:display` : mailOnly ? "mail-display" : "inbox-display",
		name: mailOnly ? "Mail" : "Inbox", resourceKind: "message" });
	const presentation = resolvedView?.definition.presentation.renderers.find((renderer) => renderer.id === presentationId);
	const presentationFeature = resolvedView?.features.presentation.find((renderer) => renderer.id === presentationId);
	const display = resolvedView ? { ...savedDisplay, mode: presentationFeature?.implementation === "collection.cards" ? "cards" as const : "grid" as const } : savedDisplay;
	const loading = state.loading || !state.value && !state.error;
	const partial = state.value?.sources.filter((source) => source.status !== "fresh" || !source.complete) ?? [];

	const change = useCallback((field: "facet" | "mailbox" | "brainCategory", value: string) => {
		if (acting) return;
		setParams((current) => { const next = new URLSearchParams(current); next.set(field, value);
			if (field === "mailbox" && !mailOnly) next.set("facet", "messages");
			if (field === "brainCategory") next.set("facet", "brain");
			next.delete("thread"); next.delete("item"); return next;
		});
		setSelection({ scope: "", ids: new Set() }); setActionError(null);
	}, [mailOnly, setParams, acting]);

	const openItem = useCallback((projection: InboxProjectionItem) => {
		const item = byId.get(projection.id);
		if (!item) return;
		if (item.thread) {
			openRoute({ pathname: routePath,
				search: `${mailOnly ? "?" : "?facet=messages&"}mailbox=${item.thread.mailbox}&thread=${encodeURIComponent(item.thread.id)}`,
				title: item.title }, "split"); return;
		}
		const creator = item.actor ?? BRAIN_CARD_CREATOR;
		queryClient.setQueryData(inboxItemQueryKey(item.id), { item: projectionItem(item), targetRoute: targetRoute(item), creator });
		const detailParams = new URLSearchParams({ item: item.id });
		if (item.detail.kind === "event" || item.detail.kind === "activity") {
			if (item.detail.sequence) detailParams.set("sequence", String(item.detail.sequence));
		}
		void api.updateWorkbenchAttention(item.id, { readAt: new Date().toISOString(), seenAt: new Date().toISOString(), requiresAction: item.requiresAction })
			.catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Could not mark this item read"));
		openRoute({ pathname: routePath, search: `?${detailParams}`, title: item.title }, "split");
	}, [byId, openRoute, routePath, mailOnly, queryClient]);

	const mutate = useCallback(async (action: "read" | "archive", targets: readonly MessagingItem[], members?: ReadonlySet<string>) => {
		if (acting) return;
		const finishMutation = state.beginMutation();
		setActing(true); setActionError(null);
		try {
			for (const item of targets) {
				if (!item.thread) continue;
				const ids = item.thread.hierarchy.nodes.filter((node) => node.selectable && (!members || members.has(node.id))).map((node) => node.id);
				if (ids.length) await api.executeMailThreadAction(item.thread.id, item.thread.mailbox, item.thread.revision, ids, action);
			}
			const records = targets.filter((item) => !item.thread && (!members || members.has(item.id))).map((item) => item.id);
			if (records.length) await api.bulkUpdateWorkbenchAttention(records, action);
		} catch (error) { setActionError(error instanceof Error ? error.message : "The action failed; reload before retrying"); }
		finally { await finishMutation(); setActing(false); }
	}, [state, acting]);

	const renderCard = useCallback((projection: InboxProjectionItem, presentationMode: CardPresentationMode) => {
		const item = byId.get(projection.id);
		if (!item) return null;
		const thread = item.thread;
		const route = thread ? { pathname: routePath, search: `${mailOnly ? "?" : "?facet=messages&"}mailbox=${thread.mailbox}&thread=${encodeURIComponent(thread.id)}`, title: thread.subject } : targetRoute(item);
		const envelope = thread ? presentMessage({ id: item.id, from: thread.hierarchy.nodes.at(-1)?.data.from ?? "Project mail",
			subject: item.title, preview: item.summary, timestamp: item.timestamp, surface: "inbox", sent: thread.mailbox === "sent",
			canArchive: thread.hierarchy.nodes.some((node) => node.data.locations.some((location) => location.mailbox === "inbox")), targetRoute: route })
			: presentInboxItem(projection, { surface: "inbox", creator: item.actor ?? BRAIN_CARD_CREATOR, targetRoute: route, facts: [...item.facts ?? []] });
		const onAction = async (request: CardActionRequest) => {
			if (request.verb === "message.open") { openItem(projection); return; }
			if (request.verb === "message.archive") { await mutate("archive", [item]); return; }
			if (request.verb === "resource.open" && route) { openRoute(route, "focus"); return; }
			try { await api.executeWorkbenchCardAction(request); await state.refresh(); }
			catch (error) { setActionError(error instanceof Error ? error.message : "Could not perform action"); }
		};
		return <div>
			<DeferredAdaptiveCardView envelope={envelope} onAction={onAction} presentationMode={presentationMode}
				headerActions={<Button isIconOnly size="sm" variant="ghost" onPress={() => openItem(projection)} aria-label={`Open ${item.title} in panel`}><ArrowUpRight className="h-3.5 w-3.5" /></Button>} />
			{thread && <>
				<label className="flex items-center gap-2 border-t border-border p-3 text-xs text-muted-foreground">
					<input type="checkbox" aria-label={`Select thread ${thread.subject}`}
						checked={thread.hierarchy.nodes.filter((node) => node.selectable).every((node) => selectedIds.has(node.id))}
						onChange={() => setSelectedIds(toggleHierarchySelection(indexResourceHierarchy(thread.hierarchy), selectedIds, thread.hierarchy.rootIds[0]!))} />
					Select loaded conversation ({thread.messageCount} messages)
				</label>
				<MessagingThreadTree thread={thread} selectedIds={selectedIds} initialExpansion={resolvedView?.definition.hierarchy?.initialExpansion} onSelectionChange={setSelectedIds} onOpenMessage={(messageId) => {
					if (!route) return;
					openRoute({ ...route, search: `${route.search}&message=${encodeURIComponent(messageId)}` }, "split");
				}} />
			</>}
		</div>;
	}, [byId, routePath, mailOnly, openItem, mutate, openRoute, state, selectedIds, setSelectedIds, resolvedView]);

	const feedback = <>
		{(state.error || actionError) && <p role="alert" className="border-b border-danger/30 bg-danger/10 p-3 text-sm text-danger">{actionError ?? state.error?.message}</p>}
		{partial.length > 0 && <div role="status" className="border-b border-warning/30 bg-warning/10 p-3 text-xs text-warning">Incomplete Inbox: {partial.map((source) => `${source.id} ${source.status === "fresh" ? "incomplete" : source.status}`).join(", ")}. Previously loaded source sections are retained; counts are incomplete.</div>}
	</>;
	const freshness = state.value?.sources.map((source) => `${source.id}: ${source.status}`).join(" · ")
		?? (loading ? "Loading sources…" : "Source freshness unavailable");
	const sortOptions = [{ id: "desc", label: "Newest first" }, { id: "asc", label: "Oldest first" }];
	const changeSort = (direction: string) => { if (!acting) setSortDirection(direction === "asc" ? "asc" : "desc"); };
	const mailboxProps = { label: "Mailbox", value: query.mailbox, options: MAILBOXES, isDisabled: acting,
		onChange: (mailbox: string) => change("mailbox", mailbox) };
	const categoryProps = { label: "Category", value: query.brainCategory, isDisabled: acting,
		options: Object.entries(BRAIN_ACTIVITY_CATEGORY_LABELS).map(([id, label]) => ({ id, label })), onChange: (category: string) => change("brainCategory", category) };
	const historyLabel = partial.length ? "History unavailable" : state.value?.nextCursor ? "Load older" : "Beginning";
	const historyButton = <Button size="sm" variant="ghost" aria-label={historyLabel} isDisabled={loading || !state.value?.nextCursor} onPress={() => void state.loadMore()}>
		<History className="h-3.5 w-3.5" aria-hidden="true" /><span data-toolbar-label>{historyLabel}</span>
	</Button>;
	const clearSelection = <Button size="sm" variant="ghost" aria-label="Clear selection" isDisabled={acting} onPress={() => setSelectedIds(new Set())}>
		<XCircle className="h-3.5 w-3.5" aria-hidden="true" /><span data-toolbar-label>Clear selection</span>
	</Button>;
	const extraControls: ResourceToolbarExtra[] = query.facet === "messages" ? [
		{ id: "mailbox", slot: "toolbar.primary.context", label: "Mailbox", layout: { kind: "choice", priority: 85, collapse: "value", overflow: true },
			content: <ProjectionFilterMenu {...mailboxProps} />, overflowContent: <ProjectionFilterMenu {...mailboxProps} inline /> },
		{ id: "compose", slot: "toolbar.primary.actions", label: "New message", layout: { kind: "action", priority: 75, collapse: "icon", overflow: true },
			content: <Button size="sm" variant="ghost" aria-label="New message" onPress={openNewMessage}><MessageSquarePlus className="h-3.5 w-3.5" /><span data-toolbar-label>New</span></Button> },
	] : query.facet === "brain" ? [
		{ id: "brain-live", slot: "toolbar.primary.state", label: "Connection", layout: { kind: "status", priority: 90, collapse: "none", overflow: true },
			content: <WorkbenchStatusDot tone={connected && authenticated ? "success" : "neutral"} label={connected && authenticated ? "Live" : "Reconnecting"} /> },
		{ id: "brain-category", slot: "toolbar.primary.context", label: "Category", layout: { kind: "choice", priority: 85, collapse: "value", overflow: true },
			content: <ProjectionFilterMenu {...categoryProps} />, overflowContent: <ProjectionFilterMenu {...categoryProps} inline /> },
		{ id: "brain-history", slot: "toolbar.primary.actions", label: "History", layout: { kind: "action", priority: 20, collapse: "icon", overflow: true }, content: historyButton },
	] : [];
	if (selectedIds.size) extraControls.push({ id: "clear-selection", slot: "toolbar.secondary.selection", label: "Clear selection",
		layout: { kind: "action", priority: 80, collapse: "icon", overflow: true }, content: clearSelection });
	return <ProjectionInbox title={resolvedView?.definition.slots["toolbar.primary.identity"]?.[0]?.label ?? (mailOnly ? "Mail" : "Inbox")} description={mailOnly ? "Project messages across Inbox, Sent, and Archived mailboxes" : "Messages, Brain decisions, Arm events, and operational history"}
		toolbarExtras={extraControls} selectionSummary={selectedIds.size ? <span className="whitespace-nowrap text-xs">{selectedIds.size} loaded members selected</span> : null}
		identitySubtitle={<span aria-label="Messaging source freshness" title={freshness}>{freshness}</span>}
		resolvedView={resolvedView} namedPresentationId={presentationId} onNamedPresentationChange={setPresentationId}
		listFields={presentationFeature?.implementation === "collection.list" ? presentation?.fields : undefined}
		gridFields={resolvedView ? presentation?.fields : undefined}
		insightsActive={insightsActive} onInsightsChange={setInsightsActive}
		metadataContent={insightsActive && state.value ? <section aria-label="Inbox metadata" className="border-b border-border p-3 text-xs">
			{state.value.summaries.complete ? "Complete" : "Incomplete"} current query: {state.value.summaries.total ?? "unknown total"} items.
			{messagingMetadata(state.value, resolvedView?.definition.insights?.panels.find((panel) => panel.id === insightsActive)?.fields ?? [])
				.map((value) => <span key={value.field} className="ml-3">{value.label}: {value.value ?? "unknown"} ({value.scope})</span>)}
			{resolvedView?.features.insights.find((feature) => feature.id === insightsActive)?.diagnostic}
		</section> : null}
		items={items.map(projectionItem)} facets={mailOnly ? FACETS.filter((facet) => facet.id === "messages") : FACETS}
		activeFacet={query.facet} onFacetChange={(facet) => change("facet", facet)} display={display} onDisplayChange={updateDisplay}
		toolbarScreenId={mailOnly ? "mail" : "inbox"} onOpen={openItem} renderCard={renderCard} onRefresh={() => void state.refresh()}
		serverProjected searchText={search} onSearchChange={setSearch} resultCount={!state.pendingQuery && state.value?.summaries.complete ? state.value.summaries.total : null}
		queryControlsDisabled={acting}
		serverSort={sortDirection} secondaryContent={<ProjectionFilterMenu label="Sort" value={sortDirection} isDisabled={acting} options={sortOptions} onChange={changeSort} />}
		overflowSecondaryContent={<ProjectionFilterMenu inline label="Sort" value={sortDirection} isDisabled={acting} options={sortOptions} onChange={changeSort} />}
		feedback={feedback} loading={loading}
		loadError={state.error?.message ?? (partial.length ? "A requested source is unavailable. Refresh to retry; this is not an authoritative empty result." : null)}
		readActionLabel={acting ? "Marking read…" : resolvedView || selectedIds.size ? "Mark selected read" : "Mark read"}
		readActionDisabled={acting || !!resolvedView && !selectedIds.size || partial.some((source) => source.id === "mail")}
		readActionHasTargets={selectedIds.size ? selectedUnread : undefined}
		paginationContent={query.facet !== "brain" && state.value?.nextCursor
			? <Button size="sm" variant="ghost" aria-label="Load older" isDisabled={loading} onPress={() => void state.loadMore()}>
				<History className="h-3.5 w-3.5" aria-hidden="true" /><span data-toolbar-label>Load older</span>
			</Button> : undefined}
		selectionContent={selectedIds.size ? <div className="ml-auto flex shrink-0 items-center gap-3 text-xs" role="status">
			<span>{selectedIds.size} loaded members selected</span>
			{clearSelection}
		</div> : null}
		toolbarContent={query.facet === "messages" ? <ProjectionControlGroup>
			<ProjectionFilterMenu label="Mailbox" value={query.mailbox} options={MAILBOXES} isDisabled={acting} onChange={(mailbox) => change("mailbox", mailbox)} />
			<Button size="sm" variant="ghost" aria-label="New message" onPress={openNewMessage}><MessageSquarePlus className="h-3.5 w-3.5" /><span data-toolbar-label>New</span></Button>
		</ProjectionControlGroup> : query.facet === "brain" ? <ProjectionControlGroup>
			<WorkbenchStatusDot tone={connected && authenticated ? "success" : "neutral"} label={connected && authenticated ? "Live" : "Reconnecting"} />
			<ProjectionFilterMenu label="Category" value={query.brainCategory} isDisabled={acting} options={Object.entries(BRAIN_ACTIVITY_CATEGORY_LABELS).map(([id, label]) => ({ id, label }))}
				onChange={(category) => change("brainCategory", category)} />
			<Button size="sm" variant="ghost" aria-label={partial.length ? "History unavailable" : state.value?.nextCursor ? "Load older" : "Beginning"}
				isDisabled={loading || !state.value?.nextCursor} onPress={() => void state.loadMore()}>
				<History className="h-3.5 w-3.5" aria-hidden="true" /><span data-toolbar-label>{partial.length ? "History unavailable" : state.value?.nextCursor ? "Load older" : "Beginning"}</span>
			</Button>
		</ProjectionControlGroup> : null}
		onMarkAllRead={(visible) => {
			if (selectedIds.size) { void mutate("read", items, selectedIds); return; }
			if (resolvedView) return;
			const ids = new Set(visible.map((item) => item.id)); void mutate("read", items.filter((item) => ids.has(item.id)));
		}} />;
}
