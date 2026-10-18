/**
 * Runtime-light row-formatting tokens shared by sheet renderers and controls.
 *
 * Keeping normalization separate from the React toolbar prevents experimental
 * grid chunks from pulling HeroUI and icon code merely to interpret persisted
 * color names.
 */

export const ROW_COLOR_OPTIONS = [
	{ key: "slate", label: "Default", className: "bg-surface" },
	{ key: "blue", label: "Blue", className: "bg-blue-400" },
	{ key: "green", label: "Green", className: "bg-green-400" },
	{ key: "orange", label: "Orange", className: "bg-orange-400" },
	{ key: "purple", label: "Purple", className: "bg-violet-400" },
] as const;

export type RowColor = (typeof ROW_COLOR_OPTIONS)[number]["key"];

const LEGACY_ROW_COLORS: Record<string, RowColor> = {
	emerald: "green",
	amber: "orange",
	rose: "purple",
};
const ROW_COLOR_KEYS = new Set<string>(
	ROW_COLOR_OPTIONS.map((option) => option.key),
);

export interface RowFormattingValue {
	bold: boolean;
	color: RowColor;
}

export function normalizeRowColor(value: string | undefined): RowColor {
	if (value === undefined) return "slate";
	if (ROW_COLOR_KEYS.has(value)) return value as RowColor;
	return LEGACY_ROW_COLORS[value] ?? "slate";
}
