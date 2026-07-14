import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react';
import { Plus, Maximize2, Minimize2 } from 'lucide-react';
import { Button, Card } from '@heroui/react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DragStartEvent, DragEndEvent, DragOverEvent } from '@dnd-kit/core';
import { type Bug } from '@/lib';
import { cn } from '@/lib';
import { BUG_GRID_COLUMNS_CLASS, BugGridRow, type BugUiMeta, type BugUpdate } from './BugGridRow';

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
    transform: isDragging ? CSS.Transform.toString(transform) : undefined,
    transition: isDragging ? transition : undefined,
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const draftRef = useRef<HTMLInputElement>(null);
  const hoverIndexRef = useRef<number | null>(null);

  // Memoize bug lookup map for O(1) access
  const bugMap = useMemo(() => {
    const map = new Map<string, Bug>();
    for (const bug of bugs) {
      map.set(bug.id, bug);
    }
    return map;
  }, [bugs]);

  const bugIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    bugs.forEach((bug, index) => {
      map.set(bug.id, index);
    });
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
    setActiveId(event.active.id as string);
    setHoverIndex(null);
    hoverIndexRef.current = null;
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) return;

    const overId = over.id as string;
    const overIndex = bugIndexMap.get(overId) ?? null;

    if (overIndex !== null && overIndex !== hoverIndexRef.current) {
      hoverIndexRef.current = overIndex;
      setHoverIndex(overIndex);
    }
  }, [bugIndexMap]);

  useEffect(() => {
    if (draftIndex !== null) {
      draftRef.current?.focus();
    }
  }, [draftIndex]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setHoverIndex(null);
    hoverIndexRef.current = null;

    if (!over) {
      return;
    }

    // Find the dragged bug
    const draggedBug = bugs.find(t => t.id === active.id);
    if (!draggedBug) return;

    // Bugs don't have sortOrder yet, use index
    const fromSortOrder = bugIndexMap.get(active.id as string) ?? 0;
    
    const finalIndex = hoverIndexRef.current ?? bugIndexMap.get(over.id as string) ?? null;
    if (finalIndex === null) return;

    // The toSortOrder should be the visual index position
    const toSortOrder = finalIndex;
    
    if (fromSortOrder !== toSortOrder) {
      onReorder?.(draggedBug.id, fromSortOrder, toSortOrder);
    }
  }, [bugs, onReorder, bugIndexMap]);

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

  const displayBugs = bugs;
  const sortableItems = bugIds;

  return (
    <div className={cn('overflow-x-auto rounded-md border border-border bg-card', className)}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className={cn(
          'mx-2 grid min-w-[860px] items-center gap-3 border-b border-border px-3 py-3 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground',
          BUG_GRID_COLUMNS_CLASS,
        )}>
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
        <div className="flex-1 overflow-y-auto p-2">
          {displayBugs.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm">No bugs found</div>
          ) : (
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              {displayBugs.map((bug, index) => (
                <div key={bug.id} className="relative -mt-2">
                   <InsertRow
                     isActive={activeId !== null && hoverIndex === index}
                     onClick={(e) => {
                       const rect = e.currentTarget.getBoundingClientRect();
                       setDraftPosition({ top: rect.top, left: rect.left });
                       setDraftIndex(index);
                     }}
                   />
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
               <InsertRow
                 isActive={activeId !== null && hoverIndex === displayBugs.length}
                 onClick={(e) => {
                   const rect = e.currentTarget.getBoundingClientRect();
                   setDraftPosition({ top: rect.top, left: rect.left });
                   setDraftIndex(displayBugs.length);
                 }}
               />
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
            placeholder="New bug"
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
