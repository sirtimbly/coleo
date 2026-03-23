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
      <header className="border-b border-border/70 bg-content1/85 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{title}</div>
            {subtitle ? (
              <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>

          {toolbar ? <div className="flex items-center gap-2">{toolbar}</div> : null}
        </div>

        {filters ? (
          <div className="border-t border-border/60 px-3 py-2">
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
