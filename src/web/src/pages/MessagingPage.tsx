/**
 * Multi-aspect workbench inbox.
 *
 * This page projects Brain activity, Arm events, project mail, and status
 * reports through one reusable inbox. Selecting an item opens a dedicated
 * Golden Layout panel instead of a drawer or embedded side viewer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { Archive, Reply } from "lucide-react";

import { WorkbenchEmptyState, WorkbenchHeader } from "@/design-system/WorkbenchSurface";
import { usePageTitle } from "@/hooks/usePageTitle";
import { api, type ActivityEntry, type MailMessage, type StatusReport, useMessage } from "@/lib";
import {
	ProjectionInbox,
	type InboxFacet,
	type InboxProjectionItem,
} from "@/workbench/ProjectionInbox";
import { useProjectionSignal } from "@/workbench/live-projections";
import {
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from "@/workspace/route-context";

interface InboxItemData {
	item: InboxProjectionItem;
	mail?: MailMessage;
	mailDirection?: "inbox" | "sent";
	statusReport?: StatusReport;
	activity?: ActivityEntry;
}

const FACETS: InboxFacet[] = [
	{
		id: "attention",
		label: "Needs attention",
		predicate: (item) => item.requiresAction || item.unread,
	},
	{ id: "brain", label: "Brain", kinds: ["brain"] },
	{ id: "arms", label: "Arms", kinds: ["arm", "status"] },
	{ id: "project", label: "Project", kinds: ["project"] },
	{ id: "system", label: "System", kinds: ["system", "proposal"] },
	{ id: "all", label: "All" },
];

function activityKind(entry: ActivityEntry): InboxProjectionItem["kind"] {
	const actor = entry.actor.toLowerCase();
	if (actor.includes("brain")) return "brain";
	if (actor.includes("arm") || entry.action.startsWith("arm.")) return "arm";
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

function messageToItem(message: MailMessage, direction: "inbox" | "sent"): InboxItemData {
	return {
		item: {
			id: `${direction}:${message.id}`,
			kind: "project",
			title: message.subject || "(No subject)",
			summary: message.body.slice(0, 180),
			timestamp: message.date,
			source: direction === "sent" ? `To ${message.to}` : `From ${message.from}`,
			resourceId: message.id,
			unread: direction === "inbox" && !message.flags.seen,
			requiresAction: direction === "inbox" && !message.flags.seen,
			severity: message.flags.flagged ? "warning" : "info",
		},
		mail: message,
		mailDirection: direction,
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

export function MessagingPage() {
	usePageTitle("Coleo Observatory - Inbox");
	const [searchParams] = useWorkspaceSearchParams();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const { openReply } = useMessage();
	const [items, setItems] = useState<InboxItemData[]>([]);
	const [activeFacet, setActiveFacet] = useState("attention");
	const [loading, setLoading] = useState(true);
	const loadTimerRef = useRef<number | null>(null);
	const selectedId = searchParams.get("item");

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const [activity, inbox, sent, reports] = await Promise.all([
				api.listActivity({ limit: 100 }),
				api.listInbox({ limit: 100 }),
				api.listSent({ limit: 50 }),
				api.listStatusReports({ limit: 100 }),
			]);
			const merged = [
				...inbox.messages.map((message) => messageToItem(message, "inbox")),
				...sent.messages.map((message) => messageToItem(message, "sent")),
				...reports.reports.map(reportToItem),
				...activity.activity.map(activityToItem),
			].sort((left, right) =>
				new Date(right.item.timestamp).getTime() - new Date(left.item.timestamp).getTime()
			);
			setItems(merged);
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

	useProjectionSignal((signal) => {
		if (!["mail", "brain", "arms", "arm-events", "activity"].includes(signal.channel)) return;
		const provisional: InboxItemData = {
			item: {
				id: `live:${signal.channel}:${signal.event}:${signal.timestamp}`,
				kind: signal.channel === "brain"
					? "brain"
					: signal.channel === "mail"
						? "project"
						: signal.channel === "activity"
							? "system"
							: "arm",
				title: signal.event.replaceAll(".", " "),
				summary: "Live update received; reconciling with the server.",
				timestamp: signal.timestamp,
				source: signal.channel,
				unread: true,
				requiresAction: signal.event.includes("blocked") ||
					signal.event.includes("error") ||
					signal.event.includes("received"),
				severity: signal.event.includes("error") || signal.event.includes("failed")
					? "danger"
					: signal.event.includes("blocked")
						? "warning"
						: "info",
			},
		};
		setItems((current) => [provisional, ...current.filter((item) => item.item.id !== provisional.item.id)]);
		if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current);
		loadTimerRef.current = window.setTimeout(() => {
			loadTimerRef.current = null;
			void load();
		}, 250);
	});

	const selected = useMemo(
		() => items.find((entry) => entry.item.id === selectedId) ?? null,
		[items, selectedId],
	);

	const openItem = useCallback((item: InboxProjectionItem) => {
		const source = items.find((entry) => entry.item.id === item.id);
		setItems((current) => current.map((entry) =>
			entry.item.id === item.id
				? { ...entry, item: { ...entry.item, unread: false } }
				: entry
		));
		if (source?.mail && source.mailDirection === "inbox" && !source.mail.flags.seen) {
			void api.markMailRead(source.mail.id);
		}
		openWorkspaceRoute(
			{
				pathname: "/messaging",
				search: `?item=${encodeURIComponent(item.id)}`,
				title: item.title,
			},
			"split",
		);
	}, [items, openWorkspaceRoute]);

	if (selectedId) {
		if (!selected) {
			return <WorkbenchEmptyState title="Loading inbox item" description="The selected item is being restored." />;
		}
		return (
			<div className="flex h-full min-h-0 flex-col bg-background">
				<WorkbenchHeader
					title={selected.item.title}
					description={`${selected.item.source ?? selected.item.kind} · ${new Date(selected.item.timestamp).toLocaleString()}`}
					actions={selected.mail ? (
						<>
							<Button
								size="sm"
								variant="ghost"
								onPress={() => openReply({
									messageId: selected.mail!.id,
									from: selected.mail!.from,
									subject: selected.mail!.subject,
									body: selected.mail!.body,
								})}
							>
								<Reply className="h-3.5 w-3.5" />
								Reply
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onPress={() => {
									void api.archiveMail(selected.mail!.id).then(load);
								}}
							>
								<Archive className="h-3.5 w-3.5" />
								Archive
							</Button>
						</>
					) : undefined}
				/>
				<div className="min-h-0 flex-1 overflow-auto p-5">
					<div className="readable-copy mx-auto max-w-4xl whitespace-pre-wrap">
						{selected.mail?.body ??
							selected.statusReport?.summary ??
							JSON.stringify(selected.activity?.details ?? selected.item, null, 2)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<ProjectionInbox
			title="Inbox"
			description="Brain, Arms, and project communication"
			items={items.map((entry) => entry.item)}
			facets={FACETS}
			activeFacet={activeFacet}
			onFacetChange={setActiveFacet}
			onOpen={openItem}
			onRefresh={() => void load()}
			onMarkAllRead={(visible) => {
				const ids = new Set(visible.map((item) => item.id));
				for (const entry of items) {
					if (
						ids.has(entry.item.id)
						&& entry.mail
						&& entry.mailDirection === "inbox"
						&& !entry.mail.flags.seen
					) {
						void api.markMailRead(entry.mail.id);
					}
				}
				setItems((current) => current.map((entry) =>
					ids.has(entry.item.id)
						? { ...entry, item: { ...entry.item, unread: false } }
						: entry
				));
			}}
			loading={loading}
		/>
	);
}
