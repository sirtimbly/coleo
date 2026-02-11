import { useEffect, useMemo, useRef, useState, memo } from "react";
import type { KeyboardEvent } from "react";
import {
	Bold,
	GripVertical,
	MessageSquare,
	SlidersHorizontal,
	ChevronDown,
	ChevronRight,
	Trash2,
	ArrowUpDown,
	Check,
} from "lucide-react";
import { Chip, Button, Dropdown, Checkbox } from "@heroui/react";
import { type Task } from "@/lib/api";
import { ProgressBar } from "./ProgressBar";
import { cn } from "@/lib";

export interface TaskUiMeta {
	tags?: string[];
	color?: string;
	bold?: boolean;
}

export type TaskUpdate = Partial<{
	subject: string;
	description: string;
	status: Task["status"];
	priority: Task["priority"];
	domain: string;
	phase: string;
	assignedTo: string | null;
	dueDate: string | null;
	progress: number;
	artifacts: string[];
	metadata: Record<string, unknown>;
}>;

interface TaskGridRowProps {
	task: Task;
	index: number;
	availableTags?: string[];
	isSelected?: boolean;
	isDragging?: boolean;
	isExpanded?: boolean;
	onOpenDetails?: (task: Task) => void;
	onOpenDiscussions?: (task: Task) => void;
	onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
	onUpdateUi?: (taskId: string, updates: TaskUiMeta) => void;
	onDelete?: (task: Task) => void;
	onReorderToSortOrder?: (taskId: string, fromSortOrder: number, toSortOrder: number) => void;
	dragHandleProps?: Record<string, unknown>;
	onGridKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
	className?: string;
}

const PRIORITY_OPTIONS: Task["priority"][] = [
	"low",
	"normal",
	"high",
	"critical",
];

const PRIORITY_STYLES: Record<Task["priority"], string> = {
	low: "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900",
	normal: "bg-sky-50 text-sky-700 border-sky-100 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-900",
	high: "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900",
	critical: "bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-900",
};

const COLOR_OPTIONS = ["slate", "blue", "emerald", "amber", "rose"] as const;
type ColorOption = (typeof COLOR_OPTIONS)[number];

const COLOR_CLASSES: Record<
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

export const TaskGridRow = memo(function TaskGridRow({
	task,
	index,
	availableTags = [],
	isSelected,
	isDragging,
	isExpanded,
	onOpenDetails,
	onOpenDiscussions,
	onUpdateTask,
	onUpdateUi,
	onDelete,
	onReorderToSortOrder,
	dragHandleProps,
	onGridKeyDown,
	className,
}: TaskGridRowProps) {
	// Use sortOrder from database if available, otherwise fall back to index+1
	const displayRowNumber = task.sortOrder !== null && task.sortOrder !== undefined 
		? task.sortOrder + 1 
		: index + 1;
	const uiMeta = useMemo(() => {
		const meta = (task.metadata ?? {}) as Record<string, unknown>;
		const ui = (meta.ui ?? {}) as Record<string, unknown>;
		return {
			tags: Array.isArray(ui.tags) ? (ui.tags as string[]) : [],
			color: typeof ui.color === "string" ? (ui.color as string) : "slate",
			bold: Boolean(ui.bold),
		};
	}, [task.metadata]);
  const [open, setOpen] = useState(false);
	const [subjectValue, setSubjectValue] = useState(task.subject);
	const [tagSearch, setTagSearch] = useState("");
	const [previewColor, setPreviewColor] = useState<ColorOption | null>(null);
	const [isTagDropdownOpen, setIsTagDropdownOpen] = useState(false);
	const tagInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => setSubjectValue(task.subject), [task.subject]);

	useEffect(() => {
		if (isTagDropdownOpen) {
			// Delay focus to allow dropdown animation to complete and avoid focus conflicts
			const timer = setTimeout(() => {
				tagInputRef.current?.focus();
			}, 50);
			return () => clearTimeout(timer);
		}
	}, [isTagDropdownOpen]);

	const savedColor = COLOR_OPTIONS.includes(uiMeta.color as ColorOption)
		? (uiMeta.color as ColorOption)
		: "slate";

	// Use preview color if hovering, otherwise use saved color
	const colorKey = previewColor ?? savedColor;

	const priorityClasses = PRIORITY_STYLES[task.priority];

	const progress = task.progress ?? 0;
	const moveTopId = `move-top-${task.id}`;
	const moveBottomId = `move-bottom-${task.id}`;

	const handleSubjectBlur = () => {
		const next = subjectValue.trim();
		if (next && next !== task.subject) {
			onUpdateTask?.(task.id, { subject: next });
		} else {
			setSubjectValue(task.subject);
		}
	};

	const handleTagSelection = (tags: string[]) => {
		onUpdateUi?.(task.id, { tags });
	};

	const handleCreateTag = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		const existing = availableTags.find(
			(tag) => tag.toLowerCase() === trimmed.toLowerCase(),
		);
		const nextTag = existing ?? trimmed;
		if (!nextTag) return;
		const next = Array.from(new Set([...uiMeta.tags, nextTag]));
		onUpdateUi?.(task.id, { tags: next });
		setTagSearch("");
	};

	const filteredTags = useMemo(() => {
		const query = tagSearch.trim().toLowerCase();
		if (!query) return availableTags;
		return availableTags.filter((tag) => tag.toLowerCase().includes(query));
	}, [availableTags, tagSearch]);

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

	const handleRowClick = (event: React.MouseEvent<HTMLLIElement>) => {
		// Don't open details if clicking on interactive elements
		const target = event.target as HTMLElement;
		if (
			target.closest("button") ||
			target.closest("input") ||
			target.closest('[role="menu"]') ||
			target.closest("[data-slot]")
		) {
			return;
		}
		onOpenDetails?.(task);
	};

	const handleRowKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
		// Open details on Enter when the row background is focused (not child elements)
		if (event.key === "Enter" && event.target === event.currentTarget) {
			onOpenDetails?.(task);
		}
	};

  return (
    <li
      className={cn(
        "grid grid-cols-[48px_24px_minmax(0,1fr)_96px_120px_110px_160px_120px] -translate-y-1 items-center gap-3 px-3 py-1 text-sm transition-all cursor-pointer",
        "rounded-md ",
        // Base color from row color setting
        !isDragging &&
          (uiMeta.bold
            ? COLOR_CLASSES[colorKey]?.rowBold
            : COLOR_CLASSES[colorKey]?.row),
        // Hover state (only when not selected and not dragging)
        !isSelected &&
          !isDragging &&
          "hover:bg-accent/20 hover:border-accent",
        // Selected state - bright accent color with glow
        isSelected && "bg-accent shadow-md shadow-accent/20",
        // Dragging state - dim the original row
        isDragging &&
          "opacity-40 bg-default-100 border-dashed border-default-300",
        className,
      )}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
    >
		{/* Row number - based on database sortOrder */}
      <div className="text-xs text-muted-foreground font-mono text-right pr-1" title={`Database order: ${task.sortOrder ?? index}`}>
        {displayRowNumber}
      </div>
      <div
        className="p-1 text-default-500 hover:text-default-700 rounded cursor-move"
        {...dragHandleProps}
        data-cell
        data-row={index}
        data-col={0}
        title="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </div>

			{isExpanded ? (
				<textarea
					ref={(el) => {
						if (el) el.style.height = "auto";
						el?.style.setProperty("height", el?.scrollHeight + "px");
					}}
					value={subjectValue}
					onChange={(event) => setSubjectValue(event.target.value)}
					onBlur={handleSubjectBlur}
					onKeyDown={(event) => {
						onGridKeyDown?.(event);
						if (event.key === "Enter" && !event.shiftKey) {
							event.currentTarget.blur();
						}
					}}
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
					data-cell
					data-row={index}
					data-col={1}
					rows={1}
					className={cn(
						"min-w-0 bg-transparent border border-transparent rounded-md px-2 py-1 transition-all resize-none overflow-hidden",
						"hover:border-default-300 hover:bg-default-50",
						"focus:border-accent focus:bg-white focus:outline-none focus:ring-2 focus:ring-accent/20",
						uiMeta.bold && "font-semibold",
						"w-full",
					)}
					aria-label="Task subject (click to edit)"
					title="Click to edit task title"
					style={{ height: "auto", minHeight: "28px" }}
				/>
			) : (
				<input
					value={subjectValue}
					onChange={(event) => setSubjectValue(event.target.value)}
					onBlur={handleSubjectBlur}
					onKeyDown={(event) => {
						onGridKeyDown?.(event);
						if (event.key === "Enter") {
							event.currentTarget.blur();
						}
					}}
					data-cell
					data-row={index}
					data-col={1}
					className={cn(
						"min-w-0 bg-transparent border border-transparent rounded-md px-2 py-1 transition-all",
						"hover:border-default-300 hover:bg-default-50",
						"focus:border-accent focus:bg-white focus:outline-none focus:ring-2 focus:ring-accent/20",
						uiMeta.bold && "font-semibold",
					)}
					aria-label="Task subject (click to edit)"
					title="Click to edit task title"
				/>
			)}

			<div className="px-2 py-1 text-default-500 text-xs uppercase tracking-wide">
				<div className="flex flex-col gap-1">
					<span>{task.status.replace("_", " ")}</span>
					{task.assignedArmName && (task.status === 'in_progress' || task.status === 'claimed') && (
						<Chip size="sm" variant="soft" color="accent" className="text-xs">
							{task.assignedArmName}
						</Chip>
					)}
				</div>
			</div>

			{/* Progress bar */}
			<ProgressBar percent={progress} showLabel={false} size="sm" className="min-w-[120px]" />

			{/* Priority dropdown */}
			<Dropdown>
				<Dropdown.Trigger>
					<div
						className={cn(
							"flex items-center justify-between min-w-[96px] rounded-full border px-3 py-1 text-xs font-semibold transition cursor-pointer select-none",
							"hover:shadow-sm",
							priorityClasses,
						)}
						data-cell
						data-row={index}
						data-col={2}
					>
						<span className="capitalize">{task.priority}</span>
						<ChevronDown className="h-3 w-3 opacity-50" />
					</div>
				</Dropdown.Trigger>
				<Dropdown.Popover>
				<Dropdown.Menu
					onAction={(key) =>
						onUpdateTask?.(task.id, { priority: key as Task["priority"] })
					}
				>
					{PRIORITY_OPTIONS.map((priority) => (
						<Dropdown.Item
							key={priority}
							id={priority}
							textValue={priority}
							className="capitalize"
						>
							{priority}
						</Dropdown.Item>
					))}
				</Dropdown.Menu>
			</Dropdown.Popover>
		</Dropdown>

			{/* Tags dropdown */}
			<Dropdown onOpenChange={setIsTagDropdownOpen}>
				<Dropdown.Trigger>
					<div
						className="flex items-center justify-start min-w-32 px-3 py-1 text-sm cursor-pointer select-none hover:bg-default-100 rounded-md"
						data-cell
						data-row={index}
						data-col={3}
					>
						<div className="flex flex-wrap items-center gap-1 flex-1">
							{uiMeta.tags.length === 0 ? (
								<span className="text-xs text-default-400">tags</span>
							) : (
								uiMeta.tags.slice(0, 2).map((tag) => (
									<Chip key={tag} size="sm" variant="soft" className="text-xs">
										{tag}
									</Chip>
								))
							)}
							{uiMeta.tags.length > 2 && (
								<span className="text-xs text-default-400">
									+{uiMeta.tags.length - 2}
								</span>
							)}
						</div>
						<ChevronDown className="h-3 w-3 opacity-50 ml-1" />
					</div>
				</Dropdown.Trigger>
				<Dropdown.Popover className="min-w-64">
					<div className="px-2 py-2">
						<input
							ref={tagInputRef}
							value={tagSearch}
							onChange={(event) => setTagSearch(event.target.value)}
							onKeyDown={handleTagInputKeyDown}
							placeholder="Search or add tag (press Enter)"
							className="w-full h-8 rounded-lg border border-default-300 bg-default-100 px-3 text-sm text-default-700 placeholder:text-default-400 focus:border-primary focus:outline-none"
						/>
					</div>
					<div className="max-h-160 overflow-y-auto gap-2 grid grid-cols[120px_120px] p-2">
					{filteredTags.map((tag) => {
							const isSelected = uiMeta.tags.includes(tag);
							return (
								<Button
									key={tag}
									variant={isSelected ? "secondary" : "tertiary"}
									onClick={() => {
										const next = isSelected
											? uiMeta.tags.filter((t) => t !== tag)
											: [...uiMeta.tags, tag];
										handleTagSelection(next);
									}}
									className={cn(
										"w-64",
										isSelected
											? "bg-secondary-200 text-secondary-600"
											: "text-default-700"
									)}
								>
													{isSelected ? <Check className="h-4 w-4" /> : <Checkbox className="w-4 h-4" />}
													{tag}
								</Button>
							);
						})}
					</div>
				</Dropdown.Popover>
			</Dropdown>

			<div className="flex items-center justify-end gap-2">
				{/* Formatting dropdown */}
				<Dropdown>
					<Dropdown.Trigger>
						<div
							className="p-1 text-default-500 hover:text-default-700 rounded cursor-pointer"
							data-cell
							data-row={index}
							data-col={4}
							title="Formatting & appearance"
						>
							<SlidersHorizontal className="h-4 w-4" />
						</div>
					</Dropdown.Trigger>
					<Dropdown.Popover>
						<div className="p-2">
							{/* Bold toggle */}
							<button
								type="button"
								onClick={() => onUpdateUi?.(task.id, { bold: !uiMeta.bold })}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-default-100 transition-colors cursor-pointer"
							>
								<Bold className="h-3.5 w-3.5" />
								<span className="text-sm">
									{uiMeta.bold ? "Unbold row" : "Bold row"}
								</span>
							</button>

							{/* Color picker */}
							<div className="mt-2 px-2">
								<div className="text-[11px] uppercase tracking-wide text-default-500 mb-2">
									Row color
								</div>
								<div className="flex flex-wrap gap-2">
									{COLOR_OPTIONS.map((color) => (
										<button
											key={color}
											type="button"
											onClick={() => {
												onUpdateUi?.(task.id, { color });
												setPreviewColor(null);
											}}
											onMouseEnter={() => setPreviewColor(color)}
											onMouseLeave={() => setPreviewColor(null)}
											className={cn(
												"h-5 w-5 rounded-full border-2 transition-all cursor-pointer",
												COLOR_CLASSES[color].dot,
												savedColor === color
													? "border-accent ring-2 ring-accent/30 scale-110"
													: "border-white shadow-sm hover:scale-110 hover:shadow-md",
											)}
											title={`Set color to ${color}`}
										/>
									))}
								</div>
							</div>
						</div>
					</Dropdown.Popover>
				</Dropdown>

				{/* Comment count indicator */}
				{(task.commentCount ?? 0) > 0 && (
					<Button
						variant="ghost"
						size="sm"
						onPress={() => onOpenDiscussions?.(task)}
						aria-label={`${task.commentCount} comments`}
					>
						<MessageSquare className="h-4 w-4" />
						<Chip color="accent" size="sm" variant="soft">
							{task.commentCount}
						</Chip>
					</Button>
				)}

				<Button
					variant="ghost"
					size="sm"
					isIconOnly
					onPress={() => onDelete?.(task)}
					data-cell
					data-row={index}
					data-col={5}
					aria-label="Delete task"
				>
					<Trash2 className="h-4 w-4" />
				</Button>

        <Dropdown isOpen={open} onOpenChange={setOpen}>
          <Dropdown.Trigger>
            <div
              className="p-1 text-default-500 hover:text-default-700 rounded cursor-pointer"
              data-cell
              data-row={index}
              data-col={6}
              title="More actions"
            >
              <ArrowUpDown className="h-4 w-4" />
            </div>
          </Dropdown.Trigger>
          <Dropdown.Popover>
            <div className="p-2 min-w-[200px]">
				<Dropdown.Menu
					onAction={(key) => {
						const currentSortOrder = task.sortOrder ?? index;
						if (key === moveTopId) {
							onReorderToSortOrder?.(task.id, currentSortOrder, 0);
						} else if (key === moveBottomId) {
							onReorderToSortOrder?.(task.id, currentSortOrder, -1);
						}
					}}
				>
					<Dropdown.Item id={moveTopId} textValue="Move to Top">
						Move to Top
					</Dropdown.Item>
					<Dropdown.Item id={moveBottomId} textValue="Move to Bottom">
						Move to Bottom
					</Dropdown.Item>
				</Dropdown.Menu>
              <div className="mt-3 pt-2 border-t border-default-200">
                <form 
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.querySelector('input') as HTMLInputElement;
                    const targetRowNumber = parseInt(input.value, 10);
                    if (!isNaN(targetRowNumber) && targetRowNumber >= 1) {
                      // Convert from 1-based row number to 0-based sortOrder
                      const targetSortOrder = targetRowNumber - 1;
                      const currentSortOrder = task.sortOrder ?? index;
                      onReorderToSortOrder?.(task.id, currentSortOrder, targetSortOrder);
                      input.value = '';
                    }
                    setOpen(false);
                  }}
                >
                  <input
                    type="number"
                    min="1"
                    placeholder="Row #"
                    className="w-16 h-8 px-2 text-sm bg-default-100 border border-default-300 rounded-md focus:outline-none focus:border-accent"
                  />
                  <Button type="submit" size="sm" variant="primary">
                    Move
                  </Button>
                </form>
              </div>
            </div>
          </Dropdown.Popover>
        </Dropdown>

				<Button
					variant={isSelected ? "secondary" : "ghost"}
					size="sm"
					isIconOnly
					onPress={() => onOpenDetails?.(task)}
					data-cell
					data-row={index}
					data-col={7}
					aria-label="Open details"
				>
					<ChevronRight
						className={cn("h-4 w-4", isSelected ? "" : "text-accent-700")}
					/>
				</Button>

			{/* Selected indicator chevron */}
		</div>
	</li>
);
});
