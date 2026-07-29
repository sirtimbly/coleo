import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib';

import type { ReactNode } from 'react';

export interface CollapsibleSectionSummary {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
}

export interface CollapsibleSectionProps {
  title: ReactNode;
  children: ReactNode;
  summary?: readonly CollapsibleSectionSummary[];
  appearance?: 'card' | 'flat';
  defaultExpanded?: boolean;
  isExpanded?: boolean;
  onExpandedChange?: (isExpanded: boolean) => void;
  fill?: boolean;
  unmountOnCollapse?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  bodyClassName?: string;
}

export function CollapsibleSection({
  title,
  children,
  summary,
  appearance = 'card',
  defaultExpanded = true,
  isExpanded: controlledExpanded,
  onExpandedChange,
  fill = false,
  unmountOnCollapse = false,
  className,
  triggerClassName,
  contentClassName,
  bodyClassName,
}: CollapsibleSectionProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isExpanded = controlledExpanded ?? internalExpanded;
  const sectionId = useId();
  const headingId = `${sectionId}-heading`;
  const panelId = `${sectionId}-panel`;
  const setIsExpanded = (next: boolean) => {
    if (controlledExpanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  return (
    <section
      className={cn(
        'overflow-hidden shadow-none',
        appearance === 'card'
          ? 'rounded-md border border-border bg-card'
          : 'border-y border-border bg-transparent',
        fill && isExpanded && 'flex min-h-0 flex-1 flex-col',
        fill && !isExpanded && 'shrink-0',
        className,
      )}
    >
      <h2 id={headingId}>
        <button
          type="button"
          aria-controls={panelId}
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded(!isExpanded)}
          className={cn(
            'group flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-surface-secondary/60',
            appearance === 'card' ? 'px-4' : 'px-1',
            triggerClassName,
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
            <span className="shrink-0 truncate text-sm font-semibold tracking-tight text-foreground">{title}</span>
            {summary?.length ? (
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {summary.map((item) => (
                  <span
                    key={item.label}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] leading-none',
                      item.tone === 'accent' && 'border-accent/30 bg-accent/10 text-accent',
                      item.tone === 'success' && 'border-success/30 bg-success/10 text-success',
                      item.tone === 'warning' && 'border-warning/30 bg-warning/10 text-warning',
                      item.tone === 'danger' && 'border-danger/30 bg-danger/10 text-danger',
                      (!item.tone || item.tone === 'default') && 'border-border bg-surface-secondary text-muted-foreground',
                    )}
                  >
                    <span className="uppercase tracking-[0.08em] opacity-75">{item.label}</span>
                    <span className="font-semibold tabular-nums text-current">{item.value}</span>
                  </span>
                ))}
              </span>
            ) : null}
          </span>
          <ChevronDown
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </h2>
      {!unmountOnCollapse || isExpanded ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          hidden={!isExpanded}
          className={cn(fill && 'min-h-0 flex-1 overflow-hidden', contentClassName)}
        >
          <div
            className={cn(
              fill ? 'h-full min-h-0' : appearance === 'card' ? 'p-4 pt-1' : 'px-0 py-4',
              bodyClassName,
            )}
          >
            {children}
          </div>
        </div>
      ) : null}
    </section>
  );
}
