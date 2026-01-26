import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, Key } from 'react';
import { Bold, GripVertical, MessageSquare, SlidersHorizontal } from 'lucide-react';
import { Chip, Select, SelectItem } from '@heroui/react';
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
const COLOR_CLASSES: Record<(typeof COLOR_OPTIONS)[number], { dot: string; row: string }> = {
  slate: { dot: 'bg-slate-400', row: 'bg-slate-500/5 border-slate-500/30 border-l-slate-400' },
  blue: { dot: 'bg-sky-400', row: 'bg-sky-500/5 border-sky-500/30 border-l-sky-400' },
  emerald: { dot: 'bg-emerald-400', row: 'bg-emerald-500/5 border-emerald-500/30 border-l-emerald-400' },
  amber: { dot: 'bg-amber-400', row: 'bg-amber-500/5 border-amber-500/30 border-l-amber-400' },
  rose: { dot: 'bg-rose-400', row: 'bg-rose-500/5 border-rose-500/30 border-l-rose-400' },
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
  const [isFormatOpen, setIsFormatOpen] = useState(false);

  useEffect(() => setSubjectValue(task.subject), [task.subject]);

  const colorKey = (COLOR_OPTIONS.includes(uiMeta.color as (typeof COLOR_OPTIONS)[number])
    ? (uiMeta.color as (typeof COLOR_OPTIONS)[number])
    : 'slate');

  const handleSubjectBlur = () => {
    const next = subjectValue.trim();
    if (next && next !== task.subject) {
      onUpdateTask?.(task.id, { subject: next });
    } else {
      setSubjectValue(task.subject);
    }
  };

  const handleTagSelection = (keys: 'all' | Set<Key>) => {
    if (keys === 'all') return;
    const nextTags = Array.from(keys).map((key) => String(key));
    onUpdateUi?.(task.id, { tags: nextTags });
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

  return (
    <li
      className={cn(
        'grid grid-cols-[24px_2.2fr_1fr_1fr_1.4fr_200px] items-center gap-3 px-3 py-2 text-sm border-b border-border hover:bg-muted/40 transition-colors',
        'border-l-4',
        COLOR_CLASSES[colorKey]?.row,
        isSelected && 'bg-blue-500/10 border-blue-500/30',
        className
      )}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver?.(index);
      }}
      onDrop={() => onDrop?.(index)}
    >
      <button
        type="button"
        className="p-1 text-muted-foreground hover:text-foreground rounded cursor-move" 
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
          'bg-transparent border border-transparent rounded px-2 py-1 focus:border-border focus:bg-background focus:outline-none',
          uiMeta.bold && 'font-semibold'
        )}
        aria-label="Task subject"
      />

      <div className="px-2 py-1 text-muted-foreground text-xs uppercase tracking-wide">
        {task.status.replace('_', ' ')}
      </div>

      <select
        value={task.priority}
        onChange={(event) => onUpdateTask?.(task.id, { priority: event.target.value as Task['priority'] })}
        onKeyDown={onGridKeyDown}
        data-cell
        data-row={index}
        data-col={2}
        className="bg-transparent border border-transparent rounded px-2 py-1 focus:border-border focus:bg-background focus:outline-none"
        aria-label="Task priority"
      >
        {PRIORITY_OPTIONS.map((priority) => (
          <option key={priority} value={priority}>
            {priority}
          </option>
        ))}
      </select>

      <div className="flex flex-col gap-1">
        <input
          value={tagSearch}
          onChange={(event) => setTagSearch(event.target.value)}
          onKeyDown={handleTagInputKeyDown}
          placeholder="Search or add tag"
          className="h-6 rounded border border-transparent bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-border focus:bg-background focus:outline-none"
        />
        <Select
          aria-label="Task tags"
          selectionMode="multiple"
          isMultiline
          size="sm"
          placeholder="tags"
          selectedKeys={new Set(uiMeta.tags)}
          onSelectionChange={handleTagSelection}
          data-cell
          data-row={index}
          data-col={3}
          classNames={{
            base: 'min-h-0',
            trigger: 'bg-transparent border border-transparent px-2 py-1 min-h-0 h-auto',
            value: 'text-xs text-muted-foreground',
            listbox: 'text-xs',
          }}
          renderValue={(items) => (
            <div className="flex flex-wrap items-center gap-1">
              {items.map((item) => (
                <Chip key={item.key} size="sm" variant="flat" className="text-xs">
                  {item.textValue}
                </Chip>
              ))}
            </div>
          )}
        >
          {filteredTags.map((tag) => (
            <SelectItem key={tag}>{tag}</SelectItem>
          ))}
        </Select>
      </div>

      <div className="flex items-center justify-end gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsFormatOpen((prev) => !prev)}
            onKeyDown={onGridKeyDown}
            data-cell
            data-row={index}
            data-col={4}
            className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            title="Formatting & appearance"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
          {isFormatOpen && (
            <div className="absolute right-0 mt-2 w-44 rounded border border-border bg-card shadow-lg p-2 z-10">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                Formatting & appearance
              </div>
              <button
                type="button"
                onClick={() => onUpdateUi?.(task.id, { bold: !uiMeta.bold })}
                onKeyDown={onGridKeyDown}
                data-cell
                data-row={index}
                data-col={4}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted',
                  uiMeta.bold && 'text-foreground bg-muted'
                )}
              >
                <Bold className="h-3.5 w-3.5" />
                Bold row
              </button>
              <div className="mt-2 text-[11px] text-muted-foreground">Row color</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {COLOR_OPTIONS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => onUpdateUi?.(task.id, { color })}
                    onKeyDown={onGridKeyDown}
                    data-cell
                    data-row={index}
                    data-col={4}
                    className={cn(
                      'h-4 w-4 rounded-full border border-border',
                      COLOR_CLASSES[color].dot,
                      colorKey === color && 'ring-2 ring-foreground/20'
                    )}
                    title={`Set color ${color}`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => onOpenDetails?.(task)}
          onKeyDown={onGridKeyDown}
          data-cell
          data-row={index}
          data-col={5}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
          title="Open details"
        >
          <MessageSquare className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}
