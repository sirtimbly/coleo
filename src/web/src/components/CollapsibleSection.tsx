import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib';

import type { ReactNode } from 'react';

export interface CollapsibleSectionProps {
  title: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
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
  description,
  meta,
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
            'group flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-surface-secondary/60',
            appearance === 'card' ? 'px-4' : 'px-1',
            triggerClassName,
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold tracking-tight text-foreground">{title}</span>
            {description ? (
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{description}</span>
            ) : null}
          </span>
          {meta ? <span className="shrink-0 text-xs font-normal text-muted-foreground">{meta}</span> : null}
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
