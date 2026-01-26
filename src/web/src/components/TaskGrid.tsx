import { Fragment, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { type Task } from '@/lib/api';
import { cn } from '@/lib';
import { TaskGridRow, type TaskUiMeta, type TaskUpdate } from './TaskGridRow';

interface TaskGridProps {
  tasks: Task[];
  availableTags?: string[];
  selectedTaskId?: string;
  onOpenDetails?: (task: Task) => void;
  onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
  onUpdateUi?: (taskId: string, updates: TaskUiMeta) => void;
  onCreateTaskAt?: (index: number, subject: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  className?: string;
}

export function TaskGrid({
  tasks,
  availableTags,
  selectedTaskId,
  onOpenDetails,
  onUpdateTask,
  onUpdateUi,
  onCreateTaskAt,
  onReorder,
  className,
}: TaskGridProps) {
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [draftSubject, setDraftSubject] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const draftRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (draftIndex !== null) {
      draftRef.current?.focus();
    }
  }, [draftIndex]);

  const handleSubmitDraft = () => {
    const next = draftSubject.trim();
    if (!next || draftIndex === null) return;
    onCreateTaskAt?.(draftIndex, next);
    setDraftSubject('');
    setDraftIndex(null);
  };

  const handleReorder = (from: number, to: number) => {
    if (from === to) return;
    onReorder?.(from, to);
  };

  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const key = event.key.toLowerCase();
    const moveKeys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
    if (!moveKeys.includes(key)) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable
    ) {
      return;
    }
    const cell = target.closest('[data-cell]') as HTMLElement | null;
    if (!cell) return;

    const row = Number(cell.getAttribute('data-row'));
    const col = Number(cell.getAttribute('data-col'));
    if (Number.isNaN(row) || Number.isNaN(col)) return;

    let nextRow = row;
    let nextCol = col;

    if (key === 'arrowup' || key === 'k') nextRow -= 1;
    if (key === 'arrowdown' || key === 'j') nextRow += 1;
    if (key === 'arrowleft' || key === 'h') nextCol -= 1;
    if (key === 'arrowright' || key === 'l') nextCol += 1;

    const next = gridRef.current?.querySelector<HTMLElement>(
      `[data-row="${nextRow}"][data-col="${nextCol}"]`
    );
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const renderInsertRow = (index: number) => (
    <li key={`insert-${index}`} className="group relative h-6">
      <div className="absolute inset-x-3 top-1/2 h-px bg-border/60" />
      <div className="absolute inset-0 flex items-center justify-center">
        <button
          type="button"
          onClick={() => setDraftIndex(index)}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full bg-background border border-border text-muted-foreground hover:text-foreground"
          title="Insert row"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
      {draftIndex === index && (
        <div className="grid grid-cols-[24px_2.2fr_1fr_1fr_1.4fr_200px] items-center gap-3 px-3 py-2 text-xs text-muted-foreground border-b border-border/60 bg-background">
          <div className="text-muted-foreground">+</div>
          <input
            ref={draftRef}
            value={draftSubject}
            onChange={(event) => setDraftSubject(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSubmitDraft();
              if (event.key === 'Escape') {
                setDraftSubject('');
                setDraftIndex(null);
              }
            }}
            placeholder="New task"
            className="col-span-3 bg-background border border-border rounded px-2 py-1 text-sm"
          />
          <div className="text-right">
            <button
              type="button"
              onClick={handleSubmitDraft}
              className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </li>
  );

  return (
    <div className={cn('border border-border rounded-lg bg-card overflow-hidden', className)}>
      <div className="grid grid-cols-[24px_2.2fr_1fr_1fr_1.4fr_200px] items-center gap-3 p-3 text-xs font-semibold text-muted-foreground border-b border-border bg-muted/50">
        <div />
        <div>Subject</div>
        <div>Status</div>
        <div>Priority</div>
        <div>Tags</div>
        <div className="text-right">Actions</div>
      </div>
      <div ref={gridRef} className="max-h-[600px] overflow-y-auto">
        {tasks.length === 0 ? (
          <ul className="divide-y divide-border/60 list-none">
            {renderInsertRow(0)}
            <li className="p-6 text-center text-muted-foreground text-sm">No tasks found</li>
          </ul>
        ) : (
          <ul className="divide-y divide-border/60 list-none">
            {tasks.map((task, index) => (
              <Fragment key={task.id}>
                {renderInsertRow(index)}
                <TaskGridRow
                  task={task}
                  index={index}
                  availableTags={availableTags ?? []}
                  isSelected={task.id === selectedTaskId}
                  onOpenDetails={onOpenDetails}
                  onUpdateTask={onUpdateTask}
                  onUpdateUi={onUpdateUi}
                  onDragStart={(idx) => setDragIndex(idx)}
                  onDragOver={() => undefined}
                  onDrop={(idx) => {
                    if (dragIndex !== null) handleReorder(dragIndex, idx);
                    setDragIndex(null);
                  }}
                  onGridKeyDown={handleGridKeyDown}
                />
              </Fragment>
            ))}
            {renderInsertRow(tasks.length)}
          </ul>
        )}
      </div>
    </div>
  );
}
