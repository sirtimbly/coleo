import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { useMessage } from '@/lib';

export function AppMessageOverlay() {
  const navigate = useNavigate();
  const { layoutMode } = useLayoutMode();
  const {
    isMessageModalOpen,
    openNewMessage,
    markMessageOpened,
  } = useMessage();

  useEffect(() => {
    if (!isMessageModalOpen || layoutMode === 'golden') {
      return;
    }

    navigate('/compose');
    markMessageOpened();
  }, [isMessageModalOpen, layoutMode, markMessageOpened, navigate]);

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

  return null;
}
