import { useEffect, useMemo, useRef, useState, memo } from "react";
import {
	Bold,
	GripVertical,
	SlidersHorizontal,
	ChevronDown,
	ChevronRight,
	Trash2,
	ArrowUpDown,
	Check,
	Bug as BugIcon,
} from "lucide-react";
import { Chip, Button, Dropdown, Checkbox } from "@heroui/react";
import { type Bug, type BugMetadata, type BugUiMetadata } from "@/lib";
import { cn } from "@/lib";
import { COLOR_OPTIONS, COLOR_CLASSES, getValidColor } from "./grid-shared";
import { STATUS_OPTIONS, STATUS_STYLES, PRIORITY_OPTIONS, PRIORITY_STYLES, SOURCE_STYLES } from "./bug-styles";

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
	onOpenDetails,
	onUpdateBug,
	onUpdateUi,
	onDelete,
	onReorderToSortOrder,
	dragHandleProps,
	onGridKeyDown,
	className,
}: BugGridRowProps) {
	const displayRowNumber = index + 1;

	const uiMeta: BugRowUiMeta = {
		tags: [],
		color: "slate",
		bold: false,
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

	const statusClasses = STATUS_STYLES[bug.status];
	const priorityClasses = PRIORITY_STYLES[bug.priority];
	const sourceClasses = SOURCE_STYLES[bug.source];

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
        "grid grid-cols-[48px_24px_minmax(0,1fr)_96px_110px_110px_160px_120px] -translate-y-1 items-center gap-3 px-3 py-1 text-sm transition-all cursor-pointer",
        "rounded-md ",
        !isDragging &&
          (uiMeta.bold
            ? COLOR_CLASSES[colorKey]?.rowBold
            : COLOR_CLASSES[colorKey]?.row),
        !isSelected &&
          !isDragging &&
          "hover:bg-accent/20 hover:border-accent",
        isSelected && "bg-accent shadow-md shadow-accent/20",
        isDragging &&
          "opacity-40 bg-default-100 border-dashed border-default-300",
        className,
      )}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
    >
		{/* Row number */}
      <div className="text-xs text-muted-foreground font-mono text-right pr-1">
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
					value={titleValue}
					onChange={(event) => setTitleValue(event.target.value)}
					onBlur={handleTitleBlur}
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
					aria-label="Bug title (click to edit)"
					title="Click to edit bug title"
					style={{ height: "auto", minHeight: "28px" }}
				/>
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
						"min-w-0 bg-transparent border border-transparent rounded-md px-2 py-1 transition-all",
						"hover:border-default-300 hover:bg-default-50",
						"focus:border-accent focus:bg-white focus:outline-none focus:ring-2 focus:ring-accent/20",
						uiMeta.bold && "font-semibold",
					)}
					aria-label="Bug title (click to edit)"
					title="Click to edit bug title"
				/>
			)}

			{/* Status dropdown */}
			<Dropdown>
				<Dropdown.Trigger>
					<div
						className={cn(
							"flex items-center justify-between min-w-[96px] rounded-full border px-3 py-1 text-xs font-semibold transition cursor-pointer select-none",
							"hover:shadow-sm",
							statusClasses,
						)}
						data-cell
						data-row={index}
						data-col={2}
					>
						<span className="capitalize">{bug.status.replace("_", " ")}</span>
						<ChevronDown className="h-3 w-3 opacity-50" />
					</div>
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
							<Dropdown.Item key={status}>{status.replace("_", " ")}</Dropdown.Item>
						))}
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>

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
						data-col={3}
					>
						<span className="capitalize">{bug.priority}</span>
						<ChevronDown className="h-3 w-3 opacity-50" />
					</div>
				</Dropdown.Trigger>
				<Dropdown.Popover>
					<Dropdown.Menu
						onAction={(key) => {
							if (typeof key === "string" && isBugPriority(key)) {
								onUpdateBug?.(bug.id, { priority: key });
							}
						}}
					>
						{PRIORITY_OPTIONS.map((priority) => (
							<Dropdown.Item key={priority}>{priority}</Dropdown.Item>
						))}
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>

			{/* Source/Type display */}
			<div
				className={cn(
					"flex items-center justify-center min-w-[96px] rounded-full border px-3 py-1 text-xs font-semibold",
					sourceClasses,
				)}
				data-cell
				data-row={index}
				data-col={4}
			>
				<BugIcon className="h-3 w-3 mr-1" />
				<span className="capitalize">{bug.source.replace("_", " ")}</span>
			</div>

			{/* Tags dropdown */}
			<Dropdown onOpenChange={setIsTagDropdownOpen}>
				<Dropdown.Trigger>
					<div
						className="flex items-center justify-start min-w-32 px-3 py-1 text-sm cursor-pointer select-none hover:bg-default-100 rounded-md"
						data-cell
						data-row={index}
						data-col={5}
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
							data-col={6}
							title="Formatting & appearance"
						>
							<SlidersHorizontal className="h-4 w-4" />
						</div>
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

				<Button
					variant="ghost"
					size="sm"
					isIconOnly
					onPress={() => onDelete?.(bug)}
					data-cell
					data-row={index}
					data-col={7}
					aria-label="Delete bug"
				>
					<Trash2 className="h-4 w-4" />
				</Button>

        <Dropdown isOpen={open} onOpenChange={setOpen}>
          <Dropdown.Trigger>
            <div
              className="p-1 text-default-500 hover:text-default-700 rounded cursor-pointer"
              data-cell
              data-row={index}
              data-col={8}
              title="More actions"
            >
              <ArrowUpDown className="h-4 w-4" />
            </div>
          </Dropdown.Trigger>
          <Dropdown.Popover>
            <div className="p-2 min-w-[200px]">
              <Dropdown.Menu
                onAction={(key) => {
                  const currentSortOrder = index;
                  if (key === "top") {
                    onReorderToSortOrder?.(bug.id, currentSortOrder, 0);
                  } else if (key === "bottom") {
                    onReorderToSortOrder?.(bug.id, currentSortOrder, -1);
                  }
                }}
              >
                <Dropdown.Item key="top">Move to Top</Dropdown.Item>
                <Dropdown.Item key="bottom">Move to Bottom</Dropdown.Item>
              </Dropdown.Menu>
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
					data-col={9}
					aria-label="Open details"
				>
					<ChevronRight
						className={cn("h-4 w-4", isSelected ? "" : "text-accent-700")}
					/>
				</Button>

		</div>
	</li>
);
});
