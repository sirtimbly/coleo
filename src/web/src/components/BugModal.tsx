/**
 * BugModal - Modal for creating bugs
 */
import { useState, useEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus } from 'lucide-react';
import { api, type Bug } from '@/lib/api';

interface BugModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (bug: Bug) => void;
  presentation?: 'modal' | 'panel';
}

type BugSource = Bug['source'];
type BugPriority = Bug['priority'];

const SOURCE_OPTIONS: { value: BugSource; label: string }[] = [
  { value: 'human_reported', label: 'Human Reported' },
  { value: 'arm_reported', label: 'Arm Reported' },
  { value: 'system_detected', label: 'System Detected' },
];

const PRIORITY_OPTIONS: { value: BugPriority; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export function BugModal({ isOpen, onClose, onSaved, presentation = 'modal' }: BugModalProps) {
  const fieldId = useId();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<BugSource>('human_reported');
  const [priority, setPriority] = useState<BugPriority>('medium');
  const [sourceTaskId, setSourceTaskId] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTitle('');
    setDescription('');
    setSource('human_reported');
    setPriority('medium');
    setSourceTaskId('');
    setErrorDetails('');
    setError(null);
    setTimeout(() => titleRef.current?.focus(), 100);
  }, [isOpen]);

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

    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    if (!description.trim()) {
      setError('Description is required');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const result = await api.createBug({
        title: title.trim(),
        description: description.trim(),
        source,
        priority,
        sourceTaskId: sourceTaskId.trim() || undefined,
        errorDetails: errorDetails.trim() || undefined,
      });
      onSaved?.(result.bug);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save bug');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  const content = (
    <div className={`flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 ${
        presentation === 'panel'
          ? 'min-h-[min(36rem,100%)] shadow-xl'
          : 'relative mx-4 max-h-[90vh] shadow-2xl'
      }`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 className="text-lg font-semibold text-white">New Bug</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-white rounded transition-colors"
            aria-label="Close new bug"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-4">
            <div>
              <label htmlFor={`${fieldId}-title`} className="block text-sm font-medium text-zinc-300 mb-1">
                Title <span className="text-red-400">*</span>
              </label>
              <input
                ref={titleRef}
                id={`${fieldId}-title`}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Brief title for the bug"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
              />
            </div>

            <div>
              <label htmlFor={`${fieldId}-description`} className="block text-sm font-medium text-zinc-300 mb-1">
                Description <span className="text-red-400">*</span>
              </label>
              <textarea
                id={`${fieldId}-description`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the bug, steps to reproduce, expected vs actual behavior..."
                rows={4}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 resize-none focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${fieldId}-priority`} className="block text-sm font-medium text-zinc-300 mb-1">
                  Priority
                </label>
                <select
                  id={`${fieldId}-priority`}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as BugPriority)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor={`${fieldId}-source`} className="block text-sm font-medium text-zinc-300 mb-1">
                  Source
                </label>
                <select
                  id={`${fieldId}-source`}
                  value={source}
                  onChange={(e) => setSource(e.target.value as BugSource)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                >
                  {SOURCE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${fieldId}-source-task`} className="block text-sm font-medium text-zinc-300 mb-1">
                  Source Task ID
                </label>
                <input
                  id={`${fieldId}-source-task`}
                  type="text"
                  value={sourceTaskId}
                  onChange={(e) => setSourceTaskId(e.target.value)}
                  placeholder="Optional task ID"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                />
              </div>
              <div>
                <label htmlFor={`${fieldId}-error-details`} className="block text-sm font-medium text-zinc-300 mb-1">
                  Error Details
                </label>
                <input
                  id={`${fieldId}-error-details`}
                  type="text"
                  value={errorDetails}
                  onChange={(e) => setErrorDetails(e.target.value)}
                  placeholder="Optional error details"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                />
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end px-4 py-3 border-t border-zinc-700 bg-zinc-800/50">
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
                disabled={isSaving || !title.trim() || !description.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg font-medium text-sm transition-colors disabled:cursor-not-allowed"
              >
                {isSaving ? (
                  <>Saving...</>
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    Create Bug
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
        aria-label="Close bug dialog"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      {content}
    </div>,
    document.body,
  );
}
