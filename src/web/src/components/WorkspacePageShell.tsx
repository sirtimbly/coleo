import type { ReactNode } from 'react';
import { cn } from '@/lib';

interface WorkspacePageShellProps {
  title: string;
  subtitle?: string;
  toolbar?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}

export function WorkspacePageShell({
  title,
  subtitle,
  toolbar,
  filters,
  children,
  contentClassName,
}: WorkspacePageShellProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <header className="border-b border-border/70 bg-surface/70 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-[0.01em] text-foreground">{title}</div>
            {subtitle ? (
              <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>

          {toolbar ? <div className="flex items-center gap-2">{toolbar}</div> : null}
        </div>

        {filters ? (
          <div className="border-t border-border/60 bg-background/20 px-4 py-3">
            {filters}
          </div>
        ) : null}
      </header>

      <div className={cn('flex-1 min-h-0 overflow-hidden', contentClassName)}>
        {children}
      </div>
    </div>
  );
}
