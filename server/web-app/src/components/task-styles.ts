import type { Task } from "@/lib/api";

export const PRIORITY_OPTIONS: Task["priority"][] = [
	"low",
	"normal",
	"high",
	"critical",
];

export const PRIORITY_STYLES: Record<Task["priority"], string> = {
	low: "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900",
	normal: "bg-sky-50 text-sky-700 border-sky-100 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-900",
	high: "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900",
	critical: "bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-900",
};

export const STATUS_LABELS: Record<Task["status"], string> = {
	draft: "Draft",
	pending: "Pending",
	claimed: "Claimed",
	in_progress: "In Progress",
	completing: "Completing",
	completed: "Completed",
	blocked: "Blocked",
	failed: "Failed",
	cancelled: "Cancelled",
};

export const STATUS_DOT_STYLES: Record<Task["status"], string> = {
	draft: "bg-cyan-500",
	pending: "bg-slate-500",
	claimed: "bg-sky-500",
	in_progress: "bg-blue-500",
	completing: "bg-violet-500",
	completed: "bg-emerald-500",
	blocked: "bg-amber-500",
	failed: "bg-rose-500",
	cancelled: "bg-slate-500",
};

export const PRIORITY_DOT_STYLES: Record<Task["priority"], string> = {
	low: "bg-emerald-500",
	normal: "bg-sky-500",
	high: "bg-amber-500",
	critical: "bg-rose-500",
};
