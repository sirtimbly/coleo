import { useState, useCallback, useRef, useEffect } from 'react';
import { Plus, Maximize2, Minimize2 } from 'lucide-react';
import { Button, Card } from '@heroui/react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DragStartEvent, DragEndEvent, DragOverEvent } from '@dnd-kit/core';
import { api, type Task } from '@/lib';
import { cn } from '@/lib';
import { TaskGridRow, type TaskUiMeta, type TaskUpdate } from './TaskGridRow';

interface TaskGridProps {
  tasks: Task[];
  availableTags?: string[];
  selectedTaskId?: string;
  onOpenDetails?: (task: Task) => void;
  onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
  onUpdateUi?: (taskId: string, updates: TaskUiMeta) => void;
  onDelete?: (task: Task) => void;
  onCreateTaskAt?: (index: number, subject: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  className?: string;
}

function SortableTaskRow({ 
  task, 
  index,
  availableTags,
  isSelected,
  isExpanded,
  onOpenDetails,
  onUpdateTask,
  onUpdateUi,
  onDelete,
  onReorderToIndex,
}: {
  task: Task;
  index: number;
  availableTags?: string[];
  isSelected?: boolean;
  isExpanded?: boolean;
  onOpenDetails?: (task: Task) => void;
  onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
  onUpdateUi?: (taskId: string, updates: TaskUiMeta) => void;
  onDelete?: (task: Task) => void;
  onReorderToIndex?: (fromIndex: number, toIndex: number) => void;
}) {
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
        onUpdateTask={onUpdateTask}
        onUpdateUi={onUpdateUi}
        onDelete={onDelete}
        onReorderToIndex={onReorderToIndex}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

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
  availableTags,
  selectedTaskId,
  onOpenDetails,
  onUpdateTask,
  onUpdateUi,
  onDelete,
  onCreateTaskAt,
  onReorder,
  className,
}: TaskGridProps) {
  const [items, setItems] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [draftPosition, setDraftPosition] = useState<{ top: number; left: number } | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const draftRef = useRef<HTMLInputElement>(null);

  // Sync items when tasks change (only on mount or when tasks are reloaded)
  useEffect(() => {
    if (tasks.length > 0 && items.length === 0) {
      setItems(tasks.map(t => t.id));
    }
  }, [tasks.length]);

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
    setActiveId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeIndex = items.indexOf(active.id as string);
    const overIndex = items.indexOf(over.id as string);

    if (activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex) {
      setItems((items) => arrayMove(items, activeIndex, overIndex));
    }
  }, [items]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) return;

    const fromIndex = items.indexOf(active.id as string);
    const toIndex = items.indexOf(over.id as string);

    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
      // Update local state
      onReorder?.(fromIndex, toIndex);
      
      // Persist to server
      const taskId = tasks[fromIndex]?.id;
      if (taskId) {
        api.reorderTask(taskId, toIndex).catch((err) => {
          console.error('Failed to reorder task:', err);
          window.location.reload();
        });
      }
    }
  }, [items, onReorder, tasks]);

  const handleReorderToIndex = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const taskId = tasks[fromIndex]?.id;
    if (!taskId) return;
    
    const targetIndex = toIndex < 0 ? tasks.length - 1 : Math.min(toIndex, tasks.length - 1);
    
    // Update local state
    setItems((items) => arrayMove(items, fromIndex, targetIndex));
    onReorder?.(fromIndex, targetIndex);
    
    // Persist to server
    api.reorderTask(taskId, targetIndex).catch((err) => {
      console.error('Failed to reorder task:', err);
      window.location.reload();
    });
  }, [onReorder, tasks]);

  const activeTask = activeId ? tasks.find(t => t.id === activeId) : null;

  const dropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: '0.5',
        },
      },
    }),
  };

  return (
    <div className={cn('border border-border rounded-lg bg-card overflow-hidden', className)}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-[24px_minmax(0,1fr)_96px_110px_160px_48px_48px_48px] items-center gap-3 p-3 text-xs font-semibold text-muted-foreground border-b border-border bg-muted/50">
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
        <div className="max-h-[600px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm">No tasks found</div>
          ) : (
            <SortableContext items={items} strategy={verticalListSortingStrategy}>
              {items.map((taskId, index) => {
                const task = tasks.find(t => t.id === taskId);
                if (!task) return null;
                return (
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
                      onUpdateTask={onUpdateTask}
                      onUpdateUi={onUpdateUi}
                      onDelete={onDelete}
                      onReorderToIndex={handleReorderToIndex}
                    />
                  </div>
                );
              })}
              <InsertRow onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDraftPosition({ top: rect.top, left: rect.left });
                  setDraftIndex(items.length);
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
          className="absolute z-20 left-0 right-0 mx-4 grid grid-cols-[minmax(0,1fr)_196px] gap-3 px-3 py-2 bg-background border border-primary rounded-lg shadow-lg pointer-events-auto"
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
            className="bg-default-100 border-0 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
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
