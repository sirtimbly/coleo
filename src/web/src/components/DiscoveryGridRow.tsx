import { memo } from "react";
import { GripVertical, Trash2, ChevronRight, ChevronDown, Info } from "lucide-react";
import { Dropdown, Button } from "@heroui/react";
import { type Discovery as ApiDiscovery } from "@/lib/api";
import { cn } from "@/lib";

export interface DiscoveryUiMeta {
	tags?: string[];
	color?: string;
	bold?: boolean;
}

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
	dragHandleProps?: Record<string, unknown>;
	className?: string;
}

const STATUS_OPTIONS = ["open", "acknowledged", "resolved", "dismissed"] as const;

const STATUS_STYLES: Record<string, string> = {
	open: "bg-red-50 text-red-700 border-red-100",
	acknowledged: "bg-blue-50 text-blue-700 border-blue-100",
	resolved: "bg-green-50 text-green-700 border-green-100",
	dismissed: "bg-gray-50 text-gray-700 border-gray-100",
};

const SEVERITY_STYLES: Record<string, string> = {
	info: "bg-sky-50 text-sky-700 border-sky-100",
	warning: "bg-amber-50 text-amber-700 border-amber-100",
	error: "bg-red-50 text-red-700 border-red-100",
};

const KIND_STYLES: Record<string, { bg: string; text: string; border: string }> = {
	test_failure: { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-100" },
	unused_code: { bg: "bg-gray-50", text: "text-gray-700", border: "border-gray-100" },
	security_issue: { bg: "bg-red-50", text: "text-red-700", border: "border-red-100" },
	performance: { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-100" },
	pattern: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-100" },
	missing_context: { bg: "bg-yellow-50", text: "text-yellow-700", border: "border-yellow-100" },
	ambiguous_requirement: { bg: "bg-pink-50", text: "text-pink-700", border: "border-pink-100" },
	potential_blocker: { bg: "bg-red-50", text: "text-red-700", border: "border-red-100" },
	related_code: { bg: "bg-green-50", text: "text-green-700", border: "border-green-100" },
	suggested_approach: { bg: "bg-cyan-50", text: "text-cyan-700", border: "border-cyan-100" },
	other: { bg: "bg-default-50", text: "text-default-700", border: "border-default-100" },
};

export const DiscoveryGridRow = memo(function DiscoveryGridRow({
	discovery,
	index,
	isSelected,
	isDragging,
	onOpenDetails,
	onUpdateDiscovery,
	onDelete,
	dragHandleProps,
	className,
}: DiscoveryGridRowProps) {
	const displayRowNumber = index + 1;
	const uiMeta = { tags: [], color: "slate", bold: false };

	const statusClasses = STATUS_STYLES[discovery.status] || STATUS_STYLES.open;
	const severityClasses = SEVERITY_STYLES[discovery.severity] || SEVERITY_STYLES.info;
	const kindClasses = KIND_STYLES[discovery.kind] || KIND_STYLES.other;

	const handleRowClick = (event: React.MouseEvent<HTMLLIElement>) => {
		const target = event.target as HTMLElement;
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

	const handleKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			onOpenDetails?.(discovery);
		}
	};

	return (
		<li
			className={cn(
				"grid grid-cols-[48px_24px_minmax(0,1fr)_80px_80px_80px_100px_48px] -translate-y-1 items-center gap-3 px-3 py-1 text-sm border-l-2 transition-all cursor-pointer",
				"rounded-md bg-white border border-gray-200",
				isSelected && "bg-accent border-l-accent",
				isDragging && "opacity-40 bg-gray-100 border-dashed",
				className,
			)}
			onClick={handleRowClick}
			onKeyDown={handleKeyDown}
		>
			{/* Row number */}
			<div className="text-xs text-muted-foreground font-mono text-right pr-1">
				{displayRowNumber}
			</div>

			{/* Drag handle */}
			<div
				className="p-1 text-default-500 hover:text-default-700 rounded cursor-move"
				{...dragHandleProps}
				data-cell
				data-row={index}
				data-col={0}
			>
				<GripVertical className="h-4 w-4" />
			</div>

			{/* Title */}
			<div className="min-w-0 truncate" data-cell data-row={index} data-col={1}>
				<span className={uiMeta.bold ? "font-semibold" : ""}>{discovery.title}</span>
			</div>

			{/* Kind */}
			<div
				className={cn(
					"flex items-center justify-center min-w-[60px] rounded-full border px-2 py-0.5 text-xs font-medium",
					kindClasses.bg,
					kindClasses.text,
					kindClasses.border,
				)}
				data-cell
				data-row={index}
				data-col={2}
			>
				<span className="capitalize">{discovery.kind.replace(/_/g, " ")}</span>
			</div>

			{/* Severity */}
			<div
				className={cn(
					"flex items-center justify-center min-w-[60px] rounded-full border px-2 py-0.5 text-xs font-medium",
					severityClasses,
				)}
				data-cell
				data-row={index}
				data-col={3}
			>
				<Info className="h-3 w-3 mr-1" />
				<span className="capitalize">{discovery.severity}</span>
			</div>

			{/* Status dropdown */}
			<Dropdown>
				<Dropdown.Trigger>
					<div
						className={cn(
							"flex items-center justify-between min-w-[70px] rounded-full border px-2 py-0.5 text-xs font-semibold transition cursor-pointer select-none",
							"hover:shadow-sm",
							statusClasses,
						)}
						data-cell
						data-row={index}
						data-col={4}
					>
						<span className="capitalize">{discovery.status.replace(/_/g, " ")}</span>
						<ChevronDown className="h-3 w-3 opacity-50" />
					</div>
				</Dropdown.Trigger>
				<Dropdown.Popover>
					<Dropdown.Menu
						onAction={(key) => onUpdateDiscovery?.(discovery.id, { status: key as string })}
					>
						{STATUS_OPTIONS.map((status) => (
							<Dropdown.Item key={status}>{status.replace(/_/g, " ")}</Dropdown.Item>
						))}
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>

			{/* Actions */}
			<div className="flex items-center gap-1" data-cell data-row={index} data-col={5}>
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
			</div>

			{/* Open details */}
			<Button
				variant="ghost"
				size="sm"
				isIconOnly
				onPress={() => onOpenDetails?.(discovery)}
				className="h-6 w-6"
				data-cell
				data-row={index}
				data-col={6}
				aria-label="Open details"
			>
				<ChevronRight className="h-4 w-4 text-accent-700" />
			</Button>
		</li>
	);
});