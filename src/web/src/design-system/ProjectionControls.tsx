/**
 * Reusable compact controls used by configurable projections.
 */

import type { ChangeEvent, ReactNode } from "react";
import type { Selection } from "@heroui/react";
import { Button, Dropdown, Label } from "@heroui/react";
import { ChevronDown, ListFilter, Search, SlidersHorizontal } from "lucide-react";

import { cn } from "@/lib";

export interface ProjectionFilterOption {
	id: string;
	label: string;
	count?: number;
}

export function ProjectionMenuTrigger({
	label = "View",
	summary,
	count,
	onPress,
	ariaLabel,
	className,
}: {
	label?: string;
	summary: string;
	count?: number;
	onPress?: () => void;
	ariaLabel?: string;
	className?: string;
}) {
	return (
		<Button
			size="sm"
			variant="secondary"
			data-projection-menu-trigger
			onPress={onPress}
			aria-label={ariaLabel ?? `${label}: ${summary}`}
			className={cn(
				"h-8 min-h-8 min-w-0 max-w-56 gap-1.5 border border-border bg-surface px-2.5 text-xs shadow-none",
				className,
			)}
		>
			<ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate font-semibold text-foreground">{summary}</span>
			{count !== undefined ? (
				<span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
			) : null}
			<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		</Button>
	);
}

export function ProjectionFilterMenu({
	label,
	value,
	options,
	onChange,
	className,
}: {
	label: string;
	value: string;
	options: readonly ProjectionFilterOption[];
	onChange: (value: string) => void;
	className?: string;
}) {
	const selected = options.find((option) => option.id === value) ?? options[0];
	const handleSelectionChange = (selection: Selection) => {
		if (selection === "all") return;
		const [next] = selection;
		if (typeof next === "string" && options.some((option) => option.id === next)) {
			onChange(next);
		}
	};

	if (!selected) return null;

	return (
		<Dropdown>
			<ProjectionMenuTrigger
				label={label}
				summary={selected.label}
				count={selected.count}
				ariaLabel={`Filter ${label}: ${selected.label}`}
				className={className}
			/>
			<Dropdown.Popover placement="bottom start" className="min-w-56">
				<Dropdown.Menu
					selectionMode="single"
					selectedKeys={[value]}
					onSelectionChange={handleSelectionChange}
				>
					{options.map((option) => (
						<Dropdown.Item key={option.id} id={option.id} textValue={option.label}>
							<Dropdown.ItemIndicator />
							<Label className="min-w-0 flex-1 truncate">{option.label}</Label>
							{option.count !== undefined ? (
								<span className="ml-auto tabular-nums text-xs text-muted-foreground">
									{option.count}
								</span>
							) : null}
						</Dropdown.Item>
					))}
				</Dropdown.Menu>
			</Dropdown.Popover>
		</Dropdown>
	);
}

export function ProjectionSearch({
	value,
	onChange,
	placeholder = "Search this view…",
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}) {
	const handleChange = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value);
	return (
		<label className={cn("relative block min-w-48 flex-1", className)}>
			<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			<input
				type="search"
				name="projection-search"
				aria-label={placeholder.replace(/…$/, "")}
				autoComplete="off"
				value={value}
				onChange={handleChange}
				placeholder={placeholder}
				className="h-8 w-full border border-border bg-surface pl-8 pr-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-1 focus:ring-accent/30"
			/>
		</label>
	);
}

export function ConfigureViewButton({
	onPress,
	label = "Configure view",
}: {
	onPress: () => void;
	label?: string;
}) {
	return (
		<Button size="sm" variant="ghost" onPress={onPress} aria-label={label}>
			<SlidersHorizontal className="h-3.5 w-3.5" />
			<span className="hidden sm:inline">{label}</span>
		</Button>
	);
}

export function ProjectionControlGroup({ children }: { children: ReactNode }) {
	return <div className="flex items-center gap-1 border-l border-border pl-2">{children}</div>;
}
