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

const PRIORITY_OPTIONS: { value: TaskPriority; label: string; color: string }[] = [
  { value: 'critical', label: 'Critical', color: 'text-red-500' },
  { value: 'high', label: 'High', color: 'text-orange-500' },
  { value: 'normal', label: 'Normal', color: 'text-blue-500' },
  { value: 'low', label: 'Low', color: 'text-gray-500' },
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
  const [status, setStatus] = useState<TaskStatus>('draft');
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
        setStatus('draft');
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
    <div className={`flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 ${
        presentation === 'panel'
          ? 'min-h-[min(42rem,100%)] shadow-xl'
          : 'relative mx-4 max-h-[90vh] shadow-2xl'
      }`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 className="text-lg font-semibold text-white">
            {isEditing ? 'Edit Task' : 'New Task'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-white rounded transition-colors"
            aria-label={`Close ${isEditing ? 'edit task' : 'new task'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-4">
            {/* Subject */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Subject <span className="text-red-400">*</span>
              </label>
              <input
                ref={subjectRef}
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Brief title for the task"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
              />
            </div>
            
            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Description <span className="text-red-400">*</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Detailed description of what needs to be done..."
                rows={4}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 resize-none focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
              />
            </div>
            
            {/* Priority & Status (side by side) */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  Priority
                </label>
                <select
                  value={priority}
                  onChange={(e) => {
                    if (isTaskPriority(e.currentTarget.value)) {
                      setPriority(e.currentTarget.value);
                    }
                  }}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
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
                  <label className="block text-sm font-medium text-zinc-300 mb-1">
                    Status
                  </label>
                  <select
                    value={status}
                    onChange={(e) => {
                      if (isTaskStatus(e.currentTarget.value)) {
                        setStatus(e.currentTarget.value);
                      }
                    }}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
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
                  <label className="block text-sm font-medium text-zinc-300 mb-1">
                    Source Type
                  </label>
                  <select
                    value={sourceType}
                    onChange={(e) => {
                      if (isTaskSourceType(e.currentTarget.value)) {
                        setSourceType(e.currentTarget.value);
                      }
                    }}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
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

            {isEditing && status === 'blocked' && (
              <div className="rounded-lg border border-amber-700/60 bg-amber-950/25 p-3 space-y-3">
                <div>
                  <label htmlFor="task-blocked-reason" className="block text-sm font-medium text-amber-100 mb-1">
                    Blocked reason <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    id="task-blocked-reason"
                    value={blockedReason}
                    onChange={(e) => setBlockedReason(e.target.value)}
                    placeholder="What specifically prevents this task from continuing?"
                    rows={3}
                    className="w-full px-3 py-2 bg-zinc-800 border border-amber-700/60 rounded-lg text-white placeholder-zinc-500 resize-none focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
                  <div>
                    <label htmlFor="task-blocked-category" className="block text-sm font-medium text-zinc-300 mb-1">
                      Blocker category
                    </label>
                    <select
                      id="task-blocked-category"
                      value={blockedCategory}
                      onChange={(e) => setBlockedCategory(e.currentTarget.value as NonNullable<Task['blockedCategory']>)}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
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
                  <label className="flex min-h-10 items-center gap-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={blockedNeedsHuman}
                      onChange={(e) => setBlockedNeedsHuman(e.currentTarget.checked)}
                      className="h-4 w-4 rounded border-zinc-600 bg-zinc-800"
                    />
                    Needs a human response
                  </label>
                </div>
                <p className="text-xs leading-5 text-amber-200/75">
                  The brain will schedule an arm to recheck this blocker. A human reply in Discussions or by task email requeues the check immediately.
                </p>
              </div>
            )}
            
            {/* Phase */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  Phase
                </label>
                <input
                  type="text"
                  value={phase}
                  onChange={(e) => setPhase(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g., mvp, v1, polish"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                />
              </div>
            </div>
            
            {/* Source Ref & Due Date (side by side) */}
            <div className="grid grid-cols-2 gap-4">
              {!isEditing && (
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">
                    Source Reference
                  </label>
                  <input
                    type="text"
                    value={sourceRef}
                    onChange={(e) => setSourceRef(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="e.g., issue #123, email ID"
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                  />
                </div>
              )}
              
              <div className={!isEditing ? '' : 'col-span-2'}>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  Due Date
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                />
              </div>
            </div>
            
            {/* Error message */}
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
          </div>
          
          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-700 bg-zinc-800/50">
            <span className="text-xs text-zinc-500">
              Press <kbd className="px-1.5 py-0.5 bg-zinc-700 rounded text-zinc-300">Cmd</kbd>+<kbd className="px-1.5 py-0.5 bg-zinc-700 rounded text-zinc-300">Enter</kbd> to save
            </span>
            
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-zinc-400 hover:text-white rounded-lg font-medium text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving || !subject.trim() || !description.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg font-medium text-sm transition-colors disabled:cursor-not-allowed"
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
