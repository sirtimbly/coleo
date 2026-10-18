import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { AppLayoutMode } from '@/hooks/useLayoutMode';
import { ArmStatusBar } from './ArmStatusBar';
import { AppSidebar } from './AppSidebar';

interface LayoutProps {
  children: ReactNode;
  layoutMode: AppLayoutMode;
}

export function Layout({ children, layoutMode }: LayoutProps) {
  const location = useLocation();
  const showArmStatusBar = location.pathname !== '/viewer';

  return (
    <div className="observatory-backdrop flex h-screen bg-background text-foreground">
      <AppSidebar layoutMode={layoutMode} />

      <main className="flex min-w-0 flex-1 flex-col overflow-auto bg-background">
        {showArmStatusBar ? <ArmStatusBar /> : null}
        {children}
      </main>
    </div>
  );
}
