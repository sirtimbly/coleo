import { useState } from 'react';
import { Disclosure } from '@heroui/react';
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
  fill?: boolean;
  unmountOnCollapse?: boolean;
  disableAnimation?: boolean;
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
  fill = false,
  unmountOnCollapse = false,
  disableAnimation = false,
  className,
  triggerClassName,
  contentClassName,
  bodyClassName,
}: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <Disclosure
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
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
      <Disclosure.Heading>
        <Disclosure.Trigger
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
          <Disclosure.Indicator className="shrink-0 text-muted-foreground [&>svg]:size-4">
            <ChevronDown />
          </Disclosure.Indicator>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content
        className={cn(
          fill && 'min-h-0 flex-1 overflow-hidden',
          disableAnimation && '!transition-none',
          contentClassName,
        )}
      >
        <Disclosure.Body
          className={cn(
            appearance === 'card' ? 'p-4 pt-1' : 'px-0 py-4',
            fill && 'h-full min-h-0',
            bodyClassName,
          )}
        >
          {!unmountOnCollapse || isExpanded ? children : null}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
