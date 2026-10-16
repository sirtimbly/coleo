import type { SortingState } from '@tanstack/react-table';
import type { Discovery } from "@/lib/api";

export const DISCOVERY_GRID_KINDS = [
	"test_failure",
	"unused_code",
	"security_issue",
	"performance",
	"pattern",
	"missing_context",
	"ambiguous_requirement",
	"potential_blocker",
	"related_code",
	"suggested_approach",
	"other",
] as const;

export const DISCOVERY_GRID_STATUSES = [
	"open",
	"acknowledged",
	"resolved",
	"dismissed",
] as const;

export const DISCOVERY_GRID_SEVERITIES = ["info", "warning", "error"] as const;

export const DISCOVERY_STATUS_STYLES: Record<string, string> = {
	open: "bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-900",
	acknowledged: "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900",
	resolved: "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900",
	dismissed: "bg-default-100 text-muted-foreground border-default-200 dark:bg-default-900 dark:border-default-700",
};

export const DISCOVERY_SEVERITY_STYLES: Record<string, string> = {
	info: "bg-sky-50 text-sky-700 border-sky-100 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-900",
	warning: "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900",
	error: "bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-900",
};

export const DISCOVERY_KIND_STYLES: Record<string, { bg: string; text: string; border: string }> = {
	test_failure: {
		bg: "bg-violet-50 dark:bg-violet-950/30",
		text: "text-violet-700 dark:text-violet-400",
		border: "border-violet-100 dark:border-violet-900",
	},
	unused_code: {
		bg: "bg-zinc-50 dark:bg-zinc-950/30",
		text: "text-zinc-700 dark:text-zinc-400",
		border: "border-zinc-100 dark:border-zinc-800",
	},
	security_issue: {
		bg: "bg-red-50 dark:bg-red-950/30",
		text: "text-red-700 dark:text-red-400",
		border: "border-red-100 dark:border-red-900",
	},
	performance: {
		bg: "bg-orange-50 dark:bg-orange-950/30",
		text: "text-orange-700 dark:text-orange-400",
		border: "border-orange-100 dark:border-orange-900",
	},
	pattern: {
		bg: "bg-blue-50 dark:bg-blue-950/30",
		text: "text-blue-700 dark:text-blue-400",
		border: "border-blue-100 dark:border-blue-900",
	},
	missing_context: {
		bg: "bg-amber-50 dark:bg-amber-950/30",
		text: "text-amber-700 dark:text-amber-400",
		border: "border-amber-100 dark:border-amber-900",
	},
	ambiguous_requirement: {
		bg: "bg-pink-50 dark:bg-pink-950/30",
		text: "text-pink-700 dark:text-pink-400",
		border: "border-pink-100 dark:border-pink-900",
	},
	potential_blocker: {
		bg: "bg-red-50 dark:bg-red-950/30",
		text: "text-red-700 dark:text-red-400",
		border: "border-red-100 dark:border-red-900",
	},
	related_code: {
		bg: "bg-emerald-50 dark:bg-emerald-950/30",
		text: "text-emerald-700 dark:text-emerald-400",
		border: "border-emerald-100 dark:border-emerald-900",
	},
	suggested_approach: {
		bg: "bg-cyan-50 dark:bg-cyan-950/30",
		text: "text-cyan-700 dark:text-cyan-400",
		border: "border-cyan-100 dark:border-cyan-900",
	},
	other: {
		bg: "bg-default-100 dark:bg-default-950/30",
		text: "text-default-700 dark:text-default-400",
		border: "border-default-200 dark:border-default-800",
	},
};

export function getDiscoveryKindClass(value: Discovery["kind"] | string) {
	return DISCOVERY_KIND_STYLES[value as keyof typeof DISCOVERY_KIND_STYLES] ?? DISCOVERY_KIND_STYLES.other;
}

export function getDiscoveryStatusClass(value: Discovery["status"] | string) {
	return DISCOVERY_STATUS_STYLES[value as keyof typeof DISCOVERY_STATUS_STYLES] ?? DISCOVERY_STATUS_STYLES.open;
}

export function getDiscoverySeverityClass(value: Discovery["severity"] | string) {
	return DISCOVERY_SEVERITY_STYLES[value as keyof typeof DISCOVERY_SEVERITY_STYLES] ?? DISCOVERY_SEVERITY_STYLES.info;
}

export const DISCOVERY_GRID_COLUMN_IDS = new Set(['order', 'title', 'createdAt', 'kind', 'severity', 'status']);
export const DISCOVERY_GRID_DEFAULT_SORTING: SortingState = [{ id: 'createdAt', desc: true }];
export const DISCOVERY_GRID_PREFERENCES_KEY = 'coleo:discoveries-grid-preferences';
export const DISCOVERY_GRID_COLUMNS_CLASS = "grid-cols-[48px_24px_minmax(16rem,1fr)_100px_100px_110px_90px_48px]";
