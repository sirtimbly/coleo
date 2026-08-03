/**
 * Reusable compact controls used by configurable projections.
 */

import type { ChangeEvent, ReactNode } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@heroui/react";

import { cn } from "@/lib";

export function ProjectionSearch({
	value,
	onChange,
	placeholder = "Search this view",
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
