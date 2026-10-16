/**
 * TaskModal - Modal for creating/editing tasks
 */
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Save } from 'lucide-react';
import { api, type Task } from '@/lib/api';

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (task: Task) => void;
  task?: Task; // If provided, we're editing
  initialStatus?: Task['status'];
  presentation?: 'modal' | 'panel';
}

type TaskStatus = Task['status'];
type TaskPriority = Task['priority'];
type TaskSourceType = Task['sourceType'];

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'pending', label: 'Pending' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

const SOURCE_TYPE_OPTIONS: { value: TaskSourceType; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'plan', label: 'Plan' },
  { value: 'email', label: 'Email' },
  { value: 'discovery', label: 'Discovery' },
  { value: 'proposal', label: 'Proposal' },
];

const isTaskStatus = (value: string): value is TaskStatus =>
  STATUS_OPTIONS.some((option) => option.value === value);

const isTaskPriority = (value: string): value is TaskPriority =>
  PRIORITY_OPTIONS.some((option) => option.value === value);

const isTaskSourceType = (value: string): value is TaskSourceType =>
  SOURCE_TYPE_OPTIONS.some((option) => option.value === value);

const FIELD_CLASS = 'w-full border border-border bg-surface px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-1 focus:ring-accent/30';
const INPUT_CLASS = `${FIELD_CLASS} h-9`;
const TEXTAREA_CLASS = `${FIELD_CLASS} resize-none py-2`;
const LABEL_CLASS = 'mb-1.5 block text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground';

export function TaskModal({
  isOpen,
  onClose,
  onSaved,
  task,
  initialStatus,
  presentation = 'modal',
}: TaskModalProps) {
  const isEditing = Boolean(task);
  
  // Form state
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [status, setStatus] = useState<TaskStatus>('pending');
  const [domain, setDomain] = useState('');
  const [phase, setPhase] = useState('');
  const [sourceType, setSourceType] = useState<TaskSourceType>('manual');
  const [sourceRef, setSourceRef] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [blockedCategory, setBlockedCategory] = useState<NonNullable<Task['blockedCategory']>>('unknown');
  const [blockedNeedsHuman, setBlockedNeedsHuman] = useState(false);
  
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const subjectRef = useRef<HTMLInputElement>(null);

  // Initialize form when modal opens or task changes
  useEffect(() => {
    if (isOpen) {
      if (task) {
        setSubject(task.subject);
        setDescription(task.description);
        setPriority(task.priority);
        setStatus(initialStatus || task.status);
        setDomain(task.domain || '');
        setPhase(task.phase || '');
        setSourceType(task.sourceType);
        setSourceRef(task.sourceRef || '');
        setDueDate(task.dueDate ? task.dueDate.slice(0, 10) : '');
        setBlockedReason(task.blockedReason || '');
        setBlockedCategory(task.blockedCategory || 'unknown');
        setBlockedNeedsHuman(task.blockedNeedsHuman === true);
      } else {
        // Reset for new task
        setSubject('');
        setDescription('');
        setPriority('normal');
        setStatus(initialStatus ?? 'pending');
        setDomain('');
        setPhase('');
        setSourceType('manual');
        setSourceRef('');
        setDueDate('');
        setBlockedReason('');
        setBlockedCategory('unknown');
        setBlockedNeedsHuman(false);
      }
      setError(null);
      const focusTimeout = window.setTimeout(() => subjectRef.current?.focus(), 100);
      return () => window.clearTimeout(focusTimeout);
    }
  }, [initialStatus, isOpen, task]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!subject.trim()) {
      setError('Subject is required');
      return;
    }
    
    if (!description.trim()) {
      setError('Description is required');
      return;
    }

    if (isEditing && status === 'blocked' && !blockedReason.trim()) {
      setError('A concrete blocked reason is required');
      return;
    }
    
    setIsSaving(true);
    setError(null);
    
    try {
      let savedTask: Task;
      
      if (isEditing && task) {
        const result = await api.updateTask(task.id, {
          subject: subject.trim(),
          description: description.trim(),
          priority,
          status,
          domain: domain.trim() || undefined,
          phase: phase.trim() || undefined,
          dueDate: dueDate || null,
          ...(status === 'blocked' ? {
            blockedReason: blockedReason.trim(),
            blockedCategory,
            blockedNeedsHuman,
          } : {}),
        });
        savedTask = result.task;
      } else {
        const result = await api.createTask({
          subject: subject.trim(),
          description: description.trim(),
          status,
          priority,
          domain: domain.trim() || undefined,
          phase: phase.trim() || undefined,
          sourceType,
          sourceRef: sourceRef.trim() || undefined,
          dueDate: dueDate || undefined,
        });
        savedTask = result.task;
      }
      
      onSaved?.(savedTask);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Submit on Cmd/Ctrl + Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  if (!isOpen) return null;

  const content = (
    <div className={`flex w-full max-w-2xl flex-col overflow-hidden border border-border bg-background text-foreground ${
        presentation === 'panel'
          ? 'min-h-[min(42rem,100%)] shadow-md'
          : 'relative mx-4 max-h-[90vh] shadow-lg'
      }`}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
          <h2 className="text-lg font-semibold text-foreground">
            {isEditing ? 'Edit Task' : 'New Task'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={`Close ${isEditing ? 'edit task' : 'new task'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="space-y-4 p-4">
            {/* Subject */}
            <div>
              <label className={LABEL_CLASS}>
                Subject <span className="text-danger">*</span>
              </label>
              <input
                ref={subjectRef}
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Brief title for the task"
                className={INPUT_CLASS}
              />
            </div>
            
            {/* Description */}
            <div>
              <label className={LABEL_CLASS}>
                Description <span className="text-danger">*</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Detailed description of what needs to be done..."
                rows={4}
                className={TEXTAREA_CLASS}
              />
            </div>
            
            {/* Priority & Status (side by side) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>
                  Priority
                </label>
                <select
                  value={priority}
                  onChange={(e) => {
                    if (isTaskPriority(e.currentTarget.value)) {
                      setPriority(e.currentTarget.value);
                    }
                  }}
                  className={INPUT_CLASS}
                >
                  {PRIORITY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              
              {isEditing && (
                <div>
                  <label className={LABEL_CLASS}>
                    Status
                  </label>
                  <select
                    value={status}
                    onChange={(e) => {
                      if (isTaskStatus(e.currentTarget.value)) {
                        setStatus(e.currentTarget.value);
                      }
                    }}
                    className={INPUT_CLASS}
                  >
                    {STATUS_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              
              {!isEditing && (
                <div>
                  <label className={LABEL_CLASS}>
                    Source Type
                  </label>
                  <select
                    value={sourceType}
                    onChange={(e) => {
                      if (isTaskSourceType(e.currentTarget.value)) {
                        setSourceType(e.currentTarget.value);
                      }
                    }}
                    className={INPUT_CLASS}
                  >
                    {SOURCE_TYPE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {!isEditing ? (
              <label className="flex min-h-10 items-center gap-3 border border-border bg-surface px-3 py-2">
                <input
                  type="checkbox"
                  checked={status === 'draft'}
                  onChange={(event) => setStatus(event.currentTarget.checked ? 'draft' : 'pending')}
                  className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">Is Draft</span>
                  <span className="block text-xs text-muted-foreground">Keep this task out of the runnable queue.</span>
                </span>
              </label>
            ) : null}

            {isEditing && status === 'blocked' && (
              <div className="space-y-3 border border-warning/40 bg-warning/10 p-3">
                <div>
                  <label htmlFor="task-blocked-reason" className={LABEL_CLASS}>
                    Blocked reason <span className="text-danger">*</span>
                  </label>
                  <textarea
                    id="task-blocked-reason"
                    value={blockedReason}
                    onChange={(e) => setBlockedReason(e.target.value)}
                    placeholder="What specifically prevents this task from continuing?"
                    rows={3}
                    className={TEXTAREA_CLASS}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
                  <div>
                    <label htmlFor="task-blocked-category" className={LABEL_CLASS}>
                      Blocker category
                    </label>
                    <select
                      id="task-blocked-category"
                      value={blockedCategory}
                      onChange={(e) => setBlockedCategory(e.currentTarget.value as NonNullable<Task['blockedCategory']>)}
                      className={INPUT_CLASS}
                    >
                      <option value="dependency">Dependency</option>
                      <option value="bug">Bug</option>
                      <option value="file_claim">File claim</option>
                      <option value="environment">Environment</option>
                      <option value="human">Human decision</option>
                      <option value="arm">Arm/runtime</option>
                      <option value="unknown">Other</option>
                    </select>
                  </div>
                  <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={blockedNeedsHuman}
                      onChange={(e) => setBlockedNeedsHuman(e.currentTarget.checked)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    Needs a human response
                  </label>
                </div>
                <p className="text-xs leading-5 text-warning">
                  The brain will schedule an arm to recheck this blocker. A human reply in Discussions or by task email requeues the check immediately.
                </p>
              </div>
            )}
            
            {/* Phase */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>
                  Phase
                </label>
                <input
                  type="text"
                  value={phase}
                  onChange={(e) => setPhase(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g., mvp, v1, polish"
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            
            {/* Source Ref & Due Date (side by side) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {!isEditing && (
                <div>
                  <label className={LABEL_CLASS}>
                    Source Reference
                  </label>
                  <input
                    type="text"
                    value={sourceRef}
                    onChange={(e) => setSourceRef(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="e.g., issue #123, email ID"
                    className={INPUT_CLASS}
                  />
                </div>
              )}
              
              <div className={!isEditing ? '' : 'col-span-2'}>
                <label className={LABEL_CLASS}>
                  Due Date
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            
            {/* Error message */}
            {error && (
              <div className="border border-danger/30 bg-danger/10 p-3">
                <p className="text-sm text-danger">{error}</p>
              </div>
            )}
          </div>
          
          {/* Footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-4 py-3">
            <span className="text-xs text-muted-foreground">
              Press <kbd className="border border-border bg-surface-secondary px-1.5 py-0.5 text-foreground">Cmd</kbd>+<kbd className="border border-border bg-surface-secondary px-1.5 py-0.5 text-foreground">Enter</kbd> to save
            </span>
            
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving || !subject.trim() || !description.trim()}
                className="flex h-9 items-center gap-2 bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? (
                  <>Saving...</>
                ) : (
                  <>
                    {isEditing ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                    {isEditing ? 'Save Changes' : 'Create Task'}
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
    </div>
  );

  if (presentation === 'panel') {
    return (
      <div className="flex min-h-full w-full items-start justify-center bg-surface p-3 sm:p-5">
        {content}
      </div>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close task dialog"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      {content}
    </div>,
    document.body,
  );
}
