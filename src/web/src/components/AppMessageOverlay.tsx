import { useEffect } from 'react';
import { useMessage } from '@/lib';
import { MessageModal } from './MessageModal';

export function AppMessageOverlay() {
  const {
    isMessageModalOpen,
    replyContext,
    openNewMessage,
    closeMessageModal,
  } = useMessage();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        openNewMessage();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openNewMessage]);

  return (
    <MessageModal
      isOpen={isMessageModalOpen}
      onClose={closeMessageModal}
      replyTo={replyContext}
    />
  );
}
