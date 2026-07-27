import { useEffect, useMemo, useRef, useState, memo } from "react";
import {
	Bold,
	GripVertical,
	MessageSquare,
	SlidersHorizontal,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	Trash2,
	ArrowUpDown,
	MoreHorizontal,
	Check,
} from "lucide-react";
import { Chip, Button, Dropdown, Checkbox, Label, type Selection } from "@heroui/react";
import { type Task, type TaskMetadata, type UiMetadata } from "@/lib";
import { ProgressBar } from "./ProgressBar";
import { cn } from "@/lib";
import {
	COLOR_OPTIONS,
	COLOR_CLASSES_LIGHT,
	GRID_ACTION_BUTTON_CLASS,
	GRID_METADATA_CONTROL_CLASS,
	GRID_METADATA_VALUE_CLASS,
	getValidColor,
} from "./grid-shared";
import {
	PRIORITY_DOT_STYLES,
	PRIORITY_OPTIONS,
	STATUS_DOT_STYLES,
	STATUS_LABELS,
} from "./task-styles";
import { formatGridDate } from "./grid-table";

export const TASK_GRID_COLUMNS_CLASS =
	"grid-cols-[24px_80px_32px_minmax(280px,1fr)_112px_132px_112px_96px_124px_140px_180px]";

export type TaskUiMeta = UiMetadata;

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
	metadata: TaskMetadata;
	blockedReason: string;
	blockedCategory: Task["blockedCategory"];
	blockedNeedsHuman: boolean;
}>;

interface TaskGridRowProps {
	task: Task;
	index: number;
	availableTags?: string[];
	isSelected?: boolean;
	isDragging?: boolean;
	isExpanded?: boolean;
	orderNumber: number;
	canReorder: boolean;
	onToggleExpanded: (taskId: string) => void;
	onOpenDetails?: (task: Task) => void;
	onOpenDiscussions?: (task: Task) => void;
	onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
	onUpdateUi?: (taskId: string, updates: TaskUiMeta) => void;
	onDelete?: (task: Task) => void;
	onReorderToSortOrder?: (taskId: string, fromSortOrder: number, toSortOrder: number) => void;
	dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
	onGridKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
	className?: string;
}

type ColorOption = (typeof COLOR_OPTIONS)[number];

const isTaskPriority = (value: string): value is Task["priority"] =>
	PRIORITY_OPTIONS.some((option) => option === value);

export const TaskGridRow = memo(function TaskGridRow({
	task,
	index,
	availableTags = [],
	isSelected,
	isDragging,
	isExpanded,
	orderNumber,
	canReorder,
	onToggleExpanded,
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
	const uiMeta = {
		tags: task.metadata.ui?.tags ?? [],
		color: task.metadata.ui?.color ?? "slate",
		bold: task.metadata.ui?.bold ?? false,
	};
	const [open, setOpen] = useState(false);
	const [subjectValue, setSubjectValue] = useState(task.subject);
	const [tagSearch, setTagSearch] = useState("");
	const [previewColor, setPreviewColor] = useState<ColorOption | null>(null);
	const [isTagDropdownOpen, setIsTagDropdownOpen] = useState(false);
	const tagInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => setSubjectValue(task.subject), [task.subject]);

	useEffect(() => {
		if (isTagDropdownOpen) {
			const timer = setTimeout(() => {
				tagInputRef.current?.focus();
			}, 50);
			return () => clearTimeout(timer);
		}
	}, [isTagDropdownOpen]);

	const savedColor = getValidColor(uiMeta.color);
	const colorKey = previewColor ?? savedColor;

	const priorityDotClass = PRIORITY_DOT_STYLES[task.priority];
	const statusDotClass = STATUS_DOT_STYLES[task.status];
	const statusLabel = STATUS_LABELS[task.status];
	const statusDescription =
		task.assignedArmName &&
		(task.status === "in_progress" || task.status === "claimed")
			? `${statusLabel} · ${task.assignedArmName}`
			: statusLabel;
	const sourceTypeLabel = task.sourceType
		.replaceAll("_", " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());

	const progress = task.status === "completed" ? 100 : task.progress ?? 0;
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

	const handlePrioritySelection = (selection: Selection) => {
		if (selection === "all") return;
		const [priority] = Array.from(selection);
		if (typeof priority === "string" && isTaskPriority(priority) && priority !== task.priority) {
			onUpdateTask?.(task.id, { priority });
		}
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

	const handleTagInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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
		onOpenDetails?.(task);
	};

	const handleRowKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
		if (event.key === "Enter" && event.target === event.currentTarget) {
			onOpenDetails?.(task);
		}
	};

  return (
    <li
      className={cn(
 		"grid min-h-12 min-w-[1396px] gap-2 border-b border-border/50 px-3 py-1.5 text-sm transition-colors cursor-pointer",
        TASK_GRID_COLUMNS_CLASS,
		isExpanded ? "items-start" : "items-center",
        "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50",
        !isDragging && colorKey !== "slate" && COLOR_CLASSES_LIGHT[colorKey]?.row,
        !isSelected && !isDragging && "hover:bg-surface-secondary/70",
        isSelected && "bg-accent/10 ring-1 ring-inset ring-accent/30",
        isDragging &&
          "opacity-40 bg-default-100 border-dashed border-default-300",
        className,
      )}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      tabIndex={0}
      aria-label={`Open task details: ${task.subject}`}
    >
      <div
		className={cn(
		  "rounded p-1 text-default-500",
		  canReorder ? "cursor-move hover:text-default-700" : "cursor-default opacity-35",
		)}
        {...dragHandleProps}
        data-cell
        data-row={index}
        data-col={0}
		title={canReorder ? "Drag to reorder" : "Clear filters and sort by Order to reorder"}
      >
        <GripVertical className="h-4 w-4" />
      </div>
	  <div className="pr-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
		{orderNumber}
	  </div>
	  <button
		type="button"
		onClick={() => onToggleExpanded(task.id)}
		aria-expanded={isExpanded}
		aria-label={isExpanded ? "Collapse task row" : "Expand task row"}
		className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
	  >
		<ChevronRight className={cn("h-4 w-4 transition-transform", isExpanded && "rotate-90")} />
	  </button>

			{isExpanded ? (
				<div className="min-w-0 px-2 py-2">
					<textarea
						ref={(element) => {
							if (element) element.style.height = "auto";
							element?.style.setProperty("height", `${element.scrollHeight}px`);
						}}
						value={subjectValue}
						onChange={(event) => setSubjectValue(event.target.value)}
						onBlur={handleSubjectBlur}
						onKeyDown={(event) => {
							onGridKeyDown?.(event);
							if (event.key === "Enter" && !event.shiftKey) event.currentTarget.blur();
						}}
						onClick={(event) => event.stopPropagation()}
						data-cell
						data-row={index}
						data-col={1}
						rows={1}
						className={cn(
							"w-full min-w-0 resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-0 py-1 transition-colors",
							"hover:border-default-300 hover:bg-default-50 hover:px-2",
							"focus:border-accent focus:bg-surface-secondary focus:px-2 focus:outline-none focus:ring-2 focus:ring-accent/20",
							uiMeta.bold && "font-semibold",
						)}
						aria-label="Task subject (click to edit)"
						title="Click to edit task title"
					/>
					<div className="mt-2 h-[200px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-surface-secondary/40 p-3 text-xs leading-5 text-muted-foreground">
						{task.description.trim() || "No detail text provided."}
					</div>
				</div>
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
						"w-full min-w-0 truncate whitespace-nowrap rounded-md border border-transparent bg-transparent px-2 py-1 transition-colors",
						"hover:border-default-300 hover:bg-default-50",
						"focus-visible:border-accent focus-visible:bg-surface-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20",
						uiMeta.bold && "font-semibold",
					)}
					aria-label="Task subject (click to edit)"
					title="Click to edit task title"
				/>
			)}

			<div
				className="truncate px-2 text-xs tabular-nums text-muted-foreground"
				title={task.createdAt}
			>
				{formatGridDate(task.createdAt)}
			</div>

			<div className={GRID_METADATA_VALUE_CLASS} title={statusDescription}>
				<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClass)} aria-hidden="true" />
				<span className="min-w-0 truncate">{statusDescription}</span>
			</div>

			{/* Progress bar */}
			<ProgressBar percent={progress} showLabel size="sm" className="min-w-0" />

			{/* Priority dropdown */}
			<Dropdown>
				<Dropdown.Trigger
					className={GRID_METADATA_CONTROL_CLASS}
					data-cell
					data-row={index}
					data-col={2}
					aria-label={`Change priority from ${task.priority}`}
				>
					<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", priorityDotClass)} aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate capitalize">{task.priority}</span>
					<ChevronDown className="h-3 w-3 shrink-0 opacity-40" aria-hidden="true" />
				</Dropdown.Trigger>
				<Dropdown.Popover>
				<Dropdown.Menu
					selectionMode="single"
					selectedKeys={new Set([task.priority])}
					onSelectionChange={handlePrioritySelection}
				>
					{PRIORITY_OPTIONS.map((priority) => (
						<Dropdown.Item
							key={priority}
							id={priority}
							textValue={priority}
							className="grid-metadata-option capitalize"
						>
							<Dropdown.ItemIndicator />
							<Label>{priority}</Label>
						</Dropdown.Item>
					))}
				</Dropdown.Menu>
			</Dropdown.Popover>
		</Dropdown>

			<div className={GRID_METADATA_VALUE_CLASS} title={sourceTypeLabel}>
				<span className="min-w-0 truncate">{sourceTypeLabel}</span>
			</div>

			{/* Tags dropdown */}
			<Dropdown onOpenChange={setIsTagDropdownOpen}>
				<Dropdown.Trigger
					className={GRID_METADATA_CONTROL_CLASS}
					data-cell
					data-row={index}
					data-col={3}
					aria-label="Edit task tags"
				>
					<div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap">
						{uiMeta.tags.length === 0 ? (
							<span className="text-xs text-muted-foreground/70">No tags</span>
						) : (
							<Chip size="sm" variant="soft" className="max-w-24 shrink truncate text-xs">
								{uiMeta.tags[0]}
							</Chip>
						)}
						{uiMeta.tags.length > 1 && (
							<span className="text-xs text-default-400">
								+{uiMeta.tags.length - 1}
							</span>
						)}
					</div>
					<ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-40" aria-hidden="true" />
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

			<div className="ml-2 flex items-center justify-end border-l border-border/60 pl-3 whitespace-nowrap">
				<div className="inline-flex h-9 items-center gap-0.5 rounded-lg border border-border/70 bg-surface-secondary/50 p-0.5">
				{/* Formatting dropdown */}
				<Dropdown>
					<Dropdown.Trigger
						className={GRID_ACTION_BUTTON_CLASS}
						data-cell
						data-row={index}
						data-col={4}
						aria-label="Formatting and appearance"
					>
						<SlidersHorizontal className="h-4 w-4" />
					</Dropdown.Trigger>
					<Dropdown.Popover>
						<div className="p-2">
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
												COLOR_CLASSES_LIGHT[color].dot,
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
						className={cn(GRID_ACTION_BUTTON_CLASS, "w-auto gap-1 px-1.5 text-xs tabular-nums")}
					>
						<MessageSquare className="h-4 w-4" />
						<span>{task.commentCount}</span>
					</Button>
				)}

				<Button
					variant={isSelected ? "secondary" : "ghost"}
					size="sm"
					isIconOnly
					onPress={() => onOpenDetails?.(task)}
					data-cell
					data-row={index}
					data-col={5}
					aria-label="Open details"
					className={GRID_ACTION_BUTTON_CLASS}
				>
					<ExternalLink className={cn("h-4 w-4", isSelected ? "" : "text-accent-700")} />
				</Button>

        <Dropdown isOpen={open} onOpenChange={setOpen}>
		  <Dropdown.Trigger
			  className={GRID_ACTION_BUTTON_CLASS}
              data-cell
              data-row={index}
              data-col={6}
			  aria-label="More task actions"
          >
			  <MoreHorizontal className="h-4 w-4" />
          </Dropdown.Trigger>
          <Dropdown.Popover>
            <div className="p-2 min-w-[200px]">
				<Dropdown.Menu
					disabledKeys={canReorder ? [] : [moveTopId, moveBottomId]}
					onAction={(key) => {
						const currentSortOrder = index;
						if (key === moveTopId) {
							onReorderToSortOrder?.(task.id, currentSortOrder, 0);
						} else if (key === moveBottomId) {
							onReorderToSortOrder?.(task.id, currentSortOrder, -1);
						} else if (key === "delete") {
							onDelete?.(task);
						}
					}}
				>
					<Dropdown.Item id={moveTopId} textValue="Move to Top">
						<ArrowUpDown className="h-4 w-4" />
						<Label>Move to Top</Label>
					</Dropdown.Item>
				<Dropdown.Item id={moveBottomId} textValue="Move to Bottom">
					<ArrowUpDown className="h-4 w-4" />
					<Label>Move to Bottom</Label>
				</Dropdown.Item>
				<Dropdown.Item id="delete" textValue="Delete task" variant="danger">
					<Trash2 className="h-4 w-4" />
					<Label>Delete Task</Label>
				</Dropdown.Item>
			</Dropdown.Menu>
			  {canReorder ? (
              <div className="mt-3 pt-2 border-t border-default-200">
                <form 
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.namedItem("row-number");
                    if (!(input instanceof HTMLInputElement)) {
                      setOpen(false);
                      return;
                    }
                    const targetRowNumber = parseInt(input.value, 10);
                    if (!isNaN(targetRowNumber) && targetRowNumber >= 1) {
                      const targetSortOrder = targetRowNumber - 1;
						const currentSortOrder = index;
                      onReorderToSortOrder?.(task.id, currentSortOrder, targetSortOrder);
                      input.value = '';
                    }
                    setOpen(false);
                  }}
                >
                  <input
                    name="row-number"
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
			  ) : (
				<p className="mt-2 border-t border-border px-2 pt-2 text-xs text-muted-foreground">
					Clear column filters and sort by Order to move this task.
				</p>
			  )}
            </div>
          </Dropdown.Popover>
        </Dropdown>
				</div>
		</div>
	</li>
);
});
