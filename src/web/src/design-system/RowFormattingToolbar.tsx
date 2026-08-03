/**
 * Compact formatting controls for a selected spreadsheet resource.
 *
 * The component is intentionally domain-neutral: Task and Bug projections own
 * persistence while this toolbar presents the shared bold and row-color
 * interaction language.
 */

import { Button } from "@heroui/react";
import { Bold } from "lucide-react";

import { cn } from "@/lib";

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

export function RowFormattingToolbar({
	label,
	value,
	onChange,
}: {
	label: string;
	value: RowFormattingValue;
	onChange: (updates: Partial<RowFormattingValue>) => void;
}) {
	return (
		<div
			role="toolbar"
			aria-label="Format selected row"
			className="flex min-w-0 items-center gap-2"
		>
			<span className="shrink-0 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
				Selected
			</span>
			<span className="max-w-48 truncate text-xs text-foreground" title={label}>
				{label}
			</span>
			<div className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
			<Button
				size="sm"
				variant={value.bold ? "secondary" : "ghost"}
				aria-pressed={value.bold}
				onPress={() => onChange({ bold: !value.bold })}
				className="h-7 min-w-0 gap-1.5 px-2"
			>
				<Bold className="h-3.5 w-3.5" />
				Bold
			</Button>
			<div className="flex items-center gap-1" role="group" aria-label="Row color">
				{ROW_COLOR_OPTIONS.map((option) => (
					<button
						key={option.key}
						type="button"
						aria-label={`Use ${option.label.toLowerCase()} row color`}
						aria-pressed={value.color === option.key}
						title={option.label}
						onClick={() => onChange({ color: option.key })}
						className={cn(
							"h-4.5 w-4.5 touch-manipulation rounded-full border border-white/25 shadow-sm transition-transform motion-reduce:transition-none",
							option.className,
							"hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
							value.color === option.key &&
								"scale-110 ring-2 ring-accent ring-offset-1 ring-offset-background",
						)}
					/>
				))}
			</div>
		</div>
	);
}
