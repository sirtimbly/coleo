/**
 * Unified workbench Inbox for project mail and operational attention.
 *
 * Mail threads retain view, read, reply, archive, and nested-reply behavior.
 * Brain, Arm, proposal, report, and system history share the same projection
 * so legacy Activity, History, Proposals, and Project Mail routes can redirect.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { ArrowUpRight, FileText, LoaderCircle, MessageSquarePlus } from "lucide-react";

import {
	WorkbenchEmptyState,
	WorkbenchHeader,
	WorkbenchStatusDot,
} from "@/design-system/WorkbenchSurface";
import { usePageTitle } from "@/hooks/usePageTitle";
import { api, cn, type ActivityEntry, type MailMessage, type StatusReport, useMessage } from "@/lib";
import {
	buildMailThreads,
	getInboxMessageIdsForThread,
	type MailboxTab,
	type MailThread,
} from "@/pages/mail-page-utils";
import {
	BRAIN_ACTIVITY_CATEGORY_LABELS,
	formatBrainActivity,
	mergeBrainActivity,
	type BrainActivityCategory,
	type BrainActivityTone,
} from "@/pages/brain-activity";
import { MailThreadProjection } from "@/workbench/MailThreadProjection";
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

interface InboxItemData {
	item: InboxProjectionItem;
	thread?: MailThread;
	mailbox?: MailboxTab;
	statusReport?: StatusReport;
	activity?: ActivityEntry;
	recentEvent?: RecentEvent;
	brainCategory?: BrainActivityCategory;
	targetRoute?: { pathname: string; search: string };
}

const FACETS: InboxFacet[] = [
	{
		id: "attention",
		label: "Needs attention",
		predicate: (item) => item.requiresAction || item.unread,
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

function isBrainCategory(value: string | null): value is BrainActivityCategory | "all" {
	return value !== null && value in BRAIN_ACTIVITY_CATEGORY_LABELS;
}

function activityKind(entry: ActivityEntry): InboxProjectionItem["kind"] {
	const actor = entry.actor.toLowerCase();
	const action = entry.action.toLowerCase();
	if (action.includes("proposal")) return "proposal";
	if (actor.includes("brain")) return "brain";
	if (actor.includes("arm") || action.startsWith("arm.")) return "arm";
	return "system";
}

function activitySeverity(entry: ActivityEntry): InboxProjectionItem["severity"] {
	const action = entry.action.toLowerCase();
	if (action.includes("error") || action.includes("failed")) return "danger";
	if (action.includes("blocked") || action.includes("warning")) return "warning";
	if (action.includes("completed") || action.includes("resolved")) return "success";
	return "info";
}

function activityRequiresAction(entry: ActivityEntry): boolean {
	const action = entry.action.toLowerCase();
	return action.includes("blocked") ||
		action.includes("approval") ||
		action.includes("question") ||
		action.includes("error") ||
		action.includes("failed");
}

function threadToItem(thread: MailThread, mailbox: MailboxTab): InboxItemData {
	const latest = thread.messages.at(-1)?.message;
	return {
		item: {
			id: `thread:${mailbox}:${thread.id}`,
			kind: "project",
			title: thread.subject || "(No subject)",
			summary: latest?.body.slice(0, 180) || `${thread.messages.length} messages`,
			timestamp: thread.lastMessageDate.toISOString(),
			source: `${mailbox === "archive" ? "Archived" : mailbox === "sent" ? "Sent" : "Inbox"} · ${latest?.from ?? "Unknown sender"} · ${thread.messages.length} ${thread.messages.length === 1 ? "message" : "messages"}`,
			resourceId: thread.id,
			unread: mailbox === "inbox" && thread.unreadCount > 0,
			requiresAction: mailbox === "inbox" && thread.unreadCount > 0,
			severity: thread.unreadCount > 0 ? "warning" : "info",
		},
		thread,
		mailbox,
	};
}

function reportToItem(report: StatusReport): InboxItemData {
	const needsAttention = report.status === "blocked" ||
		report.status === "issues_found" ||
		report.status === "needs_review";
	return {
		item: {
			id: `status:${report.id}`,
			kind: "status",
			title: `${report.armId}: ${report.status.replaceAll("_", " ")}`,
			summary: report.summary,
			timestamp: report.createdAt,
			source: `Status report · task ${report.taskId}`,
			resourceId: report.id,
			unread: needsAttention,
			requiresAction: needsAttention,
			severity: report.status === "blocked"
				? "danger"
				: report.status === "on_track"
					? "success"
					: needsAttention
						? "warning"
						: "info",
		},
		statusReport: report,
	};
}

function activityToItem(entry: ActivityEntry): InboxItemData {
	const requiresAction = activityRequiresAction(entry);
	return {
		item: {
			id: `activity:${entry.id}`,
			kind: activityKind(entry),
			title: entry.action.replaceAll("_", " ").replaceAll(".", " "),
			summary: entry.target ? `${entry.actor} · ${entry.target}` : entry.actor,
			timestamp: entry.timestamp,
			source: entry.actor,
			resourceId: entry.target ?? undefined,
			unread: requiresAction,
			requiresAction,
			severity: activitySeverity(entry),
		},
		activity: entry,
	};
}

function brainToneToSeverity(tone: BrainActivityTone): InboxProjectionItem["severity"] {
	if (tone === "danger") return "danger";
	if (tone === "warning") return "warning";
	if (tone === "success") return "success";
	return "info";
}

function brainActivityToItem(entry: ActivityEntry): InboxItemData {
	const formatted = formatBrainActivity(entry);
	const requiresAction = formatted.tone === "danger" ||
		formatted.tone === "warning" ||
		activityRequiresAction(entry);
	const targetRoute = formatted.target && formatted.category === "arms"
		? {
				pathname: "/viewer",
				search: `?arm=${encodeURIComponent(formatted.target)}`,
			}
		: formatted.target && (formatted.category === "tasks" || formatted.category === "decisions")
			? {
					pathname: "/tasks",
					search: `?task=${encodeURIComponent(formatted.target)}&view=details`,
				}
			: undefined;
	return {
		item: {
			id: `activity:${formatted.id}`,
			kind: "brain",
			title: formatted.title,
			summary: formatted.summary,
			timestamp: formatted.timestamp,
			source: `Brain · ${BRAIN_ACTIVITY_CATEGORY_LABELS[formatted.category]}`,
			resourceId: formatted.target ?? undefined,
			unread: requiresAction,
			requiresAction,
			severity: brainToneToSeverity(formatted.tone),
		},
		activity: entry,
		brainCategory: formatted.category,
		targetRoute,
	};
}

export function MessagingPage() {
	usePageTitle("Coleo Observatory - Inbox");
	const [searchParams] = useWorkspaceSearchParams();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const closeWorkspaceRoute = useWorkspaceCloseRoute("/messaging");
	const { openNewMessage, openReply } = useMessage();
	const { connected, authenticated } = useLiveProjections();
	const initialFacet = searchParams.get("facet");
	const initialMailbox = searchParams.get("mailbox");
	const initialBrainCategory = searchParams.get("brainCategory");
	const [activeFacet, setActiveFacet] = useState(
		FACETS.some((facet) => facet.id === initialFacet) ? initialFacet! : "attention",
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
	const [loading, setLoading] = useState(true);
	const [archiving, setArchiving] = useState(false);
	const loadTimerRef = useRef<number | null>(null);
	const brainActivityInitializedRef = useRef(false);
	const selectedThreadId = searchParams.get("thread");
	const selectedItemId = searchParams.get("item");
	const detailMailboxParam = searchParams.get("mailbox");
	const detailMailbox: MailboxTab =
		detailMailboxParam === "sent" || detailMailboxParam === "archive"
			? detailMailboxParam
			: "inbox";

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const [
				activityResponse,
				brainActivityResponse,
				inboxResponse,
				sentResponse,
				archiveResponse,
				reportsResponse,
				recentEventsResponse,
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
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => () => {
		if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current);
	}, []);

	useEffect(() => {
		const facet = searchParams.get("facet");
		if (facet && FACETS.some((candidate) => candidate.id === facet)) setActiveFacet(facet);
		const nextMailbox = searchParams.get("mailbox");
		if (nextMailbox === "inbox" || nextMailbox === "sent" || nextMailbox === "archive") {
			setMailbox(nextMailbox);
		}
		const nextBrainCategory = searchParams.get("brainCategory");
		if (isBrainCategory(nextBrainCategory)) setBrainCategory(nextBrainCategory);
	}, [searchParams]);

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
		if (!["mail", "brain", "arms", "arm-events", "activity"].includes(signal.channel)) return;
		if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current);
		loadTimerRef.current = window.setTimeout(() => {
			loadTimerRef.current = null;
			void load();
		}, 200);
	});

	const effectiveMailbox = activeFacet === "messages" ? mailbox : "inbox";
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
		const merged = [
			...threads.map((thread) => threadToItem(thread, effectiveMailbox)),
			...reports.map(reportToItem),
			...activity
				.filter((entry) => !brainActivityIds.has(entry.id))
				.map(activityToItem),
			...brainActivity.map(brainActivityToItem),
			...recentEvents
				.filter(isNotableEvent)
				.map((event, index) => projectRecentEvent(event, index)),
		];
		return merged.sort(
			(left, right) =>
				new Date(right.item.timestamp).getTime() - new Date(left.item.timestamp).getTime(),
		);
	}, [activity, brainActivity, effectiveMailbox, recentEvents, reports, threads]);

	const projectionItems = useMemo(
		() => items.filter((entry) =>
			activeFacet !== "brain" ||
			brainCategory === "all" ||
			entry.item.kind !== "brain" ||
			entry.brainCategory === brainCategory
		),
		[activeFacet, brainCategory, items],
	);

	const selectedItem = useMemo(
		() => items.find((entry) => entry.item.id === selectedItemId) ?? null,
		[items, selectedItemId],
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
		const source = items.find((entry) => entry.item.id === item.id);
		if (source?.thread && source.mailbox) {
			void markThreadRead(source.thread);
			openWorkspaceRoute(
				{
					pathname: "/messaging",
					search: `?facet=messages&mailbox=${source.mailbox}&thread=${encodeURIComponent(source.thread.id)}`,
					title: source.thread.subject,
				},
				"split",
			);
			return;
		}
		openWorkspaceRoute(
			{
				pathname: "/messaging",
				search: `?facet=${activeFacet}&item=${encodeURIComponent(item.id)}`,
				title: item.title,
			},
			"split",
		);
	}, [activeFacet, items, markThreadRead, openWorkspaceRoute]);

	const archiveThread = useCallback(async (messageIds: string[]) => {
		if (messageIds.length === 0) return;
		setArchiving(true);
		try {
			await Promise.all(messageIds.map((id) => api.archiveMail(id)));
			setInbox((current) => current.filter((message) => !messageIds.includes(message.id)));
			await load();
			closeWorkspaceRoute();
		} finally {
			setArchiving(false);
		}
	}, [closeWorkspaceRoute, load]);

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

	if (selectedItemId) {
		if (!selectedItem) {
			return <WorkbenchEmptyState title="Loading inbox item" description="The selected item is being restored." />;
		}
		return (
			<div className="flex h-full min-h-0 flex-col bg-background">
				<WorkbenchHeader
					title={selectedItem.item.title}
					description={`${selectedItem.item.source ?? selectedItem.item.kind} · ${new Date(selectedItem.item.timestamp).toLocaleString()}`}
					icon={<FileText className="h-4 w-4" />}
					actions={selectedItem.targetRoute ? (
						<Button
							size="sm"
							variant="secondary"
							onPress={() => openWorkspaceRoute(selectedItem.targetRoute!, "focus")}
						>
							<ArrowUpRight className="h-3.5 w-3.5" />
							Open target
						</Button>
					) : null}
				/>
				<div className="min-h-0 flex-1 overflow-auto p-5">
					<pre className="mx-auto max-w-4xl whitespace-pre-wrap font-sans text-sm leading-6">
						{selectedItem.statusReport?.summary ??
							JSON.stringify(
								selectedItem.activity?.details ??
									selectedItem.recentEvent?.data ??
									selectedItem.item,
								null,
								2,
							)}
					</pre>
				</div>
			</div>
		);
	}

	return (
		<ProjectionInbox
			title="Inbox"
			description="Messages, Brain decisions, Arm events, and operational history"
			items={projectionItems.map((entry) => entry.item)}
			facets={FACETS}
			activeFacet={activeFacet}
			onFacetChange={setActiveFacet}
			onOpen={openItem}
			onRefresh={() => void load()}
			toolbarContent={
				activeFacet === "messages" ? (
					<div className="flex items-center gap-1 border-l border-border pl-2">
						{MAILBOXES.map((option) => (
							<button
								key={option.id}
								type="button"
								aria-pressed={mailbox === option.id}
								onClick={() => setMailbox(option.id)}
								className={cn(
									"h-7 border px-2 text-xs",
									mailbox === option.id
										? "border-accent/40 bg-accent/10 text-accent"
										: "border-transparent text-muted-foreground hover:bg-surface",
								)}
							>
								{option.label}
							</button>
						))}
						<Button size="sm" variant="ghost" onPress={openNewMessage}>
							<MessageSquarePlus className="h-3.5 w-3.5" />
							New
						</Button>
					</div>
				) : activeFacet === "brain" ? (
					<div className="flex max-w-full items-center gap-1 border-l border-border pl-2">
						<WorkbenchStatusDot
							tone={connected && authenticated ? "success" : "neutral"}
							label={connected && authenticated ? "Live" : "Reconnecting"}
						/>
						<div className="flex max-w-full items-center gap-1 overflow-x-auto pl-1">
							{(
								Object.entries(BRAIN_ACTIVITY_CATEGORY_LABELS) as Array<
									[BrainActivityCategory | "all", string]
								>
							).map(([category, label]) => (
								<button
									key={category}
									type="button"
									aria-pressed={brainCategory === category}
									onClick={() => setBrainCategory(category)}
									className={cn(
										"h-7 shrink-0 border px-2 text-xs",
										brainCategory === category
											? "border-accent/40 bg-accent/10 text-accent"
											: "border-transparent text-muted-foreground hover:bg-surface",
									)}
								>
									{label}
								</button>
							))}
						</div>
						<Button
							size="sm"
							variant="ghost"
							isDisabled={olderBrainActivityLoading || !hasOlderBrainActivity}
							onPress={() => void loadOlderBrainActivity()}
						>
							{olderBrainActivityLoading ? (
								<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
							) : null}
							{hasOlderBrainActivity ? "Load older" : "Beginning"}
						</Button>
					</div>
				) : null
			}
			onMarkAllRead={(visible) => {
				const visibleIds = new Set(visible.map((item) => item.id));
				for (const source of items) {
					if (source.thread && visibleIds.has(source.item.id)) void markThreadRead(source.thread);
				}
			}}
			loading={loading}
		/>
	);
}
