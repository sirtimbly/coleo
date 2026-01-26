import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Bold, GripVertical, MessageSquare, SlidersHorizontal, ChevronDown } from 'lucide-react';
import { Chip, Button, Dropdown, Menu } from '@heroui/react';
import { type Task } from '@/lib/api';
import { cn } from '@/lib';

export interface TaskUiMeta {
  tags?: string[];
  color?: string;
  bold?: boolean;
}

export type TaskUpdate = Partial<{
  subject: string;
  description: string;
  status: Task['status'];
  priority: Task['priority'];
  domain: string;
  phase: string;
  assignedTo: string | null;
  dueDate: string | null;
  artifacts: string[];
  metadata: Record<string, unknown>;
}>;

interface TaskGridRowProps {
  task: Task;
  index: number;
  availableTags?: string[];
  isSelected?: boolean;
  onOpenDetails?: (task: Task) => void;
  onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
  onUpdateUi?: (taskId: string, updates: TaskUiMeta) => void;
  onDragStart?: (index: number) => void;
  onDragOver?: (index: number) => void;
  onDrop?: (index: number) => void;
  onGridKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  className?: string;
}

const PRIORITY_OPTIONS: Task['priority'][] = ['low', 'normal', 'high', 'critical'];

const COLOR_OPTIONS = ['slate', 'blue', 'emerald', 'amber', 'rose'] as const;
type ColorOption = (typeof COLOR_OPTIONS)[number];

const COLOR_CLASSES: Record<ColorOption, { dot: string; row: string }> = {
  slate: { dot: 'bg-slate-400', row: 'bg-slate-50 border-slate-200 border-l-slate-400' },
  blue: { dot: 'bg-blue-400', row: 'bg-blue-50 border-blue-200 border-l-blue-400' },
  emerald: { dot: 'bg-emerald-400', row: 'bg-emerald-50 border-emerald-200 border-l-emerald-400' },
  amber: { dot: 'bg-amber-400', row: 'bg-amber-50 border-amber-200 border-l-amber-400' },
  rose: { dot: 'bg-rose-400', row: 'bg-rose-50 border-rose-200 border-l-rose-400' },
};

export function TaskGridRow({
  task,
  index,
  availableTags = [],
  isSelected,
  onOpenDetails,
  onUpdateTask,
  onUpdateUi,
  onDragStart,
  onDragOver,
  onDrop,
  onGridKeyDown,
  className,
}: TaskGridRowProps) {
  const uiMeta = useMemo(() => {
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const ui = (meta.ui ?? {}) as Record<string, unknown>;
    return {
      tags: Array.isArray(ui.tags) ? (ui.tags as string[]) : [],
      color: typeof ui.color === 'string' ? (ui.color as string) : 'slate',
      bold: Boolean(ui.bold),
    };
  }, [task.metadata]);

  const [subjectValue, setSubjectValue] = useState(task.subject);
  const [tagSearch, setTagSearch] = useState('');
  const [previewColor, setPreviewColor] = useState<ColorOption | null>(null);

  useEffect(() => setSubjectValue(task.subject), [task.subject]);

  const savedColor = (COLOR_OPTIONS.includes(uiMeta.color as ColorOption)
    ? (uiMeta.color as ColorOption)
    : 'slate');
  
  // Use preview color if hovering, otherwise use saved color
  const colorKey = previewColor ?? savedColor;

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
    const existing = availableTags.find((tag) => tag.toLowerCase() === trimmed.toLowerCase());
    const nextTag = existing ?? trimmed;
    if (!nextTag) return;
    const next = Array.from(new Set([...uiMeta.tags, nextTag]));
    onUpdateUi?.(task.id, { tags: next });
    setTagSearch('');
  };

  const filteredTags = useMemo(() => {
    const query = tagSearch.trim().toLowerCase();
    if (!query) return availableTags;
    return availableTags.filter((tag) => tag.toLowerCase().includes(query));
  }, [availableTags, tagSearch]);

  const handleTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleCreateTag(tagSearch);
      return;
    }
    if (event.key === 'Escape') {
      setTagSearch('');
    }
  };

  const handleRowClick = (event: React.MouseEvent<HTMLLIElement>) => {
    // Don't open details if clicking on interactive elements
    const target = event.target as HTMLElement;
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('[role="menu"]') ||
      target.closest('[data-slot]')
    ) {
      return;
    }
    onOpenDetails?.(task);
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
    // Open details on Enter when the row background is focused (not child elements)
    if (event.key === 'Enter' && event.target === event.currentTarget) {
      onOpenDetails?.(task);
    }
  };

  return (
    <li
      className={cn(
        'grid grid-cols-[24px_2.2fr_1fr_1fr_1.4fr_200px] items-center gap-3 px-3 py-1 text-sm transition-all cursor-pointer',
        'border-l-4 rounded-md border',
        // Base color from row color setting
        !isSelected && COLOR_CLASSES[colorKey]?.row,
        // Hover state (only when not selected)
        !isSelected && 'hover:bg-primary-50 hover:border-primary-200',
        // Selected state - strong visual indication
        isSelected && 'bg-primary-100 border-primary-400 border-l-primary-500 ring-2 ring-primary-200 shadow-sm',
        className
      )}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver?.(index);
      }}
      onDrop={() => onDrop?.(index)}
    >
      <button
        type="button"
        className="p-1 text-default-500 hover:text-default-700 rounded cursor-move" 
        draggable
        onDragStart={() => onDragStart?.(index)}
        onKeyDown={onGridKeyDown}
        data-cell
        data-row={index}
        data-col={0}
        title="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <input
        value={subjectValue}
        onChange={(event) => setSubjectValue(event.target.value)}
        onBlur={handleSubjectBlur}
        onKeyDown={(event) => {
          onGridKeyDown?.(event);
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        data-cell
        data-row={index}
        data-col={1}
        className={cn(
          'bg-transparent border border-transparent rounded-md px-2 py-1 transition-all',
          'hover:border-default-300 hover:bg-default-50',
          'focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20',
          uiMeta.bold && 'font-semibold'
        )}
        aria-label="Task subject (click to edit)"
        title="Click to edit task title"
      />

      <div className="px-2 py-1 text-default-500 text-xs uppercase tracking-wide">
        {task.status.replace('_', ' ')}
      </div>

      {/* Priority dropdown */}
      <Dropdown>
        <Dropdown.Trigger>
          <Button
            variant="ghost"
            size="sm"
            className="justify-between min-w-24"
            data-cell
            data-row={index}
            data-col={2}
          >
            <span className="text-xs">{task.priority}</span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </Dropdown.Trigger>
        <Dropdown.Popover>
          <Dropdown.Menu
            onAction={(key) => onUpdateTask?.(task.id, { priority: key as Task['priority'] })}
          >
            {PRIORITY_OPTIONS.map((priority) => (
              <Dropdown.Item key={priority}>{priority}</Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      {/* Tags dropdown */}
      <Dropdown>
        <Dropdown.Trigger>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start min-w-32"
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
                <span className="text-xs text-default-400">+{uiMeta.tags.length - 2}</span>
              )}
            </div>
            <ChevronDown className="h-3 w-3 opacity-50 ml-1" />
          </Button>
        </Dropdown.Trigger>
        <Dropdown.Popover className="min-w-64">
          <div className="px-2 py-2">
            <input
              value={tagSearch}
              onChange={(event) => setTagSearch(event.target.value)}
              onKeyDown={handleTagInputKeyDown}
              placeholder="Search or add tag (press Enter)"
              className="w-full h-8 rounded-lg border border-default-300 bg-default-100 px-3 text-sm text-default-700 placeholder:text-default-400 focus:border-primary focus:outline-none"
            />
          </div>
          <Menu
            selectionMode="multiple"
            selectedKeys={new Set(uiMeta.tags)}
            onSelectionChange={(keys) => {
              if (keys === 'all') return;
              handleTagSelection(Array.from(keys as Set<string>));
            }}
            className="max-h-60"
          >
            {filteredTags.map((tag) => (
              <Menu.Item key={tag} id={tag}>{tag}</Menu.Item>
            ))}
          </Menu>
        </Dropdown.Popover>
      </Dropdown>

      <div className="flex items-center justify-end gap-2">
        {/* Formatting dropdown */}
        <Dropdown>
          <Dropdown.Trigger>
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              data-cell
              data-row={index}
              data-col={4}
              aria-label="Formatting & appearance"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
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
                <span className="text-sm">{uiMeta.bold ? 'Unbold row' : 'Bold row'}</span>
              </button>
              
              {/* Color picker */}
              <div className="mt-2 px-2">
                <div className="text-[11px] uppercase tracking-wide text-default-500 mb-2">Row color</div>
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
                        'h-5 w-5 rounded-full border-2 transition-all cursor-pointer',
                        COLOR_CLASSES[color].dot,
                        savedColor === color 
                          ? 'border-primary ring-2 ring-primary/30 scale-110' 
                          : 'border-white shadow-sm hover:scale-110 hover:shadow-md'
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
          onPress={() => onOpenDetails?.(task)}
          data-cell
          data-row={index}
          data-col={5}
          aria-label="Open details"
        >
          <MessageSquare className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}
