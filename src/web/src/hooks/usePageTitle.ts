import { useEffect } from 'react';
import { useIsWorkspacePanel } from '@/workspace/route-context';

export function usePageTitle(title: string): void {
  const isWorkspacePanel = useIsWorkspacePanel();

  useEffect(() => {
    if (isWorkspacePanel) {
      return;
    }

    document.title = title;
  }, [isWorkspacePanel, title]);
}
