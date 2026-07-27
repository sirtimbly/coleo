import { useEffect, useMemo, useRef, useState, memo } from "react";
import {
	Bold,
	GripVertical,
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
import { type Bug, type BugMetadata, type BugUiMetadata } from "@/lib";
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
	SOURCE_DOT_STYLES,
	STATUS_DOT_STYLES,
	STATUS_OPTIONS,
} from "./bug-styles";
import { formatGridDate } from "./grid-table";

export const BUG_GRID_COLUMNS_CLASS =
	"grid-cols-[24px_80px_32px_minmax(260px,1fr)_112px_128px_108px_150px_140px_144px]";

export type BugUiMeta = BugUiMetadata;

export type BugUpdate = Partial<{
	title: string;
	description: string;
	status: Bug["status"];
	priority: Bug["priority"];
	assigneeArmId: string;
	blockers: string[];
	resolution: string;
	humanNotified: boolean;
	metadata: BugMetadata;
}>;

interface BugGridRowProps {
	bug: Bug;
	index: number;
	availableTags?: string[];
	isSelected?: boolean;
	isDragging?: boolean;
	isExpanded?: boolean;
	orderNumber: number;
	canReorder: boolean;
	onToggleExpanded: (bugId: string) => void;
	onOpenDetails?: (bug: Bug) => void;
	onUpdateBug?: (bugId: string, updates: BugUpdate) => void;
	onUpdateUi?: (bugId: string, updates: BugUiMeta) => void;
	onDelete?: (bug: Bug) => void;
	onReorderToSortOrder?: (bugId: string, fromSortOrder: number, toSortOrder: number) => void;
	dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
	onGridKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
	className?: string;
}

type ColorOption = (typeof COLOR_OPTIONS)[number];

type BugRowUiMeta = {
	tags: string[];
	color: ColorOption;
	bold: boolean;
};

const isBugStatus = (value: string): value is Bug["status"] =>
	STATUS_OPTIONS.some((option) => option === value);

const isBugPriority = (value: string): value is Bug["priority"] =>
	PRIORITY_OPTIONS.some((option) => option === value);

export const BugGridRow = memo(function BugGridRow({
	bug,
	index,
	availableTags = [],
	isSelected,
	isDragging,
	isExpanded,
	orderNumber,
	canReorder,
	onToggleExpanded,
	onOpenDetails,
	onUpdateBug,
	onUpdateUi,
	onDelete,
	onReorderToSortOrder,
	dragHandleProps,
	onGridKeyDown,
	className,
}: BugGridRowProps) {
	const uiMeta: BugRowUiMeta = {
		tags: bug.metadata?.ui?.tags ?? [],
		color: getValidColor(bug.metadata?.ui?.color),
		bold: bug.metadata?.ui?.bold ?? false,
	};

	const [open, setOpen] = useState(false);
	const [titleValue, setTitleValue] = useState(bug.title);
	const [tagSearch, setTagSearch] = useState("");
	const [previewColor, setPreviewColor] = useState<ColorOption | null>(null);
	const [isTagDropdownOpen, setIsTagDropdownOpen] = useState(false);
	const tagInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => setTitleValue(bug.title), [bug.title]);

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

	const statusDotClass = STATUS_DOT_STYLES[bug.status];
	const priorityDotClass = PRIORITY_DOT_STYLES[bug.priority];
	const sourceDotClass = SOURCE_DOT_STYLES[bug.source];

	const handleTitleBlur = () => {
		const next = titleValue.trim();
		if (next && next !== bug.title) {
			onUpdateBug?.(bug.id, { title: next });
		} else {
			setTitleValue(bug.title);
		}
	};

	const handleTagSelection = (tags: string[]) => {
		onUpdateUi?.(bug.id, { tags });
	};

	const handlePrioritySelection = (selection: Selection) => {
		if (selection === "all") return;
		const [priority] = Array.from(selection);
		if (typeof priority === "string" && isBugPriority(priority) && priority !== bug.priority) {
			onUpdateBug?.(bug.id, { priority });
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
		onUpdateUi?.(bug.id, { tags: next });
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
		onOpenDetails?.(bug);
	};

	const handleRowKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
		if (event.key === "Enter" && event.target === event.currentTarget) {
			onOpenDetails?.(bug);
		}
	};

  return (
    <li
      className={cn(
        "grid min-h-12 min-w-[1220px] gap-2 border-b border-border/50 px-3 py-1.5 text-sm transition-colors cursor-pointer",
        BUG_GRID_COLUMNS_CLASS,
		isExpanded ? "items-start" : "items-center",
        "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50",
        !isDragging && colorKey !== "slate" && COLOR_CLASSES_LIGHT[colorKey].row,
        !isSelected && !isDragging && "hover:bg-surface-secondary/70",
        isSelected && "bg-accent/10 ring-1 ring-inset ring-accent/30",
        isDragging &&
          "opacity-40 bg-default-100 border-dashed border-default-300",
        className,
      )}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      tabIndex={0}
      aria-label={`Open bug details: ${bug.title}`}
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
		onClick={() => onToggleExpanded(bug.id)}
		aria-expanded={isExpanded}
		aria-label={isExpanded ? "Collapse bug row" : "Expand bug row"}
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
						value={titleValue}
						onChange={(event) => setTitleValue(event.target.value)}
						onBlur={handleTitleBlur}
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
						aria-label="Bug title (click to edit)"
						title="Click to edit bug title"
					/>
					<div className="mt-2 h-[200px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-surface-secondary/40 p-3 text-xs leading-5 text-muted-foreground">
						{bug.description.trim() || "No detail text provided."}
					</div>
				</div>
			) : (
				<input
					value={titleValue}
					onChange={(event) => setTitleValue(event.target.value)}
					onBlur={handleTitleBlur}
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
					aria-label="Bug title (click to edit)"
					title="Click to edit bug title"
				/>
			)}

			<div
				className="truncate px-2 text-xs tabular-nums text-muted-foreground"
				title={new Date(bug.createdAt).toLocaleString()}
			>
				{formatGridDate(bug.createdAt)}
			</div>

			{/* Status dropdown */}
			<Dropdown>
				<Dropdown.Trigger
					className={GRID_METADATA_CONTROL_CLASS}
					data-cell
					data-row={index}
					data-col={2}
					aria-label={`Change status from ${bug.status.replace("_", " ")}`}
				>
					<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClass)} aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate capitalize">{bug.status.replace("_", " ")}</span>
					<ChevronDown className="h-3 w-3 shrink-0 opacity-40" aria-hidden="true" />
				</Dropdown.Trigger>
				<Dropdown.Popover>
					<Dropdown.Menu
						onAction={(key) => {
							if (typeof key === "string" && isBugStatus(key)) {
								onUpdateBug?.(bug.id, { status: key });
							}
						}}
					>
						{STATUS_OPTIONS.map((status) => (
							<Dropdown.Item key={status} className="grid-metadata-option capitalize">
								{status.replace("_", " ")}
							</Dropdown.Item>
						))}
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>

			{/* Priority dropdown */}
			<Dropdown>
				<Dropdown.Trigger
					className={GRID_METADATA_CONTROL_CLASS}
					data-cell
					data-row={index}
					data-col={3}
					aria-label={`Change priority from ${bug.priority}`}
				>
					<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", priorityDotClass)} aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate capitalize">{bug.priority}</span>
					<ChevronDown className="h-3 w-3 shrink-0 opacity-40" aria-hidden="true" />
				</Dropdown.Trigger>
				<Dropdown.Popover>
					<Dropdown.Menu
						selectionMode="single"
						selectedKeys={new Set([bug.priority])}
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

			{/* Source/Type display */}
			<div
				className={GRID_METADATA_VALUE_CLASS}
				data-cell
				data-row={index}
				data-col={4}
				title={bug.source.replace("_", " ")}
			>
				<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", sourceDotClass)} aria-hidden="true" />
				<span className="min-w-0 truncate capitalize">{bug.source.replace("_", " ")}</span>
			</div>

			{/* Tags dropdown */}
			<Dropdown onOpenChange={setIsTagDropdownOpen}>
				<Dropdown.Trigger
					className={GRID_METADATA_CONTROL_CLASS}
					data-cell
					data-row={index}
					data-col={5}
					aria-label="Edit bug tags"
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
						data-col={6}
						aria-label="Formatting and appearance"
					>
						<SlidersHorizontal className="h-4 w-4" />
					</Dropdown.Trigger>
					<Dropdown.Popover>
						<div className="p-2">
							<button
								type="button"
								onClick={() => onUpdateUi?.(bug.id, { bold: !uiMeta.bold })}
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
												onUpdateUi?.(bug.id, { color });
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

				<Button
					variant={isSelected ? "secondary" : "ghost"}
					size="sm"
					isIconOnly
					onPress={() => onOpenDetails?.(bug)}
					data-cell
					data-row={index}
					data-col={7}
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
              data-col={8}
			  aria-label="More bug actions"
		  >
			  <MoreHorizontal className="h-4 w-4" />
          </Dropdown.Trigger>
          <Dropdown.Popover>
            <div className="p-2 min-w-[200px]">
              <Dropdown.Menu
				disabledKeys={canReorder ? [] : ["top", "bottom"]}
                onAction={(key) => {
				  const currentSortOrder = index;
                  if (key === "top") {
                    onReorderToSortOrder?.(bug.id, currentSortOrder, 0);
                  } else if (key === "bottom") {
                    onReorderToSortOrder?.(bug.id, currentSortOrder, -1);
				  } else if (key === "delete") {
					onDelete?.(bug);
                  }
                }}
              >
				<Dropdown.Item id="top" textValue="Move to top">
					<ArrowUpDown className="h-4 w-4" />
					<Label>Move to Top</Label>
				</Dropdown.Item>
				<Dropdown.Item id="bottom" textValue="Move to bottom">
					<ArrowUpDown className="h-4 w-4" />
					<Label>Move to Bottom</Label>
				</Dropdown.Item>
				<Dropdown.Item id="delete" textValue="Delete bug" variant="danger">
					<Trash2 className="h-4 w-4" />
					<Label>Delete Bug</Label>
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
                      onReorderToSortOrder?.(bug.id, currentSortOrder, targetSortOrder);
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
					Clear column filters and sort by Order to move this bug.
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
