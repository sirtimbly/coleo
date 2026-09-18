import { useEffect, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { Check, TriangleAlert } from 'lucide-react';

import './prepare-tasks-modal.css';

interface PrepareTasksModalProps {
  running: boolean;
  error: string | null;
  result: { taskCount: number; formatterError?: string } | null;
  onClose: () => void;
  onConfirm: () => void;
}

/** Request activity, not a simulated completion percentage. */
export function PrepareTasksModal({ running, error, result, onClose, onConfirm }: PrepareTasksModalProps) {
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
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => { if (!open && !running) onClose(); }}
      isDismissable={!running}
      isKeyboardDismissDisabled={running}
      className="bg-black/5 backdrop-blur-none"
    >
      <Modal.Container size="lg" placement="center">
        <Modal.Dialog className="overflow-hidden border border-border bg-surface p-0">
          <Modal.Header className="border-b border-border px-5 py-4">
            <Modal.Heading className="text-base font-semibold">{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-4 p-5 text-sm">
            {running || awaitingConfirmation ? (
              <>
                <p>Coleo reviews your plan for missing foundations and puts deliverables in dependency order, so Arms can start with the right work.</p>
                {running ? <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span role="status">Evaluating and preparing the plan…</span>
                    <span className="tabular-nums text-muted-foreground" aria-label="Elapsed time">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} elapsed</span>
                  </div>
                  <div role="progressbar" aria-label="Preparing tasks" aria-valuetext="Waiting for plan evaluation; percentage unavailable" className="h-1 overflow-hidden bg-accent/15">
                    <div className="prepare-tasks-activity h-full w-1/3 bg-accent" />
                  </div>
                </div> : null}
                <p className="text-xs leading-relaxed text-muted-foreground">The model reads and rewrites the full plan while preserving your requirements. Large plans can take several minutes; model requests have a deadline of up to 15 minutes. Progress percentages aren’t available during evaluation.</p>
                <p className="border-t border-border pt-3 text-xs text-muted-foreground">Keep this tab open. After the plan is saved, the Brain evaluates it and adds tasks on its next poll.</p>
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
                  <p className="mt-2 text-xs text-muted-foreground">The Brain will evaluate this plan and create tasks on its next poll. Task creation is still pending.</p>
                </div>
              </div>
            )}
          </Modal.Body>
          {!running ? (
            <Modal.Footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <Button variant="secondary" onPress={onClose}>{awaitingConfirmation ? 'Cancel' : 'Close'}</Button>
              {awaitingConfirmation ? <Button variant="primary" onPress={onConfirm}>Confirm</Button> : null}
            </Modal.Footer>
          ) : null}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
