import { type KeyboardEvent, type MouseEvent, memo } from "react";
import { ChevronDown, ChevronRight, GripVertical, Info, Trash2 } from "lucide-react";
import { Button, Dropdown } from "@heroui/react";
import type { Discovery as ApiDiscovery, UiMetadata } from "@/lib";
import { cn } from "@/lib";
import { formatGridDate } from "./grid-table";
import {
	DISCOVERY_GRID_COLUMNS_CLASS,
	DISCOVERY_GRID_STATUSES,
	getDiscoveryKindClass,
	getDiscoverySeverityClass,
	getDiscoveryStatusClass,
} from "./discovery-styles";

export type DiscoveryUiMeta = UiMetadata;

export type DiscoveryUpdate = {
	status: string;
};

interface DiscoveryGridRowProps {
	discovery: ApiDiscovery;
	index: number;
	isSelected?: boolean;
	isDragging?: boolean;
	onOpenDetails?: (discovery: ApiDiscovery) => void;
	onUpdateDiscovery?: (discoveryId: string, updates: DiscoveryUpdate) => void;
	onDelete?: (discoveryId: string) => void;
	className?: string;
}

function labelGridValue(value: string) {
	return value.replace(/_/g, " ");
}

export const DiscoveryGridRow = memo(function DiscoveryGridRow({
	discovery,
	index,
	isSelected,
	isDragging,
	onOpenDetails,
	onUpdateDiscovery,
	onDelete,
	className,
}: DiscoveryGridRowProps) {
	const displayRowNumber = index + 1;
	const uiMeta: UiMetadata = { tags: [], color: "slate", bold: false };

	const statusClasses = getDiscoveryStatusClass(discovery.status);
	const severityClasses = getDiscoverySeverityClass(discovery.severity);
	const kindClasses = getDiscoveryKindClass(discovery.kind);

	const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
		if (!(event.target instanceof HTMLElement)) {
			return;
		}

		const target = event.target;
		if (
			target.closest("button") ||
			target.closest("input") ||
			target.closest('[role="menu"]') ||
			target.closest("[data-slot]")
		) {
			return;
		}

		onOpenDetails?.(discovery);
	};

	const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			onOpenDetails?.(discovery);
		}
	};

	return (
		<div
			className={cn(
				"grid h-11 items-center gap-2 px-3 text-xs sm:text-sm border-b border-border transition-colors cursor-pointer",
				DISCOVERY_GRID_COLUMNS_CLASS,
				"hover:bg-content2/60",
				isSelected && "bg-accent/10",
				isDragging && "opacity-40 bg-gray-100 border-dashed",
				className,
			)}
			onClick={handleRowClick}
			onKeyDown={handleRowKeyDown}
			role="row"
			tabIndex={0}
		>
			<div className="text-xs text-muted-foreground font-mono text-right pr-1" data-cell data-row={index} data-col={0}>
				{displayRowNumber}
			</div>

			<div className="p-1 text-default-500 hover:text-default-700 rounded cursor-move" data-cell data-row={index} data-col={1}>
				<GripVertical className="h-4 w-4" />
			</div>

			<div className="min-w-0 truncate leading-5" data-cell data-row={index} data-col={2}>
				<div className={uiMeta.bold ? "font-semibold" : ""}>{discovery.title}</div>
				<div className="truncate text-[11px] text-muted-foreground">{discovery.details}</div>
			</div>

			<div
				className={cn(
					"flex items-center justify-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
					kindClasses.bg,
					kindClasses.text,
					kindClasses.border,
				)}
				data-cell
				data-row={index}
				data-col={3}
			>
				<span className="capitalize">{labelGridValue(discovery.kind)}</span>
			</div>

			<div
				className={cn(
					"flex items-center justify-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
					severityClasses,
				)}
				data-cell
				data-row={index}
				data-col={4}
			>
				<Info className="h-3 w-3 mr-1" />
				<span className="capitalize">{discovery.severity}</span>
			</div>

			<Dropdown>
				<Dropdown.Trigger>
					<div
						className={cn(
							"flex items-center justify-between rounded-full border px-2 py-0.5 text-[11px] font-semibold transition cursor-pointer select-none hover:shadow-sm",
							statusClasses,
						)}
						data-cell
						data-row={index}
						data-col={5}
					>
						<span className="capitalize">{labelGridValue(discovery.status)}</span>
						<ChevronDown className="h-3 w-3 opacity-50" />
					</div>
				</Dropdown.Trigger>
				<Dropdown.Popover>
					<Dropdown.Menu
						onAction={(key) => {
							if (typeof key === "string" || typeof key === "number") {
								onUpdateDiscovery?.(discovery.id, { status: String(key) });
							}
						}}
					>
						{DISCOVERY_GRID_STATUSES.map((status) => (
							<Dropdown.Item key={status}>{labelGridValue(status)}</Dropdown.Item>
						))}
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>

			<div className="truncate text-xs text-muted-foreground" data-cell data-row={index} data-col={6}>
				{formatGridDate(discovery.createdAt)}
			</div>

			<div className="flex items-center gap-1" data-cell data-row={index} data-col={7}>
				<Button
					variant="ghost"
					size="sm"
					isIconOnly
					onPress={() => onDelete?.(discovery.id)}
					className="h-6 w-6"
					aria-label="Delete discovery"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</Button>

				<Button
					variant="ghost"
					size="sm"
					isIconOnly
					onPress={() => onOpenDetails?.(discovery)}
					className="h-6 w-6"
					aria-label="Open details"
				>
					<ChevronRight className="h-4 w-4 text-accent-700" />
				</Button>
			</div>
		</div>
	);
});
