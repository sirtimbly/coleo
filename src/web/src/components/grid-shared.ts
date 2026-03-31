import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";

export const COLOR_OPTIONS = ["slate", "blue", "emerald", "amber", "rose"] as const;
export type ColorOption = (typeof COLOR_OPTIONS)[number];

export const COLOR_CLASSES: Record<
	ColorOption,
	{ dot: string; row: string; rowBold: string }
> = {
	slate: {
		dot: "bg-slate-400",
		row: "bg-slate-900/30 border-slate-700 border-l-slate-500",
		rowBold: "bg-slate-800/50 border-slate-500 border-l-slate-400 border-2",
	},
	blue: {
		dot: "bg-blue-400",
		row: "bg-blue-900/30 border-blue-700 border-l-blue-500",
		rowBold: "bg-blue-800/50 border-blue-500 border-l-blue-400 border-2",
	},
	emerald: {
		dot: "bg-emerald-400",
		row: "bg-emerald-900/30 border-emerald-700 border-l-emerald-500",
		rowBold: "bg-emerald-800/50 border-emerald-500 border-l-emerald-400 border-2",
	},
	amber: {
		dot: "bg-amber-400",
		row: "bg-amber-900/30 border-amber-700 border-l-amber-500",
		rowBold: "bg-amber-800/50 border-amber-500 border-l-amber-400 border-2",
	},
	rose: {
		dot: "bg-rose-400",
		row: "bg-rose-900/30 border-rose-700 border-l-rose-500",
		rowBold: "bg-rose-800/50 border-rose-500 border-l-rose-400 border-2",
	},
};

export const COLOR_CLASSES_LIGHT: Record<
	ColorOption,
	{ dot: string; row: string; rowBold: string }
> = {
	slate: {
		dot: "bg-slate-400",
		row: "bg-slate-50 border-slate-200 border-l-slate-400 dark:bg-slate-950/30 dark:border-slate-800 dark:border-l-slate-600",
		rowBold: "bg-slate-100 border-slate-400 border-l-slate-600 border-2 dark:bg-slate-900/50 dark:border-slate-600 dark:border-l-slate-400",
	},
	blue: {
		dot: "bg-blue-400",
		row: "bg-blue-50 border-blue-200 border-l-blue-400 dark:bg-blue-950/30 dark:border-blue-800 dark:border-l-blue-600",
		rowBold: "bg-blue-100 border-blue-400 border-l-blue-600 border-2 dark:bg-blue-900/50 dark:border-blue-600 dark:border-l-blue-400",
	},
	emerald: {
		dot: "bg-emerald-400",
		row: "bg-emerald-50 border-emerald-200 border-l-emerald-400 dark:bg-emerald-950/30 dark:border-emerald-800 dark:border-l-emerald-600",
		rowBold: "bg-emerald-100 border-emerald-400 border-l-emerald-600 border-2 dark:bg-emerald-900/50 dark:border-emerald-600 dark:border-l-emerald-400",
	},
	amber: {
		dot: "bg-amber-400",
		row: "bg-amber-50 border-amber-200 border-l-amber-400 dark:bg-amber-950/30 dark:border-amber-800 dark:border-l-amber-600",
		rowBold: "bg-amber-100 border-amber-400 border-l-amber-600 border-2 dark:bg-amber-900/50 dark:border-amber-600 dark:border-l-amber-400",
	},
	rose: {
		dot: "bg-rose-400",
		row: "bg-rose-50 border-rose-200 border-l-rose-400 dark:bg-rose-950/30 dark:border-rose-800 dark:border-l-rose-600",
		rowBold: "bg-rose-100 border-rose-400 border-l-rose-600 border-2 dark:bg-rose-900/50 dark:border-rose-600 dark:border-l-rose-400",
	},
};

export function getValidColor(color: string | undefined): ColorOption {
	return COLOR_OPTIONS.includes(color as ColorOption) ? (color as ColorOption) : "slate";
}

export interface TagHandlerProps {
	tags: string[];
	availableTags: string[];
	onUpdateTags: (tags: string[]) => void;
}

export function useTagHandlers({ tags, availableTags, onUpdateTags }: TagHandlerProps) {
	const [tagSearch, setTagSearch] = useState("");
	
	const filteredTags = useMemo(() => {
		const query = tagSearch.trim().toLowerCase();
		if (!query) return availableTags;
		return availableTags.filter((tag) => tag.toLowerCase().includes(query));
	}, [availableTags, tagSearch]);

	const handleTagSelection = (selectedTags: string[]) => {
		onUpdateTags(selectedTags);
	};

	const handleCreateTag = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		const existing = availableTags.find(
			(tag) => tag.toLowerCase() === trimmed.toLowerCase(),
		);
		const nextTag = existing ?? trimmed;
		if (!nextTag) return;
		const next = Array.from(new Set([...tags, nextTag]));
		onUpdateTags(next);
		setTagSearch("");
	};

	const handleTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			handleCreateTag(tagSearch);
			return;
		}
		if (event.key === "Escape") {
			setTagSearch("");
		}
	};

	return {
		tagSearch,
		setTagSearch,
		filteredTags,
		handleTagSelection,
		handleCreateTag,
		handleTagInputKeyDown,
	};
}

export function useRowClickHandler<T>(onOpenDetails?: (item: T) => void) {
	const handleRowClick = (event: React.MouseEvent<HTMLLIElement>, item: T) => {
		const target = event.target as HTMLElement;
		if (
			target.closest("button") ||
			target.closest("input") ||
			target.closest('[role="menu"]') ||
			target.closest("[data-slot]")
		) {
			return;
		}
		onOpenDetails?.(item);
	};

	const handleRowKeyDown = (event: React.KeyboardEvent<HTMLLIElement>, item: T) => {
		if (event.key === "Enter" && event.target === event.currentTarget) {
			onOpenDetails?.(item);
		}
	};

	return { handleRowClick, handleRowKeyDown };
}
