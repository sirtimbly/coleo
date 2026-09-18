import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';

import { PlanTasksDialog } from './PlanTasksDialog';
import './prepare-tasks-modal.css';

interface PrepareTasksModalProps {
  sourcePath: string;
  running: boolean;
  error: string | null;
  result: { taskCount: number; formatterError?: string } | null;
  onClose: () => void;
  onConfirm: () => void;
  onOpenInstructions: (template: 'system' | 'user') => void;
}

/** Request activity, not a simulated completion percentage. */
export function PrepareTasksModal({ sourcePath, running, error, result, onClose, onConfirm, onOpenInstructions }: PrepareTasksModalProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const problem = error || result?.formatterError;
  const awaitingConfirmation = !running && !error && !result;
  const title = awaitingConfirmation ? 'Prepare tasks?' : running ? 'Preparing tasks' : error ? 'Preparation interrupted' : problem ? 'Plan saved · evaluation incomplete' : 'Plan prepared';

  return (
    <PlanTasksDialog
      isOpen
      busy={running}
      title={title}
      description="Organize plan files before the Brain synchronizes tasks."
      onClose={onClose}
      footer={
        running || awaitingConfirmation ? (
          <>
            <Button variant="secondary" onPress={onClose} isDisabled={running}>Cancel</Button>
            <Button variant="primary" onPress={onConfirm} isDisabled={running}>
              {running ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
              {running ? 'Preparing…' : 'Confirm overwrite'}
            </Button>
          </>
        ) : <Button variant="secondary" onPress={onClose}>Close</Button>
      }
    >
            {running || awaitingConfirmation ? (
              <>
                <p>Coleo reviews your plan for missing foundations and puts deliverables in dependency order, so Arms can start with the right work.</p>
                <dl className="space-y-2 text-xs leading-relaxed">
                  <div className="flex gap-3">
                    <dt className="w-12 shrink-0 font-medium">Reads</dt>
                    <dd className="min-w-0 text-muted-foreground">Your current editor text, project file names, Git status, and the{' '}
                      <button type="button" disabled={running} onClick={() => onOpenInstructions('system')} className="text-accent underline underline-offset-2 disabled:text-muted-foreground disabled:no-underline">plan-evaluation instructions</button>{' '}
                      (<button type="button" disabled={running} onClick={() => onOpenInstructions('user')} className="text-accent underline underline-offset-2 disabled:text-muted-foreground disabled:no-underline">request template</button>).</dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-12 shrink-0 font-medium">Writes</dt>
                    <dd className="min-w-0 text-muted-foreground"><strong className="font-medium text-foreground">Overwrites <code>.project/plan.md</code></strong> with the prepared plan{sourcePath !== '.project/plan.md' ? <>, also saves your editor text to <code className="break-all">{sourcePath}</code></> : null}.</dd>
                  </div>
                </dl>
                <p className="text-xs">This step changes plan text files only; it does not add, update, or delete database tasks.</p>
                {running ? <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span role="status">Evaluating and preparing the plan…</span>
                    <span className="tabular-nums text-muted-foreground" aria-label="Elapsed time">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} elapsed</span>
                  </div>
                  <div role="progressbar" aria-label="Preparing tasks" aria-valuetext="Waiting for plan evaluation; percentage unavailable" className="h-1 overflow-hidden bg-accent/15">
                    <div className="prepare-tasks-activity h-full w-1/3 bg-accent" />
                  </div>
                </div> : null}
                <p className="text-xs leading-relaxed text-muted-foreground">Rewriting the full plan can take several minutes, with a model-request deadline of up to 15 minutes. Keep this tab open while it runs.</p>
                <p className="border-t border-border pt-3 text-xs text-muted-foreground">On its next poll, the Brain evaluates the saved plan and its linked plan documents. After evaluation succeeds, it adds or updates tasks in the database.</p>
              </>
            ) : problem ? (
              <div role="alert" className="space-y-3">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <p className="break-words">{problem}</p>
                </div>
                <p className="text-xs text-muted-foreground">{error
                  ? 'Your editor content is still available. Close this dialog to review it and try again.'
                  : 'The plan was saved, but AI evaluation has not succeeded. The Brain will retry automatically; work may remain blocked until evaluation succeeds.'}</p>
              </div>
            ) : (
              <div role="status" className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <div>
                  <p>{result?.taskCount ?? 0} checklist items in the saved plan.</p>
                  <p className="mt-2 text-xs text-muted-foreground">On its next poll, the Brain evaluates the saved plan and its linked plan documents, then adds or updates tasks in the database. Task synchronization is still pending.</p>
                </div>
              </div>
            )}
    </PlanTasksDialog>
  );
}
