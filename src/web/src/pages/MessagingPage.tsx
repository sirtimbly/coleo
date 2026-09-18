/**
 * Unified workbench Inbox for project mail and operational attention.
 *
 * Mail threads retain view, read, reply, archive, and nested-reply behavior.
 * Brain, Arm, proposal, report, and system history share the same projection
 * so legacy Activity, History, Proposals, and Project Mail routes can redirect.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { ArrowUpRight, LoaderCircle, MessageSquarePlus } from "lucide-react";

import {
	DeferredAdaptiveCardView,
} from "@/adaptive-cards/AdaptiveCardView";
import { presentInboxItem, presentMessage } from "@/adaptive-cards/presenters";
import {
	WorkbenchStatusDot,
} from "@/design-system/WorkbenchSurface";
import {
	ProjectionControlGroup,
	ProjectionFilterMenu,
	type ProjectionFilterOption,
} from "@/design-system/ProjectionControls";
import { usePageTitle } from "@/hooks/usePageTitle";
import { api, type ActivityEntry, type MailMessage, type StatusReport, useMessage } from "@/lib";
import {
	buildMailThreads,
	getInboxMessageIdsForThread,
	type MailboxTab,
	type MailThread,
} from "@/pages/mail-page-utils";
import {
	BRAIN_ACTIVITY_CATEGORY_LABELS,
	mergeBrainActivity,
	type BrainActivityCategory,
} from "@/pages/brain-activity";
import { MailThreadProjection } from "@/workbench/MailThreadProjection";
import { useCollectionDisplayPreferences } from "@/workbench/collection-display";
import {
	ProjectionInbox,
	type InboxFacet,
	type InboxProjectionItem,
} from "@/workbench/ProjectionInbox";
import { useLiveProjections, useProjectionSignal } from "@/workbench/live-projections";
import {
	isNotableEvent,
	projectRecentEvent,
	type RecentEvent,
} from "@/workbench/recent-event-inbox";
import {
	useWorkspaceCloseRoute,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from "@/workspace/route-context";

import { inboxItemQueryKey } from "./load-inbox-item";
import { InboxItemPage } from "./InboxItemPage";
import { activityToItem, brainActivityToItem, creatorForInboxItem, reportToItem, threadToItem, workbenchInboxToItem } from "./inbox-item-projection";

import type { InboxItemData } from "./inbox-item-projection";

import type {
	CardActionRequest,
	WorkbenchAttention,
	WorkbenchInboxRecord,
} from "../../../types/adaptive-cards";

const FACETS: InboxFacet[] = [
	{
		id: "attention",
		label: "Needs attention",
		predicate: (item) => item.requiresAction,
	},
	{ id: "messages", label: "Messages", kinds: ["project"] },
	{ id: "brain", label: "Brain", kinds: ["brain"] },
	{ id: "arms", label: "Arms", kinds: ["arm", "status"] },
	{
		id: "history",
		label: "History",
		predicate: (item) => item.kind !== "project",
	},
	{ id: "all", label: "All" },
];

const MAILBOXES: ReadonlyArray<{ id: MailboxTab; label: string }> = [
	{ id: "inbox", label: "Inbox" },
	{ id: "sent", label: "Sent" },
	{ id: "archive", label: "Archived" },
];

const MAIL_FACETS: InboxFacet[] = [
	{ id: "messages", label: "Messages", kinds: ["project"] },
];

const BRAIN_CATEGORY_OPTIONS: readonly ProjectionFilterOption[] = Object.entries(
	BRAIN_ACTIVITY_CATEGORY_LABELS,
).map(([id, label]) => ({ id, label }));

function isBrainCategory(value: string | null): value is BrainActivityCategory | "all" {
	return value !== null && value in BRAIN_ACTIVITY_CATEGORY_LABELS;
}

export function MessagingPage({ projection = "inbox" }: { projection?: "inbox" | "mail" } = {}) {
	const [searchParams] = useWorkspaceSearchParams();
	const itemId = searchParams.get("item");
	if (itemId && !searchParams.get("thread")) {
		return <InboxItemPage key={itemId} itemId={itemId} sequence={searchParams.get("sequence")} />;
	}
	return <MessagingCollectionPage projection={projection} />;
}

function MessagingCollectionPage({ projection }: { projection: "inbox" | "mail" }) {
	const queryClient = useQueryClient();
	const mailOnly = projection === "mail";
	const routePath = mailOnly ? "/mail" : "/messaging";
	usePageTitle(`Coleo Observatory - ${mailOnly ? "Mail" : "Inbox"}`);
	const [searchParams, setSearchParams] = useWorkspaceSearchParams();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const closeWorkspaceRoute = useWorkspaceCloseRoute(routePath);
	const { openNewMessage, openReply } = useMessage();
	const { connected, authenticated } = useLiveProjections();
	const initialFacet = searchParams.get("facet");
	const initialMailbox = searchParams.get("mailbox");
	const initialBrainCategory = searchParams.get("brainCategory");
	const [activeFacet, setActiveFacet] = useState(
		mailOnly
			? "messages"
			: FACETS.some((facet) => facet.id === initialFacet) ? initialFacet! : "attention",
	);
	const [mailbox, setMailbox] = useState<MailboxTab>(
		initialMailbox === "sent" || initialMailbox === "archive" ? initialMailbox : "inbox",
	);
	const [brainCategory, setBrainCategory] = useState<BrainActivityCategory | "all">(
		isBrainCategory(initialBrainCategory) ? initialBrainCategory : "all",
	);
	const [inbox, setInbox] = useState<MailMessage[]>([]);
	const [sent, setSent] = useState<MailMessage[]>([]);
	const [archive, setArchive] = useState<MailMessage[]>([]);
	const [activity, setActivity] = useState<ActivityEntry[]>([]);
	const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
	const [brainActivity, setBrainActivity] = useState<ActivityEntry[]>([]);
	const [brainActivityCursor, setBrainActivityCursor] = useState<number | null>(null);
	const [hasOlderBrainActivity, setHasOlderBrainActivity] = useState(false);
	const [olderBrainActivityLoading, setOlderBrainActivityLoading] = useState(false);
	const [reports, setReports] = useState<StatusReport[]>([]);
	const [attention, setAttention] = useState<WorkbenchAttention[]>([]);
	const [workbenchInbox, setWorkbenchInbox] = useState<WorkbenchInboxRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [archiving, setArchiving] = useState(false);
	const { display, updateDisplay } = useCollectionDisplayPreferences({
		viewId: mailOnly ? "mail-display" : "inbox-display",
		name: mailOnly ? "Mail" : "Inbox",
		resourceKind: "message",
	});
	const loadTimerRef = useRef<number | null>(null);
	const brainActivityInitializedRef = useRef(false);
	const selectedThreadId = searchParams.get("thread");
	const detailMailboxParam = searchParams.get("mailbox");
	const detailMailbox: MailboxTab =
		detailMailboxParam === "sent" || detailMailboxParam === "archive"
			? detailMailboxParam
			: "inbox";

	const load = useCallback(async () => {
		setLoading(true);
		try {
			if (mailOnly) {
				const [inboxResponse, sentResponse, archiveResponse] = await Promise.all([
					api.listInbox({ limit: 100 }),
					api.listSent({ limit: 100 }),
					api.listArchive({ limit: 100 }),
				]);
				setInbox(inboxResponse.messages);
				setSent(sentResponse.messages);
				setArchive(archiveResponse.messages);
				return;
			}
			const [
				activityResponse,
				brainActivityResponse,
				inboxResponse,
				sentResponse,
				archiveResponse,
				reportsResponse,
				recentEventsResponse,
				attentionResponse,
				workbenchInboxResponse,
			] =
				await Promise.all([
					api.listActivity({ limit: 100 }),
					api.listActivity({ producer: "brain", limit: 200 }),
					api.listInbox({ limit: 100 }),
					api.listSent({ limit: 100 }),
					api.listArchive({ limit: 100 }),
					api.listStatusReports({ limit: 100 }),
					api.getRecentEvents({ limit: 100, sinceMs: 1000 * 60 * 60 * 24 })
						.catch(() => ({ events: [], total: 0 })),
					api.listWorkbenchAttention({ includeArchived: true, limit: 1000 }),
					api.listWorkbenchInbox({ limit: 200 }),
				]);
			setActivity(activityResponse.activity);
			setBrainActivity((current) => mergeBrainActivity(current, brainActivityResponse.activity));
			if (!brainActivityInitializedRef.current) {
				setBrainActivityCursor(brainActivityResponse.pagination.nextCursor ?? null);
				setHasOlderBrainActivity(brainActivityResponse.pagination.hasMore ?? false);
				brainActivityInitializedRef.current = true;
			}
			setInbox(inboxResponse.messages);
			setSent(sentResponse.messages);
			setArchive(archiveResponse.messages);
			setReports(reportsResponse.reports);
			setRecentEvents(recentEventsResponse.events);
			setAttention(attentionResponse.attention);
			setWorkbenchInbox(workbenchInboxResponse.items);
		} finally {
			setLoading(false);
		}
	}, [mailOnly]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => () => {
		if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current);
	}, []);

	useEffect(() => {
		const facet = searchParams.get("facet");
		setActiveFacet(mailOnly
			? "messages"
			: facet && FACETS.some((candidate) => candidate.id === facet) ? facet : "attention");
		const nextMailbox = searchParams.get("mailbox");
		setMailbox(
			nextMailbox === "sent" || nextMailbox === "archive" ? nextMailbox : "inbox",
		);
		const nextBrainCategory = searchParams.get("brainCategory");
		setBrainCategory(isBrainCategory(nextBrainCategory) ? nextBrainCategory : "all");
	}, [mailOnly, searchParams]);

	const handleFacetChange = useCallback((facet: string) => {
		setActiveFacet(facet);
		setSearchParams((current) => {
			const next = new URLSearchParams(current);
			next.set("facet", facet);
			if (facet === "messages") next.set("mailbox", mailbox);
			if (facet === "brain") next.set("brainCategory", brainCategory);
			next.delete("thread");
			next.delete("item");
			return next;
		});
	}, [brainCategory, mailbox, setActiveFacet, setSearchParams]);

	const handleMailboxChange = useCallback((nextMailbox: string) => {
		if (nextMailbox !== "inbox" && nextMailbox !== "sent" && nextMailbox !== "archive") return;
		setMailbox(nextMailbox);
		setSearchParams((current) => {
			const next = new URLSearchParams(current);
			if (mailOnly) next.delete("facet");
			else next.set("facet", "messages");
			next.set("mailbox", nextMailbox);
			next.delete("thread");
			next.delete("item");
			return next;
		});
	}, [mailOnly, setMailbox, setSearchParams]);

	const handleBrainCategoryChange = useCallback((category: string) => {
		if (!isBrainCategory(category)) return;
		setBrainCategory(category);
		setSearchParams((current) => {
			const next = new URLSearchParams(current);
			next.set("facet", "brain");
			next.set("brainCategory", category);
			next.delete("thread");
			next.delete("item");
			return next;
		});
	}, [setBrainCategory, setSearchParams]);

	const loadOlderBrainActivity = useCallback(async () => {
		if (!brainActivityCursor || olderBrainActivityLoading || !hasOlderBrainActivity) return;
		setOlderBrainActivityLoading(true);
		try {
			const response = await api.listActivity({
				producer: "brain",
				limit: 200,
				beforeSequence: brainActivityCursor,
			});
			setBrainActivity((current) => mergeBrainActivity(current, response.activity));
			setBrainActivityCursor(response.pagination.nextCursor ?? null);
			setHasOlderBrainActivity(response.pagination.hasMore ?? false);
		} finally {
			setOlderBrainActivityLoading(false);
		}
	}, [brainActivityCursor, hasOlderBrainActivity, olderBrainActivityLoading]);

	useProjectionSignal((signal) => {
		const relevant = mailOnly
			? signal.channel === "mail"
			: ["mail", "brain", "arms", "arm-events", "activity", "workbench"].includes(signal.channel);
		if (!relevant) return;
		if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current);
		loadTimerRef.current = window.setTimeout(() => {
			loadTimerRef.current = null;
			void load();
		}, 200);
	});

	const effectiveMailbox = mailOnly || activeFacet === "messages" ? mailbox : "inbox";
	const threads = useMemo(
		() => buildMailThreads({
			inboxMessages: inbox,
			sentMessages: sent,
			archiveMessages: archive,
			activeTab: effectiveMailbox,
			collapsedThreads: new Set(),
		}),
		[archive, effectiveMailbox, inbox, sent],
	);
	const detailThreads = useMemo(
		() => buildMailThreads({
			inboxMessages: inbox,
			sentMessages: sent,
			archiveMessages: archive,
			activeTab: detailMailbox,
			collapsedThreads: new Set(),
		}),
		[archive, detailMailbox, inbox, sent],
	);
	const selectedThread = detailThreads.find((thread) => thread.id === selectedThreadId) ?? null;

	const items = useMemo<InboxItemData[]>(() => {
		const brainActivityIds = new Set(brainActivity.map((entry) => entry.id));
		const mailItems = threads.map((thread) => threadToItem(thread, effectiveMailbox));
		const merged = mailOnly
			? mailItems
			: [
					...workbenchInbox.map(workbenchInboxToItem),
					...mailItems,
					...reports.map(reportToItem),
					...activity
						.filter((entry) => !brainActivityIds.has(entry.id))
						.map(activityToItem),
					...brainActivity.map(brainActivityToItem),
					...recentEvents
						.filter(isNotableEvent)
						.map((event, index) => projectRecentEvent(event, index)),
				];
		const durableTaskIds = new Set(workbenchInbox
			.filter((record) => record.resource.kind === "task")
			.map((record) => record.resource.id));
		const focused = merged.filter((entry) => {
			if (!entry.item.resourceId || !durableTaskIds.has(entry.item.resourceId)) return true;
			return entry.item.id === `task:${entry.item.resourceId}` || entry.item.id.startsWith("status:");
		});
		return [...new Map(focused.map((entry) => [entry.item.id, entry])).values()].sort(
			(left, right) =>
				new Date(right.item.timestamp).getTime() - new Date(left.item.timestamp).getTime(),
		);
	}, [activity, brainActivity, effectiveMailbox, mailOnly, recentEvents, reports, threads, workbenchInbox]);

	const attentionByItem = useMemo(
		() => new Map(attention.map((entry) => [entry.itemKey, entry])),
		[attention],
	);
	const statefulItems = useMemo(
		() => items.map((entry) => {
			const state = attentionByItem.get(entry.item.id);
			if (!state) return entry;
			return {
				...entry,
				item: {
					...entry.item,
					unread: state.readAt ? false : entry.item.unread,
					requiresAction: state.resolvedAt
						? false
						: state.requiresAction || entry.item.requiresAction,
				},
			};
		}),
		[attentionByItem, items],
	);
	const statefulItemsById = useMemo(
		() => new Map(statefulItems.map((entry) => [entry.item.id, entry])),
		[statefulItems],
	);
	const planningGateBlocked = workbenchInbox.some((record) =>
		record.itemKey === "brain:planning-gate" && record.requiresAction
	);
	const facets = useMemo(() => {
		if (mailOnly) return MAIL_FACETS;
		return planningGateBlocked
			? FACETS.map((facet) => facet.id === "attention"
				? { ...facet, predicate: (item: InboxProjectionItem) => item.id === "brain:planning-gate" }
				: facet)
			: FACETS;
	}, [mailOnly, planningGateBlocked]);
	const projectionItems = useMemo(
		() => statefulItems.filter((entry) => {
			return activeFacet !== "brain" ||
				brainCategory === "all" ||
				entry.item.kind !== "brain" ||
				entry.brainCategory === brainCategory;
		}),
		[activeFacet, brainCategory, statefulItems],
	);

	const markThreadRead = useCallback(async (thread: MailThread) => {
		const messageIds = getInboxMessageIdsForThread(thread, inbox).filter((id) => {
			const message = inbox.find((candidate) => candidate.id === id);
			return message && !message.flags.seen;
		});
		if (messageIds.length === 0) return;
		setInbox((current) => current.map((message) =>
			messageIds.includes(message.id)
				? { ...message, flags: { ...message.flags, seen: true } }
				: message
		));
		await Promise.all(messageIds.map((id) => api.markMailRead(id)));
	}, [inbox]);

	const openItem = useCallback((item: InboxProjectionItem) => {
		const source = statefulItemsById.get(item.id);
		if (source?.thread && source.mailbox) {
			void markThreadRead(source.thread);
			openWorkspaceRoute(
				{
					pathname: routePath,
					search: mailOnly
						? `?mailbox=${source.mailbox}&thread=${encodeURIComponent(source.thread.id)}`
						: `?facet=messages&mailbox=${source.mailbox}&thread=${encodeURIComponent(source.thread.id)}`,
					title: source.thread.subject,
				},
				"split",
			);
			return;
		}
		if (source) queryClient.setQueryData(inboxItemQueryKey(item.id), source);
		void api.updateWorkbenchAttention(item.id, {
			seenAt: new Date().toISOString(),
			readAt: new Date().toISOString(),
			requiresAction: item.requiresAction,
		});
		const params = new URLSearchParams({ item: item.id });
		const sequence = source?.activity?.sequence ?? source?.recentEvent?.sequence;
		if (sequence) params.set("sequence", String(sequence));
		openWorkspaceRoute(
			{
				pathname: routePath,
				search: `?${params}`,
				title: item.title,
			},
			"split",
		);
	}, [mailOnly, markThreadRead, openWorkspaceRoute, queryClient, routePath, statefulItemsById]);

	const archiveInboxMessages = useCallback(async (messageIds: string[]) => {
		if (messageIds.length === 0) return;
		setArchiving(true);
		try {
			await Promise.all(messageIds.map((id) => api.archiveMail(id)));
			setInbox((current) => current.filter((message) => !messageIds.includes(message.id)));
		} finally {
			setArchiving(false);
		}
	}, []);

	const archiveThread = useCallback(async (messageIds: string[]) => {
		await archiveInboxMessages(messageIds);
		closeWorkspaceRoute();
	}, [archiveInboxMessages, closeWorkspaceRoute]);

	const renderInboxCard = useCallback((
		item: InboxProjectionItem,
		presentationMode: import("@/adaptive-cards/card-presentation").CardPresentationMode,
	) => {
		const source = statefulItemsById.get(item.id);
		if (!source) return null;
		const latestMessage = source.thread?.messages.at(-1)?.message;
		const inboxMessageIds = source.thread
			? getInboxMessageIdsForThread(source.thread, inbox)
			: [];
		const threadRoute = source.thread && source.mailbox
			? {
					pathname: routePath,
					search: mailOnly
						? `?mailbox=${source.mailbox}&thread=${encodeURIComponent(source.thread.id)}`
						: `?facet=messages&mailbox=${source.mailbox}&thread=${encodeURIComponent(source.thread.id)}`,
					title: source.thread.subject,
				}
			: undefined;
		const envelope = source.thread
			? presentMessage({
					id: item.id,
					from: latestMessage?.from ?? "Unknown sender",
					subject: item.title,
					preview: item.summary,
					timestamp: item.timestamp,
					surface: "inbox",
					canArchive: inboxMessageIds.length > 0,
					sent: source.mailbox === "sent",
					targetRoute: threadRoute,
				})
			: presentInboxItem(item, {
					surface: "inbox",
					targetRoute: source.targetRoute,
					creator: creatorForInboxItem(source),
					facts: source.statusReport
						? [
								{ label: "Arm", value: source.statusReport.armId },
								{ label: "Task", value: source.statusReport.taskId },
								{ label: "Status", value: source.statusReport.status.replaceAll("_", " ") },
							]
						: [],
				});
		const handleAction = async (request: CardActionRequest) => {
			if (request.verb === "message.open") {
				openItem(item);
				return;
			}
			if (request.verb === "message.archive") {
				await archiveInboxMessages(inboxMessageIds);
				return;
			}
			if (request.verb === "resource.open" && source.targetRoute) {
				openWorkspaceRoute(source.targetRoute, "focus");
				return;
			}
			await api.executeWorkbenchCardAction(request);
			await load();
		};
		return (
			<DeferredAdaptiveCardView
					envelope={envelope}
					onAction={handleAction}
					presentationMode={presentationMode}
				headerActions={(
					<Button
						isIconOnly
						size="sm"
						variant="ghost"
						onPress={() => openItem(item)}
						aria-label={`Open ${item.title} in panel`}
					>
						<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
					</Button>
				)}
			/>
		);
	}, [archiveInboxMessages, inbox, load, mailOnly, openItem, openWorkspaceRoute, routePath, statefulItemsById]);

	if (selectedThreadId) {
		return (
			<MailThreadProjection
				thread={selectedThread}
				inboxMessages={inbox}
				sentMessages={sent}
				onReply={openReply}
				onArchive={(messageIds) => void archiveThread(messageIds)}
				onClose={closeWorkspaceRoute}
				archiving={archiving}
			/>
		);
	}


	return (
		<ProjectionInbox
			title={mailOnly ? "Mail" : "Inbox"}
			description={mailOnly
				? "Project messages across Inbox, Sent, and Archived mailboxes"
				: "Messages, Brain decisions, Arm events, and operational history"}
			items={projectionItems.map((entry) => entry.item)}
			facets={facets}
			activeFacet={activeFacet}
			display={display}
			onDisplayChange={updateDisplay}
			toolbarScreenId={mailOnly ? "mail" : "inbox"}
			onFacetChange={handleFacetChange}
			onOpen={openItem}
			renderCard={renderInboxCard}
			onRefresh={() => void load()}
			toolbarContent={
				mailOnly || activeFacet === "messages" ? (
					<ProjectionControlGroup>
						<ProjectionFilterMenu
							label="Mailbox"
							value={mailbox}
							options={MAILBOXES}
							onChange={handleMailboxChange}
						/>
						<Button size="sm" variant="ghost" onPress={openNewMessage}>
							<MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
							New
						</Button>
					</ProjectionControlGroup>
				) : activeFacet === "brain" ? (
					<ProjectionControlGroup>
						<WorkbenchStatusDot
							tone={connected && authenticated ? "success" : "neutral"}
							label={connected && authenticated ? "Live" : "Reconnecting"}
						/>
						<ProjectionFilterMenu
							label="Category"
							value={brainCategory}
							options={BRAIN_CATEGORY_OPTIONS}
							onChange={handleBrainCategoryChange}
						/>
						<Button
							size="sm"
							variant="ghost"
							isDisabled={olderBrainActivityLoading || !hasOlderBrainActivity}
							onPress={() => void loadOlderBrainActivity()}
						>
							{olderBrainActivityLoading ? (
								<LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
							) : null}
							{hasOlderBrainActivity ? "Load older" : "Beginning"}
						</Button>
					</ProjectionControlGroup>
				) : null
			}
			onMarkAllRead={(visible) => {
				const visibleIds = new Set(visible.map((item) => item.id));
				for (const source of statefulItems) {
					if (source.thread && visibleIds.has(source.item.id)) void markThreadRead(source.thread);
				}
				void api.bulkUpdateWorkbenchAttention([...visibleIds], "read").then((response) => {
					setAttention((current) => {
						const updates = new Map(response.attention.map((entry) => [entry.itemKey, entry]));
						return [
							...current.filter((entry) => !updates.has(entry.itemKey)),
							...response.attention,
						];
					});
				});
			}}
			loading={loading}
		/>
	);
}
