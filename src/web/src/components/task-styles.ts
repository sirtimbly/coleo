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
	pending: "Pending",
	claimed: "Claimed",
	in_progress: "In Progress",
	completed: "Completed",
	blocked: "Blocked",
	failed: "Failed",
	cancelled: "Cancelled",
};
