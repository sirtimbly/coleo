import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, BrainCircuit, ChevronDown, ChevronRight, CircleDot, Loader2, ScrollText } from "lucide-react";
import { Button, Chip } from "@heroui/react";
import { cn, type ActivityEntry, type JsonObject } from "@/lib";
import {
	formatBrainActivity,
	type BrainActivityCategory,
	type BrainActivityItem,
	type BrainActivityTone,
} from "@/pages/brain-activity";

const CATEGORY_LABELS: Record<BrainActivityCategory | "all", string> = {
	all: "All",
	operations: "Operations",
	tasks: "Tasks",
	arms: "Arms",
	decisions: "Decisions",
	planning: "Planning",
	alerts: "Alerts",
};

const TONE_CLASSES: Record<BrainActivityTone, string> = {
	default: "bg-default-400",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-danger",
	accent: "bg-accent",
};

const CATEGORY_ICONS = {
	operations: CircleDot,
	tasks: ScrollText,
	arms: Bot,
	decisions: BrainCircuit,
	planning: ScrollText,
	alerts: AlertTriangle,
} as const;

function formatTime(timestamp: string): string {
	return new Date(timestamp).toLocaleString([], {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function visibleDetails(details: JsonObject): JsonObject {
	const hidden = new Set(["activityId", "actor", "target"]);
	return Object.fromEntries(Object.entries(details).filter(([key, value]) => !hidden.has(key) && value !== undefined));
}

function ActivityRow({ item, onNavigate }: { item: BrainActivityItem; onNavigate?: (pathname: string, search?: string) => void }) {
	const [expanded, setExpanded] = useState(false);
	const Icon = CATEGORY_ICONS[item.category];
	const details = visibleDetails(item.details);
	const hasDetails = Object.keys(details).length > 0;
	const taskTarget = item.target && (item.category === "tasks" || item.category === "decisions");
	const armTarget = item.target && item.category === "arms";

	const navigateToTarget = () => {
		if (!onNavigate || !item.target) return;
		if (armTarget) onNavigate("/viewer", `?arm=${encodeURIComponent(item.target)}`);
		if (taskTarget) onNavigate("/tasks", `?task=${encodeURIComponent(item.target)}&view=details`);
	};

	return (
		<div data-activity-id={item.id} className="border-b border-border/70 px-3 py-3 last:border-b-0">
			<div className="flex items-start gap-3">
				<div className="relative mt-0.5 rounded-md border border-border bg-surface-secondary/45 p-2">
					<Icon className="h-4 w-4 text-muted-foreground" />
					<span className={cn("absolute -right-1 -top-1 h-2 w-2 rounded-full", TONE_CLASSES[item.tone])} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-semibold text-foreground">{item.title}</span>
						<Chip size="sm" variant="soft" className="capitalize">{CATEGORY_LABELS[item.category]}</Chip>
					</div>
					<p className="mt-1 break-words text-sm leading-5 text-muted-foreground">{item.summary}</p>
					{item.target && (taskTarget || armTarget) ? (
						<button type="button" onClick={navigateToTarget} className="mt-1 font-mono text-[11px] text-accent hover:underline">
							{item.target}
						</button>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
					<span>{formatTime(item.timestamp)}</span>
					{hasDetails ? (
						<Button variant="ghost" size="sm" isIconOnly aria-label={expanded ? "Hide activity details" : "Show activity details"} onPress={() => setExpanded((value) => !value)}>
							{expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
						</Button>
					) : null}
				</div>
			</div>
			{expanded && hasDetails ? (
				<pre className="ml-11 mt-2 max-h-56 overflow-auto rounded-md bg-surface-secondary/45 px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
					{JSON.stringify(details, null, 2)}
				</pre>
			) : null}
		</div>
	);
}

export function BrainActivityLog({
	activity,
	connected,
	loading,
	loadingOlder,
	hasMore,
	onLoadOlder,
	onNavigate,
}: {
	activity: ActivityEntry[];
	connected: boolean;
	loading: boolean;
	loadingOlder: boolean;
	hasMore: boolean;
	onLoadOlder: () => Promise<void>;
	onNavigate?: (pathname: string, search?: string) => void;
}) {
	const [category, setCategory] = useState<BrainActivityCategory | "all">("all");
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const initializedRef = useRef(false);
	const pinnedToBottomRef = useRef(true);
	const loadingOlderRef = useRef(false);
	const latestId = activity.at(-1)?.id;
	const items = activity.map(formatBrainActivity).filter((item) => category === "all" || item.category === category);

	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!element || loading || initializedRef.current || activity.length === 0) return;
		element.scrollTop = element.scrollHeight;
		initializedRef.current = true;
	}, [activity.length, loading]);

	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!element || !initializedRef.current || !pinnedToBottomRef.current) return;
		element.scrollTop = element.scrollHeight;
	}, [latestId]);

	useEffect(() => {
		if (!loadingOlder) loadingOlderRef.current = false;
	}, [loadingOlder]);

	const loadOlder = async () => {
		const element = scrollRef.current;
		if (!element || loadingOlderRef.current || loadingOlder || !hasMore) return;
		loadingOlderRef.current = true;
		const viewportTop = element.getBoundingClientRect().top;
		const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-activity-id]"))
			.find((row) => row.getBoundingClientRect().bottom >= viewportTop);
		const anchorId = anchor?.dataset.activityId;
		const anchorOffset = anchor ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top : 0;
		await onLoadOlder();
		requestAnimationFrame(() => {
			const current = scrollRef.current;
			if (!current || !anchorId) return;
			const restoredAnchor = Array.from(current.querySelectorAll<HTMLElement>("[data-activity-id]"))
				.find((row) => row.dataset.activityId === anchorId);
			if (restoredAnchor) {
				const restoredOffset = restoredAnchor.getBoundingClientRect().top - current.getBoundingClientRect().top;
				current.scrollTop += restoredOffset - anchorOffset;
			}
		});
	};

	const handleScroll = () => {
		const element = scrollRef.current;
		if (!element) return;
		pinnedToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
		if (element.scrollTop < 80) void loadOlder();
	};

	return (
		<section className="overflow-hidden rounded-md border border-border bg-card">
			<div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<div className="flex items-center gap-2">
						<h2 className="text-sm font-semibold tracking-tight">Brain Activity</h2>
						<span className={cn("h-2 w-2 rounded-full", connected ? "bg-success" : "bg-default-400")} />
						<span className="text-xs text-muted-foreground">{connected ? "Live" : "Reconnecting"}</span>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">Older activity loads when you reach the top. New activity appends below.</p>
				</div>
				<div className="flex flex-wrap gap-1">
					{(Object.keys(CATEGORY_LABELS) as Array<BrainActivityCategory | "all">).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => setCategory(value)}
							className={cn("rounded-md px-2 py-1 text-xs transition-colors", category === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-surface-secondary hover:text-foreground")}
						>
							{CATEGORY_LABELS[value]}
						</button>
					))}
				</div>
			</div>

			<div ref={scrollRef} onScroll={handleScroll} className="h-[34rem] overflow-y-auto overscroll-contain">
				{loading ? (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading activity…</div>
				) : activity.length === 0 ? (
					<div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">No Brain activity has been recorded yet.</div>
				) : (
					<>
						<div className="flex min-h-10 items-center justify-center border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
							{loadingOlder ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading older activity…</> : hasMore ? "Scroll up to load older activity" : "Beginning of retained activity"}
						</div>
						{items.map((item) => <ActivityRow key={item.id} item={item} onNavigate={onNavigate} />)}
						{items.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">No activity matches this filter.</div> : null}
					</>
				)}
			</div>
		</section>
	);
}
