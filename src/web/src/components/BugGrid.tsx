import { useState, useCallback, useRef, useMemo, memo } from 'react';
import { Plus, Maximize2, Minimize2 } from 'lucide-react';
import { Button, Card } from '@heroui/react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DragStartEvent, DragEndEvent, DragOverEvent } from '@dnd-kit/core';
import { type Bug } from '@/lib';
import { cn } from '@/lib';
import { BugGridRow, type BugUiMeta, type BugUpdate } from './BugGridRow';

interface BugGridProps {
  bugs: Bug[];
  totalBugs?: number;
  availableTags?: string[];
  selectedBugId?: string;
  onOpenDetails?: (bug: Bug) => void;
  onUpdateBug?: (bugId: string, updates: BugUpdate) => void;
  onUpdateUi?: (bugId: string, updates: BugUiMeta) => void;
  onDelete?: (bug: Bug) => void;
  onCreateBugAt?: (index: number, title: string) => void;
  onReorder?: (bugId: string, fromSortOrder: number, toSortOrder: number) => void;
  className?: string;
}

interface SortableBugRowProps {
  bug: Bug;
  index: number;
  availableTags?: string[];
  isSelected?: boolean;
  isExpanded?: boolean;
  onOpenDetails?: (bug: Bug) => void;
  onUpdateBug?: (bugId: string, updates: BugUpdate) => void;
  onUpdateUi?: (bugId: string, updates: BugUiMeta) => void;
  onDelete?: (bug: Bug) => void;
  onReorderToSortOrder?: (bugId: string, fromSortOrder: number, toSortOrder: number) => void;
}

// Memoized sortable row to prevent unnecessary re-renders
const SortableBugRow = memo(function SortableBugRow({ 
  bug, 
  index,
  availableTags,
  isSelected,
  isExpanded,
  onOpenDetails,
  onUpdateBug,
  onUpdateUi,
  onDelete,
  onReorderToSortOrder,
}: SortableBugRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: bug.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
    position: 'relative' as const,
  };

  return (
    <div ref={setNodeRef} style={style} className={cn('relative', isDragging && 'opacity-50')}>
      <BugGridRow
        bug={bug}
        index={index}
        availableTags={availableTags ?? []}
        isSelected={isSelected}
        isDragging={isDragging}
        isExpanded={isExpanded}
        onOpenDetails={onOpenDetails}
        onUpdateBug={onUpdateBug}
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
    <button 
      type="button"
      className="h-2 relative group cursor-pointer w-full"
      onClick={onClick}
    >
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 bg-success rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="bg-success text-success-foreground rounded-full p-1 shadow-sm">
          <Plus className="h-3 w-3" />
        </div>
      </div>
    </button>
  );
}

export function BugGrid({
  bugs,
  totalBugs,
  availableTags,
  selectedBugId,
  onOpenDetails,
  onUpdateBug,
  onUpdateUi,
  onDelete,
  onCreateBugAt,
  onReorder,
  className,
}: BugGridProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [draftPosition, setDraftPosition] = useState<{ top: number; left: number } | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const draftRef = useRef<HTMLInputElement>(null);
  
  // Track drag order - use state to trigger re-renders, but throttle updates
  const [dragOrder, setDragOrder] = useState<string[]>([]);
  const isDraggingRef = useRef(false);
  const dragOverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Memoize bug lookup map for O(1) access
  const bugMap = useMemo(() => {
    const map = new Map<string, Bug>();
    for (const bug of bugs) {
      map.set(bug.id, bug);
    }
    return map;
  }, [bugs]);

  // Memoize bug IDs for SortableContext
  const bugIds = useMemo(() => bugs.map(t => t.id), [bugs]);

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
    onCreateBugAt?.(draftIndex, next);
    if (draftRef.current) draftRef.current.value = '';
    setDraftIndex(null);
  };

  const handleDragStart = useCallback((event: DragStartEvent) => {
    isDraggingRef.current = true;
    setActiveId(event.active.id as string);
    // Initialize dragOrder from current bugs
    setDragOrder(bugs.map(t => t.id));
  }, [bugs]);

  // Throttled drag over handler - only update every 50ms
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    
    // Clear any pending timeout
    if (dragOverTimeoutRef.current) {
      clearTimeout(dragOverTimeoutRef.current);
    }
    
    // Schedule update
    dragOverTimeoutRef.current = setTimeout(() => {
      setDragOrder(currentOrder => {
        const currentIds = currentOrder.length > 0 ? currentOrder : bugs.map(t => t.id);
        const activeIndex = currentIds.indexOf(activeId);
        const overIndex = currentIds.indexOf(overId);

        if (activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex) {
          return arrayMove(currentIds, activeIndex, overIndex);
        }
        return currentIds;
      });
      dragOverTimeoutRef.current = null;
    }, 50);
  }, [bugs]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    isDraggingRef.current = false;
    setActiveId(null);
    
    // Clear any pending timeout
    if (dragOverTimeoutRef.current) {
      clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }

    // Get the final order
    const finalOrder = dragOrder.length > 0 ? dragOrder : bugs.map(t => t.id);
    
    // Reset drag order
    setDragOrder([]);

    if (!over) {
      return;
    }

    // Find the dragged bug
    const draggedBug = bugs.find(t => t.id === active.id);
    if (!draggedBug) return;

    // Get the final index in the drag order (where the bug ended up visually)
    const finalIndex = finalOrder.indexOf(active.id as string);
    if (finalIndex === -1) return;

    // The toSortOrder should be the visual index position
    // This represents where we want the bug to be in the sorted list
    const toSortOrder = finalIndex;
    const fromSortOrder = finalOrder.indexOf(active.id as string);
    
    if (fromSortOrder !== toSortOrder) {
      onReorder?.(draggedBug.id, fromSortOrder, toSortOrder);
    }
  }, [bugs, dragOrder, onReorder]);

  const handleReorderToSortOrder = useCallback((bugId: string, fromSortOrder: number, toSortOrder: number) => {
    if (fromSortOrder === toSortOrder) return;
    
    // Handle special case: -1 means "move to bottom"
    const bugCount = totalBugs ?? bugs.length;
    let actualToSortOrder = toSortOrder;
    if (toSortOrder === -1) {
      actualToSortOrder = Math.max(0, bugCount - 1);
    }
    
    onReorder?.(bugId, fromSortOrder, actualToSortOrder);
  }, [onReorder, bugs, totalBugs]);

  const activeBug = activeId ? bugMap.get(activeId) : null;

  const dropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: '0.5',
        },
      },
    }),
  };

  // Determine which bugs to display
  const displayBugs = useMemo(() => {
    // During drag, use the drag order for visual feedback
    if (isDraggingRef.current && dragOrder.length > 0) {
      return dragOrder
        .map(id => bugMap.get(id))
        .filter((bug): bug is Bug => bug !== undefined);
    }
    // Otherwise use the actual bugs
    return bugs;
  }, [bugs, bugMap, dragOrder]);

  // Items for SortableContext - use dragOrder during drag
  const sortableItems = useMemo(() => {
    if (isDraggingRef.current && dragOrder.length > 0) {
      return dragOrder;
    }
    return bugIds;
  }, [bugIds, dragOrder]);

  return (
    <div className={cn('border border-border rounded-lg bg-card overflow-hidden', className)}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-[48px_24px_minmax(0,1fr)_96px_110px_110px_160px_48px_48px_48px] items-center gap-3 p-3 text-xs font-semibold text-muted-foreground border-b border-border bg-muted/50">
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
          <div>Title</div>
          <div>Status</div>
          <div>Priority</div>
          <div>Type</div>
          <div>Tags</div>
          <div className="text-right">Actions</div>
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {displayBugs.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm">No bugs found</div>
          ) : (
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              {displayBugs.map((bug, index) => (
                <div key={bug.id}>
                  <InsertRow onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDraftPosition({ top: rect.top, left: rect.left });
                    setDraftIndex(index);
                  }} />
                  <SortableBugRow
                    bug={bug}
                    index={index}
                    availableTags={availableTags}
                    isSelected={bug.id === selectedBugId}
                    isExpanded={isExpanded}
                    onOpenDetails={onOpenDetails}
                    onUpdateBug={onUpdateBug}
                    onUpdateUi={onUpdateUi}
                    onDelete={onDelete}
                    onReorderToSortOrder={handleReorderToSortOrder}
                  />
                </div>
              ))}
              <InsertRow onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDraftPosition({ top: rect.top, left: rect.left });
                  setDraftIndex(displayBugs.length);
                }} />
            </SortableContext>
          )}
        </div>
        <DragOverlay dropAnimation={dropAnimation}>
          {activeBug && (
            <div className="opacity-75">
              <BugGridRow
                bug={activeBug}
                index={0}
                availableTags={availableTags ?? []}
                isExpanded={isExpanded}
                onOpenDetails={onOpenDetails}
                onUpdateBug={onUpdateBug}
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
            placeholder="New bug"
            className="bg-default-100 border-0 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            // eslint-disable-next-line jsx-a11y/no-autofocus
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
