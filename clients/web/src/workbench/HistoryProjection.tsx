/**
 * Reusable chronological projection for operational activity, mail, and
 * persisted Arm reports.
 *
 * The standalone History route and the unified Inbox both consume this
 * component, keeping filters, expansion, and ordering behavior identical.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Activity, AlertCircle, FileText, Inbox, Mail, RefreshCw, Send } from "lucide-react";

import { CollectionRow } from "@/design-system/CollectionRow";
import { ProjectionSearch } from "@/design-system/ProjectionControls";
import {
	WorkbenchEmptyState,
	WorkbenchHeader,
	WorkbenchToolbar,
} from "@/design-system/WorkbenchSurface";
import {
	api,
	type ActivityEntry,
	type JsonObject,
	type MailMessage,
	type StatusReport,
} from "@/lib/api";

type HistoryFilter = "all" | "logs" | "messages" | "reports";
type HistoryKind = "activity" | "inbox" | "sent" | "archive" | "report";

interface HistoryItem {
	id: string;
	kind: HistoryKind;
	group: Exclude<HistoryFilter, "all">;
	timestamp: string;
	source: string;
	event: string;
	summary: string;
	target?: string;
	details: JsonObject;
}

const FILTERS: ReadonlyArray<{ key: HistoryFilter; label: string }> = [
	{ key: "all", label: "All" },
	{ key: "logs", label: "Logs" },
	{ key: "messages", label: "Messages" },
	{ key: "reports", label: "Reports" },
];

function normalizedTimestamp(value: string): string {
	return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
}

function safeTimestamp(value: string): number {
	const timestamp = Date.parse(normalizedTimestamp(value));
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatTimestamp(value: string): string {
	return new Date(normalizedTimestamp(value)).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function titleCase(value: string): string {
	return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activitySummary(entry: ActivityEntry): string {
	const detail = entry.details;
	const preferred = detail.message ?? detail.subject ?? detail.summary ?? detail.title;
	if (typeof preferred === "string" && preferred.trim()) return preferred;
	if (entry.target) return `${titleCase(entry.action)} on ${entry.target}`;
	return titleCase(entry.action);
}

function mapActivity(entry: ActivityEntry, index: number): HistoryItem {
	return {
		id: `activity-${entry.id ?? `${entry.timestamp}-${index}`}`,
		kind: "activity",
		group: "logs",
		timestamp: entry.timestamp,
		source: entry.actor || "brain",
		event: titleCase(entry.action),
		summary: activitySummary(entry),
		target: entry.target ?? undefined,
		details: entry.details,
	};
}

function mapMail(message: MailMessage, kind: "inbox" | "sent" | "archive"): HistoryItem {
	const label = kind === "inbox" ? "Received" : kind === "sent" ? "Sent" : "Archived";
	return {
		id: `${kind}-${message.id}`,
		kind,
		group: "messages",
		timestamp: message.date,
		source: kind === "sent" ? message.to : message.from,
		event: label,
		summary: message.subject,
		target: kind === "sent" ? message.from : message.to,
		details: {
			from: message.from,
			to: message.to,
			subject: message.subject,
			body: message.body,
			headers: message.headers,
			flags: message.flags,
		},
	};
}

function mapReport(report: StatusReport): HistoryItem {
	return {
		id: `report-${report.id}`,
		kind: "report",
		group: "reports",
		timestamp: report.createdAt,
		source: report.armId,
		event: titleCase(report.status),
		summary: report.summary,
		target: report.taskId,
		details: {
			taskId: report.taskId,
			armId: report.armId,
			status: report.status,
			summary: report.summary,
			issues: report.issues ?? [],
			blockers: report.blockers ?? [],
			nextSteps: report.nextSteps ?? null,
			filesChanged: report.filesChanged ?? [],
			testsStatus: report.testsStatus ?? null,
		},
	};
}

function KindIcon({ kind }: { kind: HistoryKind }) {
	if (kind === "activity") return <Activity className="h-3.5 w-3.5" />;
	if (kind === "inbox") return <Inbox className="h-3.5 w-3.5" />;
	if (kind === "sent") return <Send className="h-3.5 w-3.5" />;
	if (kind === "archive") return <Mail className="h-3.5 w-3.5" />;
	return <FileText className="h-3.5 w-3.5" />;
}

export function HistoryProjection({
	embedded = false,
	initialFilter = "all",
}: {
	embedded?: boolean;
	initialFilter?: HistoryFilter;
}) {
	const [items, setItems] = useState<HistoryItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState<HistoryFilter>(initialFilter);
	const [searchText, setSearchText] = useState("");
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const loadHistory = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const [activityResponse, inboxResponse, sentResponse, archiveResponse, reportsResponse] =
				await Promise.all([
					api.listActivity({ limit: 100 }),
					api.listInbox({ limit: 100 }),
					api.listSent({ limit: 100 }),
					api.listArchive({ limit: 100 }),
					api.listStatusReports({ limit: 100 }),
				]);
			const historyItems = [
				...activityResponse.activity.map(mapActivity),
				...inboxResponse.messages.map((message) => mapMail(message, "inbox")),
				...sentResponse.messages.map((message) => mapMail(message, "sent")),
				...archiveResponse.messages.map((message) => mapMail(message, "archive")),
				...reportsResponse.reports.map(mapReport),
			].sort((left, right) => safeTimestamp(right.timestamp) - safeTimestamp(left.timestamp));
			setItems(historyItems);
			setExpandedId((current) =>
				current && historyItems.some((item) => item.id === current) ? current : null,
			);
		} catch (historyError) {
			setError(historyError instanceof Error ? historyError.message : "Failed to load history");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadHistory();
	}, [loadHistory]);

	const counts = useMemo(() => {
		const next = { all: items.length, logs: 0, messages: 0, reports: 0 };
		for (const item of items) next[item.group] += 1;
		return next;
	}, [items]);

	const filteredItems = useMemo(() => {
		const query = searchText.trim().toLowerCase();
		return items.filter((item) => {
			if (filter !== "all" && item.group !== filter) return false;
			if (!query) return true;
			return [item.source, item.event, item.summary, item.target, JSON.stringify(item.details)]
				.filter(Boolean)
				.join(" ")
				.toLowerCase()
				.includes(query);
		});
	}, [filter, items, searchText]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			{embedded ? null : (
				<WorkbenchHeader
					title="History"
					description="Chronological operational activity, messages, and Arm reports"
					icon={<Activity className="h-4 w-4" />}
					actions={
						<Button
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={loadHistory}
							isDisabled={loading}
							aria-label="Refresh History"
						>
							<RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
						</Button>
					}
				/>
			)}
			<WorkbenchToolbar>
				<ProjectionSearch
					value={searchText}
					onChange={setSearchText}
					placeholder="Search history"
				/>
				<span className="text-xs text-muted-foreground">{filteredItems.length} entries</span>
				{FILTERS.map((option) => (
					<button
						key={option.key}
						type="button"
						aria-pressed={filter === option.key}
						onClick={() => setFilter(option.key)}
						className={
							filter === option.key
								? "border border-accent/40 bg-accent/10 px-2 py-1 text-xs text-accent"
								: "border border-transparent px-2 py-1 text-xs text-muted-foreground hover:bg-surface-secondary"
						}
					>
						{option.label} {counts[option.key]}
					</button>
				))}
			</WorkbenchToolbar>

			<div className="min-h-0 flex-1 overflow-auto">
				{error ? (
					<div className="m-3 flex items-center gap-2 border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
						<AlertCircle className="h-4 w-4" />
						{error}
					</div>
				) : null}
				{loading && items.length === 0 ? (
					<div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
						<RefreshCw className="h-4 w-4 animate-spin" />
						Loading history…
					</div>
				) : filteredItems.length === 0 ? (
					<WorkbenchEmptyState
						title="No history entries"
						description="Logs, messages, and reports will appear here chronologically."
						icon={<Activity className="h-4 w-4" />}
					/>
				) : (
					<div className="border-t border-border">
						{filteredItems.map((item) => {
							const expanded = expandedId === item.id;
							return (
								<div key={item.id}>
									<CollectionRow
										title={item.summary}
										description={`${item.event} · ${item.source}${item.target ? ` → ${item.target}` : ""}`}
										meta={formatTimestamp(item.timestamp)}
										leading={<KindIcon kind={item.kind} />}
										selected={expanded}
										onOpen={() => setExpandedId(expanded ? null : item.id)}
									/>
									{expanded ? (
										<pre className="max-h-64 overflow-auto border-b border-border bg-surface-secondary/30 p-4 font-mono text-xs leading-5 text-foreground">
											{JSON.stringify(item.details, null, 2)}
										</pre>
									) : null}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
