import { ArrowDown, ArrowUp, ArrowUpDown, Check, Filter } from "lucide-react";
import { Dropdown, Label, type Selection } from "@heroui/react";
import type { Column } from "@tanstack/react-table";
import { cn } from "@/lib";

export interface GridFilterOption {
	value: string;
	label: string;
	count?: number;
}

interface SortableGridHeaderProps<TData> {
	label: string;
	column: Column<TData, unknown>;
	className?: string;
}

export function SortableGridHeader<TData>({
	label,
	column,
	className,
}: SortableGridHeaderProps<TData>) {
	const sorted = column.getIsSorted();
	const nextSort = column.getNextSortingOrder();
	const SortIcon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;

	return (
		<button
			type="button"
			onClick={column.getToggleSortingHandler()}
			className={cn(
				"flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
				sorted && "text-accent",
				className,
			)}
			aria-label={`${label}: ${sorted ? `sorted ${sorted}` : "not sorted"}. Click to ${nextSort ? `sort ${nextSort}` : "clear sorting"}.`}
		>
			<span className="truncate">{label}</span>
			<SortIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
		</button>
	);
}

interface FilterableGridHeaderProps<TData> {
	label: string;
	column: Column<TData, unknown>;
	options: GridFilterOption[];
	className?: string;
}

export function FilterableGridHeader<TData>({
	label,
	column,
	options,
	className,
}: FilterableGridHeaderProps<TData>) {
	const selectedValues = (column.getFilterValue() as string[] | undefined) ?? [];
	const selectedKeys = new Set(selectedValues);

	const handleSelectionChange = (selection: Selection) => {
		const values = selection === "all"
			? options.map((option) => option.value)
			: Array.from(selection, String);
		column.setFilterValue(values.length > 0 ? values : undefined);
	};

	return (
		<Dropdown>
			<Dropdown.Trigger
				className={cn(
					"flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
					selectedValues.length > 0 && "bg-accent/10 text-accent",
					className,
				)}
				aria-label={`Filter ${label}${selectedValues.length > 0 ? `, ${selectedValues.length} selected` : ""}`}
			>
				<span className="truncate">{label}</span>
				{selectedValues.length > 0 ? (
					<span className="ml-auto rounded bg-accent/15 px-1.5 py-0.5 text-[0.62rem] tabular-nums text-accent">
						{selectedValues.length}
					</span>
				) : null}
				<Filter className="h-3 w-3 shrink-0" aria-hidden="true" />
			</Dropdown.Trigger>
			<Dropdown.Popover placement="bottom start" className="min-w-56">
				<div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
					<span className="text-xs font-medium text-foreground">Filter by {label.toLowerCase()}</span>
					<button
						type="button"
						onClick={() => column.setFilterValue(undefined)}
						disabled={selectedValues.length === 0}
						className="rounded px-1.5 py-1 text-xs font-normal text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground disabled:opacity-40"
					>
						Clear
					</button>
				</div>
				<Dropdown.Menu
					selectionMode="multiple"
					selectedKeys={selectedKeys}
					onSelectionChange={handleSelectionChange}
				>
					{options.map((option) => (
						<Dropdown.Item
							key={option.value}
							id={option.value}
							textValue={option.label}
							className="grid-metadata-option"
						>
							<Dropdown.ItemIndicator>
								{({ isSelected }) => isSelected ? <Check className="h-3.5 w-3.5" /> : null}
							</Dropdown.ItemIndicator>
							<Label>{option.label}</Label>
							{option.count !== undefined ? (
								<span className="ml-auto text-xs tabular-nums text-muted-foreground">
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
