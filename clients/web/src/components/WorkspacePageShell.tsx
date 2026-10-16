/**
 * Compatibility shell for route-level projections outside Golden Layout.
 *
 * It preserves the classic layout while matching the compact workbench header
 * and toolbar spacing used by newly migrated views.
 */
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
      <header className="border-b border-border bg-background">
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-[1.35rem] font-semibold tracking-tight text-foreground">{title}</div>
            {subtitle ? (
              <div className="mt-1 truncate text-sm text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>

          {toolbar ? <div className="flex items-center gap-2">{toolbar}</div> : null}
        </div>

        {filters ? (
          <div className="border-t border-border px-5 py-4">
            {filters}
          </div>
        ) : null}
      </header>

      <div className={cn('flex-1 min-h-0 overflow-hidden bg-background', contentClassName)}>
        {children}
      </div>
    </div>
  );
}
