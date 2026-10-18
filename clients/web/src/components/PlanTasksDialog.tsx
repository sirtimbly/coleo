import { Modal } from '@heroui/react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

interface PlanTasksDialogProps {
  isOpen: boolean;
  busy: boolean;
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

/** Shared frame for preparing a plan and regenerating its task queue. */
export function PlanTasksDialog({ isOpen, busy, title, description, onClose, children, footer }: PlanTasksDialogProps) {
  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      variant="blur"
    >
      <Modal.Container size="lg" placement="center">
        <Modal.Dialog className="overflow-hidden border border-border bg-surface p-0">
          <Modal.Header className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <div>
              <Modal.Heading className="text-lg font-semibold">{title}</Modal.Heading>
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            </div>
            <button
              type="button"
              aria-label="Close dialog"
              disabled={busy}
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-secondary hover:text-foreground disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </Modal.Header>
          <Modal.Body className="space-y-4 p-5 text-sm">{children}</Modal.Body>
          <Modal.Footer className="flex justify-end gap-2 border-t border-border px-5 py-4">{footer}</Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
