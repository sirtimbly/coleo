import { useCallback, useEffect, useState } from 'react';

export type AppLayoutMode = 'classic' | 'golden';

const STORAGE_KEY = 'coleo-layout-mode';
const LAYOUT_MODE_EVENT = 'coleo:layout-mode-changed';

function getStoredLayoutMode(): AppLayoutMode {
  if (typeof window === 'undefined') {
    return 'golden';
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'classic' || stored === 'golden') {
    return stored;
  }

  return 'golden';
}

export function useLayoutMode() {
  const [layoutMode, setLayoutModeState] = useState<AppLayoutMode>(() => getStoredLayoutMode());

  const setLayoutMode = useCallback((nextMode: AppLayoutMode) => {
    setLayoutModeState(nextMode);
    window.localStorage.setItem(STORAGE_KEY, nextMode);
    window.dispatchEvent(new CustomEvent<AppLayoutMode>(LAYOUT_MODE_EVENT, { detail: nextMode }));
  }, []);

  useEffect(() => {
    const syncLayoutMode = () => {
      setLayoutModeState(getStoredLayoutMode());
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== STORAGE_KEY) {
        return;
      }
      syncLayoutMode();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(LAYOUT_MODE_EVENT, syncLayoutMode as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(LAYOUT_MODE_EVENT, syncLayoutMode as EventListener);
    };
  }, []);

  const toggleLayoutMode = useCallback(() => {
    setLayoutMode(layoutMode === 'classic' ? 'golden' : 'classic');
  }, [layoutMode, setLayoutMode]);

  return {
    layoutMode,
    setLayoutMode,
    toggleLayoutMode,
  };
}
