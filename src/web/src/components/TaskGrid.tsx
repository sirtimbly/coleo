import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react';
import { LoaderCircle, Plus } from 'lucide-react';
import { Button, Card } from '@heroui/react';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DragStartEvent, DragEndEvent, DragOverEvent } from '@dnd-kit/core';
import { type Task } from '@/lib';
import { cn } from '@/lib';
import { TASK_GRID_COLUMNS_CLASS, TaskGridRow, type TaskUiMeta, type TaskUpdate } from './TaskGridRow';
import { FilterableGridHeader, SortableGridHeader, type GridFilterOption } from './GridColumnHeader';
import { useGridPreferences } from './grid-preferences';
import { selectedTagsFilter, selectedValuesFilter } from './grid-table';
import { PRIORITY_OPTIONS, STATUS_LABELS } from './task-styles';

const TASK_STATUS_OPTIONS = Object.keys(STATUS_LABELS) as Task['status'][];
const TASK_SOURCE_OPTIONS: Task['sourceType'][] = ['manual', 'plan', 'email', 'discovery', 'proposal', 'system'];
const TASK_GRID_COLUMN_IDS = new Set(['order', 'subject', 'createdAt', 'status', 'priority', 'sourceType', 'tags']);
const TASK_GRID_DEFAULT_SORTING: SortingState = [{ id: 'order', desc: false }];
const TASK_GRID_PREFERENCES_KEY = 'coleo:tasks-grid-preferences';

const TASK_COLUMNS: ColumnDef<Task>[] = [
  {
    id: 'order',
    accessorFn: (_task, index) => index,
    sortingFn: 'basic',
  },
  {
    id: 'subject',
    accessorKey: 'subject',
    sortingFn: 'alphanumeric',
  },
  {
    id: 'createdAt',
    accessorFn: (task) => new Date(task.createdAt).getTime(),
    sortingFn: 'basic',
  },
  {
    id: 'status',
    accessorKey: 'status',
    filterFn: selectedValuesFilter,
  },
  {
    id: 'priority',
    accessorKey: 'priority',
    filterFn: selectedValuesFilter,
  },
  {
    id: 'sourceType',
    accessorKey: 'sourceType',
    filterFn: selectedValuesFilter,
  },
  {
    id: 'tags',
    accessorFn: (task) => task.metadata.ui?.tags ?? [],
    filterFn: selectedTagsFilter,
  },
];

function labelGridValue(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function buildFilterOptions(values: readonly string[], rows: Task[], readValue: (task: Task) => string): GridFilterOption[] {
  return values.map((value) => ({
    value,
    label: labelGridValue(value),
    count: rows.filter((task) => readValue(task) === value).length,
  }));
}

interface TaskGridProps {
  tasks: Task[];
  totalTasks?: number;
  availableTags?: string[];
  selectedTaskId?: string;
  newTaskId?: string | null;
  onOpenDetails?: (task: Task) => void;
  onOpenDiscussions?: (task: Task) => void;
  onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
  onUpdateUi?: (taskId: string, updates: TaskUiMeta) => void;
  onDelete?: (task: Task) => void;
  onCreateTaskAt?: (index: number, subject: string) => void;
  onReorder?: (taskId: string, fromSortOrder: number, toSortOrder: number, prevTaskId?: string | null, nextTaskId?: string | null) => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void | Promise<unknown>;
  className?: string;
}

interface SortableTaskRowProps {
  task: Task;
  index: number;
  availableTags?: string[];
  isSelected?: boolean;
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
}

// Memoized sortable row to prevent unnecessary re-renders
const SortableTaskRow = memo(function SortableTaskRow({ 
  task, 
  index,
  availableTags,
  isSelected,
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
}: SortableTaskRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: !canReorder });

  const style = {
    transform: isDragging ? CSS.Transform.toString(transform) : undefined,
    transition: isDragging ? transition : undefined,
    zIndex: isDragging ? 10 : 1,
    position: 'relative' as const,
  };

  return (
    <div ref={setNodeRef} style={style} className={cn('relative', isDragging && 'opacity-50')}>
      <TaskGridRow
        task={task}
        index={index}
        availableTags={availableTags ?? []}
        isSelected={isSelected}
        isDragging={isDragging}
        isExpanded={isExpanded}
        orderNumber={orderNumber}
        canReorder={canReorder}
        onToggleExpanded={onToggleExpanded}
        onOpenDetails={onOpenDetails}
        onOpenDiscussions={onOpenDiscussions}
        onUpdateTask={onUpdateTask}
        onUpdateUi={onUpdateUi}
        onDelete={onDelete}
        onReorderToSortOrder={onReorderToSortOrder}
        dragHandleProps={canReorder ? { ...attributes, ...listeners } : undefined}
      />
    </div>
  );
});

const InsertRow = memo(function InsertRow({
  onClick,
  isActive,
}: {
  onClick: (e: React.MouseEvent) => void;
  isActive: boolean;
}) {
  return (
    <button 
      type="button"
      className="h-2 relative group cursor-pointer w-full"
      onClick={onClick}
    >
      <div className={cn(
        'absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 bg-success rounded-full opacity-0 transition-opacity',
        (isActive ? 'opacity-100' : 'group-hover:opacity-100')
      )} />
      <div className={cn(
        'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 opacity-0 transition-opacity',
        (isActive ? 'opacity-100' : 'group-hover:opacity-100')
      )}>
        <div className="bg-success text-success-foreground rounded-full p-1 shadow-sm">
          <Plus className="h-3 w-3" />
        </div>
      </div>
    </button>
  );
});

export function TaskGrid({
  tasks,
  totalTasks,
  availableTags,
  selectedTaskId,
  newTaskId,
  onOpenDetails,
  onOpenDiscussions,
  onUpdateTask,
  onUpdateUi,
  onDelete,
  onCreateTaskAt,
  onReorder,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  className,
}: TaskGridProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [draftPosition, setDraftPosition] = useState<{ top: number; left: number } | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const { sorting, columnFilters, setSorting, setColumnFilters } = useGridPreferences(
    TASK_GRID_PREFERENCES_KEY,
    TASK_GRID_COLUMN_IDS,
    TASK_GRID_DEFAULT_SORTING,
  );
  const draftRef = useRef<HTMLInputElement>(null);
  const hoverIndexRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // TanStack Table intentionally exposes non-memoizable callbacks; React Compiler safely skips this component.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: tasks,
    columns: TASK_COLUMNS,
    getRowId: (task) => task.id,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const statusOptions = useMemo(
    () => buildFilterOptions(TASK_STATUS_OPTIONS, tasks, (task) => task.status),
    [tasks],
  );
  const priorityOptions = useMemo(
    () => buildFilterOptions(PRIORITY_OPTIONS, tasks, (task) => task.priority),
    [tasks],
  );
  const sourceOptions = useMemo(
    () => buildFilterOptions(TASK_SOURCE_OPTIONS, tasks, (task) => task.sourceType),
    [tasks],
  );
  const tagOptions = useMemo(() => {
    const tags = availableTags ?? [];
    return tags.map((tag) => ({
      value: tag,
      label: tag,
      count: tasks.filter((task) => task.metadata.ui?.tags?.includes(tag)).length,
    }));
  }, [availableTags, tasks]);

  const displayRows = table.getRowModel().rows;
  const hasActiveFilters = columnFilters.length > 0;
  const hasCanonicalSorting =
    sorting.length === 0 || (sorting.length === 1 && sorting[0]?.id === 'order' && sorting[0].desc === false);
  const canReorder = !hasActiveFilters && hasCanonicalSorting;
  const virtualItemCount = displayRows.length > 0 || hasNextPage ? displayRows.length + 1 : 0;
  const rowVirtualizer = useVirtualizer({
    count: virtualItemCount,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => index < displayRows.length ? 56 : 48,
    getItemKey: (index) => displayRows[index]?.id ?? 'task-grid-end',
    overscan: 10,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVirtualIndex = virtualItems.at(-1)?.index ?? -1;

  const handleToggleExpanded = useCallback((taskId: string) => {
    setExpandedTaskId((current) => current === taskId ? null : taskId);
  }, []);

  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      lastVirtualIndex >= Math.max(0, displayRows.length - 10)
    ) {
      void onLoadMore?.();
    }
  }, [displayRows.length, hasNextPage, isFetchingNextPage, lastVirtualIndex, onLoadMore]);

  // Scroll to newly created task
  useEffect(() => {
    if (!newTaskId) return;
    const newTaskIndex = displayRows.findIndex((row) => row.id === newTaskId);
    if (newTaskIndex >= 0) {
      rowVirtualizer.scrollToIndex(newTaskIndex, { align: 'center', behavior: 'smooth' });
    }
  }, [displayRows, newTaskId, rowVirtualizer]);

  // Memoize task lookup map for O(1) access
  const taskMap = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const taskIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    tasks.forEach((task, index) => {
      map.set(task.id, index);
    });
    return map;
  }, [tasks]);

  // Memoize task IDs for SortableContext
  const taskIds = displayRows.map((row) => row.id);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleSubmitDraft = () => {
    const next = draftRef.current?.value.trim();
    if (!next || draftIndex === null) return;
    onCreateTaskAt?.(draftIndex, next);
    if (draftRef.current) draftRef.current.value = '';
    setDraftIndex(null);
  };

  const handleDragStart = useCallback((event: DragStartEvent) => {
    if (!canReorder) return;
    setActiveId(event.active.id as string);
    setHoverIndex(null);
    hoverIndexRef.current = null;
  }, [canReorder]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!canReorder) return;
    const { over } = event;
    if (!over) return;

    const overId = over.id as string;
    const overIndex = taskIndexMap.get(overId) ?? null;

    if (overIndex !== null && overIndex !== hoverIndexRef.current) {
      hoverIndexRef.current = overIndex;
      setHoverIndex(overIndex);
    }
  }, [canReorder, taskIndexMap]);

  useEffect(() => {
    if (draftIndex !== null) {
      draftRef.current?.focus();
    }
  }, [draftIndex]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
	if (!canReorder) return;
    const { active, over } = event;
    
    // Capture the hover index BEFORE resetting the ref
    const hoverIndexAtDrop = hoverIndexRef.current;
    
    setActiveId(null);
    setHoverIndex(null);
    hoverIndexRef.current = null;

    if (!over) {
      return;
    }

    // Find the dragged task
    const draggedTask = tasks.find(t => t.id === active.id);
    if (!draggedTask) return;

    const fromSortOrder = taskIndexMap.get(draggedTask.id) ?? 0;
    
    const finalIndex = hoverIndexAtDrop ?? taskIndexMap.get(over.id as string) ?? null;
    if (finalIndex === null) return;

    // Get neighbor tasks for reliable positioning
    // prevTask = task before the drop position, nextTask = task after the drop position
    let prevTaskId: string | null = null;
    let nextTaskId: string | null = null;
    
    if (finalIndex > 0) {
      // The task at finalIndex-1 is the previous task
      prevTaskId = tasks[finalIndex - 1]?.id ?? null;
    }
    if (finalIndex < tasks.length) {
      // The task at finalIndex is the next task (or the task we dragged over)
      nextTaskId = tasks[finalIndex]?.id ?? null;
    }
    
    // If dragging to the end, there's no next task
    if (finalIndex >= tasks.length) {
      nextTaskId = null;
    }
    
    // The toSortOrder should be the visual index position
    const toSortOrder = finalIndex;
    
    if (fromSortOrder !== toSortOrder) {
      onReorder?.(draggedTask.id, fromSortOrder, toSortOrder, prevTaskId, nextTaskId);
    }
  }, [canReorder, tasks, onReorder, taskIndexMap]);

  const handleReorderToSortOrder = useCallback((taskId: string, fromSortOrder: number, toSortOrder: number) => {
    if (fromSortOrder === toSortOrder) return;
    
    // Handle special case: -1 means "move to bottom"
    const taskCount = totalTasks ?? tasks.length;
    let actualToSortOrder = toSortOrder;
    if (toSortOrder === -1) {
      actualToSortOrder = Math.max(0, taskCount - 1);
    }
    
    // Find the target index in the current tasks array
    const targetIndex = Math.min(actualToSortOrder, tasks.length);
    
    // Get neighbor task IDs for reliable positioning
    let prevTaskId: string | null = null;
    let nextTaskId: string | null = null;
    
    if (targetIndex > 0) {
      prevTaskId = tasks[targetIndex - 1]?.id ?? null;
    }
    if (targetIndex < tasks.length) {
      nextTaskId = tasks[targetIndex]?.id ?? null;
    }
    
    onReorder?.(taskId, fromSortOrder, actualToSortOrder, prevTaskId, nextTaskId);
  }, [onReorder, tasks, totalTasks]);

  const activeTask = activeId ? taskMap.get(activeId) : null;

  const dropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: '0.5',
        },
      },
    }),
  };

  const sortableItems = taskIds;

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-x-auto rounded-md border border-border bg-card', className)}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div
          className={cn(
            "mx-2 grid min-w-[1396px] items-center gap-2 border-b border-border px-3 py-2.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground",
            TASK_GRID_COLUMNS_CLASS,
          )}
        >
          <div aria-hidden="true" />
          <SortableGridHeader
            label="Order"
            column={table.getColumn('order')!}
            className="justify-end"
          />
          <div aria-hidden="true" />
          <SortableGridHeader label="Subject" column={table.getColumn('subject')!} />
          <SortableGridHeader label="Created" column={table.getColumn('createdAt')!} />
          <FilterableGridHeader
            label="Status"
            column={table.getColumn('status')!}
            options={statusOptions}
          />
          <div>Progress</div>
          <FilterableGridHeader
            label="Priority"
            column={table.getColumn('priority')!}
            options={priorityOptions}
          />
          <FilterableGridHeader
            label="Type"
            column={table.getColumn('sourceType')!}
            options={sourceOptions}
          />
          <FilterableGridHeader
            label="Tags"
            column={table.getColumn('tags')!}
            options={tagOptions}
          />
          <div className="border-l border-border/60 pl-3 text-right">Actions</div>
        </div>
        <div ref={containerRef} className="min-h-0 min-w-[1396px] flex-1 overflow-y-auto overflow-x-hidden p-2">
          {displayRows.length === 0 && !hasNextPage ? (
            <div className="p-6 text-center text-muted-foreground text-sm">
              {tasks.length > 0 ? 'No tasks match the selected column filters' : 'No tasks found'}
            </div>
          ) : (
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              <div
                className="relative w-full"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {virtualItems.map((virtualRow) => {
                  if (virtualRow.index >= displayRows.length) {
                    return (
                      <div
                        key="task-grid-end"
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        className="absolute left-0 top-0 w-full"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                        {hasNextPage ? (
                          <div className="flex h-12 items-center justify-center gap-2 text-xs text-muted-foreground">
                            <LoaderCircle className={cn('h-4 w-4', isFetchingNextPage && 'animate-spin')} />
                            {isFetchingNextPage ? 'Loading more tasks...' : 'Loading more tasks'}
                          </div>
                        ) : (
                          <InsertRow
                            isActive={activeId !== null && hoverIndex === displayRows.length}
                            onClick={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              setDraftPosition({ top: rect.top, left: rect.left });
                              setDraftIndex(displayRows.length);
                            }}
                          />
                        )}
                      </div>
                    );
                  }

                  const row = displayRows[virtualRow.index];
                  const task = row.original;
                  return (
                    <div
                      key={task.id}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="absolute left-0 top-0 w-full"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <InsertRow
                        isActive={activeId !== null && hoverIndex === virtualRow.index}
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setDraftPosition({ top: rect.top, left: rect.left });
                          setDraftIndex(virtualRow.index);
                        }}
                      />
                      <SortableTaskRow
                        task={task}
                        index={virtualRow.index}
                        orderNumber={row.index + 1}
                        canReorder={canReorder}
                        onToggleExpanded={handleToggleExpanded}
                        availableTags={availableTags}
                        isSelected={task.id === selectedTaskId}
                        isExpanded={expandedTaskId === task.id}
                        onOpenDetails={onOpenDetails}
                        onOpenDiscussions={onOpenDiscussions}
                        onUpdateTask={onUpdateTask}
                        onUpdateUi={onUpdateUi}
                        onDelete={onDelete}
                        onReorderToSortOrder={handleReorderToSortOrder}
                      />
                    </div>
                  );
                })}
              </div>
            </SortableContext>
          )}
        </div>
        <DragOverlay dropAnimation={dropAnimation}>
          {activeTask && (
            <div className="opacity-75">
              <TaskGridRow
                task={activeTask}
                index={0}
                orderNumber={(taskIndexMap.get(activeTask.id) ?? 0) + 1}
                canReorder={canReorder}
                onToggleExpanded={handleToggleExpanded}
                availableTags={availableTags ?? []}
                isExpanded={false}
                onOpenDetails={onOpenDetails}
                onUpdateTask={onUpdateTask}
                onUpdateUi={onUpdateUi}
                onDelete={onDelete}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {draftIndex !== null && draftPosition && (
        <Card 
          className="pointer-events-auto absolute left-0 right-0 z-20 mx-4 grid grid-cols-[minmax(0,1fr)_196px] gap-3 rounded-md border border-accent bg-background px-3 py-2 shadow-md"
          style={{ 
            top: `${draftPosition.top}px`,
          }}
        >
          <input
            ref={draftRef}
            defaultValue=""
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSubmitDraft();
              if (event.key === 'Escape') {
                if (draftRef.current) draftRef.current.value = '';
                setDraftIndex(null);
              }
            }}
            placeholder="New task"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="text-right">
            <Button
              variant="primary"
              onClick={handleSubmitDraft}
              className="mr-1"
            >
              Create
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (draftRef.current) draftRef.current.value = '';
                setDraftIndex(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
