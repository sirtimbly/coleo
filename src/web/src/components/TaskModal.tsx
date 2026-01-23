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
}

type TaskStatus = Task['status'];
type TaskPriority = Task['priority'];
type TaskSourceType = Task['sourceType'];

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'claimed', label: 'Claimed' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
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

// NOTE: Domain functionality is temporarily disabled
// Common domains - kept for future use
// const DOMAIN_SUGGESTIONS = ['backend', 'frontend', 'testing', 'devops', 'docs', 'design', 'security'];

export function TaskModal({ isOpen, onClose, onSaved, task }: TaskModalProps) {
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
        setStatus(task.status);
        setDomain(task.domain || '');
        setPhase(task.phase || '');
        setSourceType(task.sourceType);
        setSourceRef(task.sourceRef || '');
        setDueDate(task.dueDate ? task.dueDate.slice(0, 10) : '');
      } else {
        // Reset for new task
        setSubject('');
        setDescription('');
        setPriority('normal');
        setStatus('pending');
        setDomain('');
        setPhase('');
        setSourceType('manual');
        setSourceRef('');
        setDueDate('');
      }
      setError(null);
      setTimeout(() => subjectRef.current?.focus(), 100);
    }
  }, [isOpen, task]);

  // Handle escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
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
        });
        savedTask = result.task;
      } else {
        const result = await api.createTask({
          subject: subject.trim(),
          description: description.trim(),
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

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-full max-w-2xl mx-4 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 className="text-lg font-semibold text-white">
            {isEditing ? 'Edit Task' : 'New Task'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-white rounded transition-colors"
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
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
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
                    onChange={(e) => setStatus(e.target.value as TaskStatus)}
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
                    onChange={(e) => setSourceType(e.target.value as TaskSourceType)}
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
            
            {/* Phase (domain field hidden for now) */}
            <div className="grid grid-cols-2 gap-4">
              {/* Domain field - temporarily hidden
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  Domain
                </label>
                <input
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  onKeyDown={handleKeyDown}
                  list="domain-suggestions"
                  placeholder="e.g., backend, frontend"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                />
                <datalist id="domain-suggestions">
                  {DOMAIN_SUGGESTIONS.map(d => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              </div>
              */}
              
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
    </div>,
    document.body
  );
}
