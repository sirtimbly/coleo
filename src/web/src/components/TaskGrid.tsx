import { useState, useCallback, useRef, useMemo, memo } from 'react';
import { Plus, Maximize2, Minimize2 } from 'lucide-react';
import { Button, Card } from '@heroui/react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DragStartEvent, DragEndEvent, DragOverEvent } from '@dnd-kit/core';
import { type Task } from '@/lib';
import { cn } from '@/lib';
import { TaskGridRow, type TaskUiMeta, type TaskUpdate } from './TaskGridRow';

interface TaskGridProps {
  tasks: Task[];
  totalTasks?: number;
  availableTags?: string[];
  selectedTaskId?: string;
  onOpenDetails?: (task: Task) => void;
  onOpenDiscussions?: (task: Task) => void;
  onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
  onUpdateUi?: (taskId: string, updates: TaskUiMeta) => void;
  onDelete?: (task: Task) => void;
  onCreateTaskAt?: (index: number, subject: string) => void;
  onReorder?: (taskId: string, fromSortOrder: number, toSortOrder: number) => void;
  className?: string;
}

interface SortableTaskRowProps {
  task: Task;
  index: number;
  availableTags?: string[];
  isSelected?: boolean;
  isExpanded?: boolean;
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
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
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
        onOpenDetails={onOpenDetails}
        onOpenDiscussions={onOpenDiscussions}
        onUpdateTask={onUpdateTask}
        onUpdateUi={onUpdateUi}
        onDelete={onDelete}
        onReorderToSortOrder={onReorderToSortOrder}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
});

function InsertRow({ 
  onClick 
}: { 
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <div 
      className="h-2 relative group cursor-pointer"
      onClick={onClick}
    >
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 bg-success rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="bg-success text-success-foreground rounded-full p-1 shadow-sm">
          <Plus className="h-3 w-3" />
        </div>
      </div>
    </div>
  );
}

export function TaskGrid({
  tasks,
  totalTasks,
  availableTags,
  selectedTaskId,
  onOpenDetails,
  onOpenDiscussions,
  onUpdateTask,
  onUpdateUi,
  onDelete,
  onCreateTaskAt,
  onReorder,
  className,
}: TaskGridProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [draftPosition, setDraftPosition] = useState<{ top: number; left: number } | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const draftRef = useRef<HTMLInputElement>(null);
  
  // Use a ref for drag order to avoid re-renders during drag
  const dragOrderRef = useRef<string[]>([]);
  const [dragVersion, setDragVersion] = useState(0); // Used to force re-render when needed
  const isDraggingRef = useRef(false);

  // Memoize task lookup map for O(1) access
  const taskMap = useMemo(() => {
    const map = new Map<string, Task>();
    tasks.forEach(task => map.set(task.id, task));
    return map;
  }, [tasks]);

  // Memoize task IDs for SortableContext
  const taskIds = useMemo(() => tasks.map(t => t.id), [tasks]);

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
    isDraggingRef.current = true;
    setActiveId(event.active.id as string);
    // Initialize dragOrder from current tasks
    dragOrderRef.current = tasks.map(t => t.id);
    setDragVersion(v => v + 1);
  }, [tasks]);

  // Use throttling for drag over to reduce re-renders
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    
    const activeIndex = dragOrderRef.current.indexOf(activeId);
    const overIndex = dragOrderRef.current.indexOf(overId);

    if (activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex) {
      dragOrderRef.current = arrayMove(dragOrderRef.current, activeIndex, overIndex);
      // Force re-render with new order
      setDragVersion(v => v + 1);
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    isDraggingRef.current = false;
    setActiveId(null);

    if (!over) {
      // Reset to original order if dropped outside
      dragOrderRef.current = tasks.map(t => t.id);
      setDragVersion(v => v + 1);
      return;
    }

    const fromTask = tasks.find(t => t.id === active.id);
    const toTask = tasks.find(t => t.id === over.id);

    if (fromTask && toTask) {
      const fromSortOrder = fromTask.sortOrder ?? 0;
      const toSortOrder = toTask.sortOrder ?? 0;
      if (fromSortOrder !== toSortOrder) {
        // Let parent handle the reorder (optimistic update happens in React Query)
        onReorder?.(fromTask.id, fromSortOrder, toSortOrder);
      }
    }
    
    // Reset drag order
    dragOrderRef.current = tasks.map(t => t.id);
    setDragVersion(v => v + 1);
  }, [tasks, onReorder]);

  const handleReorderToSortOrder = useCallback((taskId: string, fromSortOrder: number, toSortOrder: number) => {
    if (fromSortOrder === toSortOrder) return;
    
    // Handle special case: -1 means "move to bottom"
    // Use totalTasks if available, otherwise fall back to current tasks length
    let actualToSortOrder = toSortOrder;
    if (toSortOrder === -1) {
      // The last position is totalTasks - 1 (0-indexed)
      const taskCount = totalTasks ?? tasks.length;
      actualToSortOrder = Math.max(0, taskCount - 1);
    }
    
    // Let parent handle the reorder (optimistic update happens in React Query)
    onReorder?.(taskId, fromSortOrder, actualToSortOrder);
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

  // Memoize display tasks to prevent recalculation
  const displayTasks = useMemo(() => {
    if (!isDraggingRef.current || dragOrderRef.current.length === 0) {
      return tasks;
    }
    // Use dragOrder during drag for visual feedback
    return dragOrderRef.current
      .map(id => taskMap.get(id))
      .filter((task): task is Task => task !== undefined);
  }, [tasks, taskMap, dragVersion]);

  // Memoize the items for SortableContext
  const sortableItems = useMemo(() => {
    return isDraggingRef.current && dragOrderRef.current.length > 0 
      ? dragOrderRef.current 
      : taskIds;
  }, [taskIds, dragVersion]);

  return (
    <div className={cn('border border-border rounded-lg bg-card overflow-hidden', className)}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-[48px_24px_minmax(0,1fr)_96px_110px_160px_48px_48px_48px] items-center gap-3 p-3 text-xs font-semibold text-muted-foreground border-b border-border bg-muted/50">
          <div className="text-right pr-1">Order</div>
          <div className="flex items-center justify-end">
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="h-5 w-5"
              onPress={() => setIsExpanded(!isExpanded)}
              aria-label={isExpanded ? "Collapse rows" : "Expand rows"}
            >
              {isExpanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            </Button>
          </div>
          <div>Subject</div>
          <div>Status</div>
          <div>Priority</div>
          <div>Tags</div>
          <div className="text-right">Actions</div>
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {displayTasks.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm">No tasks found</div>
          ) : (
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              {displayTasks.map((task, index) => (
                <div key={task.id}>
                  <InsertRow onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDraftPosition({ top: rect.top, left: rect.left });
                    setDraftIndex(index);
                  }} />
                  <SortableTaskRow
                    task={task}
                    index={index}
                    availableTags={availableTags}
                    isSelected={task.id === selectedTaskId}
                    isExpanded={isExpanded}
                    onOpenDetails={onOpenDetails}
                    onOpenDiscussions={onOpenDiscussions}
                    onUpdateTask={onUpdateTask}
                    onUpdateUi={onUpdateUi}
                    onDelete={onDelete}
                    onReorderToSortOrder={handleReorderToSortOrder}
                  />
                </div>
              ))}
              <InsertRow onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDraftPosition({ top: rect.top, left: rect.left });
                  setDraftIndex(displayTasks.length);
                }} />
            </SortableContext>
          )}
        </div>
        <DragOverlay dropAnimation={dropAnimation}>
          {activeTask && (
            <div className="opacity-75">
              <TaskGridRow
                task={activeTask}
                index={0}
                availableTags={availableTags ?? []}
                isExpanded={isExpanded}
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
          className="absolute z-20 left-0 right-0 mx-4 grid grid-cols-[minmax(0,1fr)_196px] gap-3 px-3 py-2 bg-background border border-accent rounded-lg shadow-lg pointer-events-auto"
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
            className="bg-default-100 border-0 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            autoFocus
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
