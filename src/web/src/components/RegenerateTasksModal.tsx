import { useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Button, Modal } from '@heroui/react';

import { api } from '@/lib';

interface RegenerateTasksResult {
  deletedCount: number;
  createdCount: number;
  preservedCompletedCount: number;
  mode: 'ai' | 'structured';
}

interface RegenerateTasksModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRegenerated?: (result: RegenerateTasksResult) => void;
}

export function RegenerateTasksModal({ isOpen, onClose, onRegenerated }: RegenerateTasksModalProps) {
  const [explanation, setExplanation] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegenerateTasksResult | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setExplanation('');
    setError(null);
    setResult(null);
  }, [isOpen]);

  const regenerate = async () => {
    const reason = explanation.trim();
    if (!reason) {
      setError('Explain why the task list needs to be regenerated.');
      return;
    }

    setIsRegenerating(true);
    setError(null);
    try {
      const response = await api.regenerateAllTasks(reason);
      setResult(response);
      onRegenerated?.(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate tasks');
    } finally {
      setIsRegenerating(false);
    }
  };

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => { if (!open && !isRegenerating) onClose(); }}
      isDismissable={!isRegenerating}
      isKeyboardDismissDisabled={isRegenerating}
      variant="blur"
    >
      <Modal.Container size="lg" placement="center">
        <Modal.Dialog className="overflow-hidden border border-border bg-surface p-0">
          <Modal.Header className="flex-row items-center justify-between border-b border-border px-5 py-4">
          <div>
            <Modal.Heading className="text-lg font-semibold">Regenerate All Tasks</Modal.Heading>
            <p className="mt-1 text-xs text-muted-foreground">Rebuild the active task queue from the saved project plan.</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={isRegenerating}
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-secondary hover:text-foreground disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
          </Modal.Header>

          <Modal.Body className="space-y-4 p-5">
          {result ? (
            <div role="status" className="rounded-lg border border-success/30 bg-success/10 p-4 text-sm">
              <p className="font-medium text-success">Task regeneration complete</p>
              <p className="mt-2 text-muted-foreground">
                Removed {result.deletedCount} active tasks, created {result.createdCount}, and preserved {result.preservedCompletedCount} completed tasks.
              </p>
            </div>
          ) : (
            <>
              <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p>
                  Every task not marked completed will be permanently deleted. Completed work remains in the database.
                </p>
              </div>

              <div>
                <label htmlFor="task-regeneration-explanation" className="block text-sm font-medium">
                  Why should the tasks be regenerated?
                </label>
                <p className="mt-1 text-xs text-muted-foreground">
                  The Brain uses this explanation to change task grouping and granularity while rescanning the plan.
                </p>
                <textarea
                  id="task-regeneration-explanation"
                  autoFocus
                  rows={6}
                  maxLength={4000}
                  value={explanation}
                  onChange={(event) => setExplanation(event.target.value)}
                  placeholder="For example: duplicated work created too many tasks; combine related work into broader units."
                  className="mt-2 w-full resize-y rounded-lg border border-border bg-surface-secondary px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <div className="mt-1 text-right text-xs text-muted-foreground">{explanation.length}/4000</div>
              </div>
            </>
          )}

          {error ? <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
          </Modal.Body>

          <Modal.Footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
          {result ? (
            <Button variant="primary" onPress={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onPress={onClose} isDisabled={isRegenerating}>Cancel</Button>
              <Button
                variant="primary"
                onPress={regenerate}
                isDisabled={isRegenerating || !explanation.trim()}
              >
                {isRegenerating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {isRegenerating ? 'Regenerating…' : 'Regenerate All Tasks'}
              </Button>
            </>
          )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
