import type { KeyboardEvent, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Chip, Skeleton } from '@heroui/react';
import { cn } from '@/lib';

// ---------------------------------------------------------------------------
// Dense, table-style row primitives used across the Dashboard, Brain, and
// Arms pages to give a compact, developer-friendly "scan the list" view of
// system status. Rows are optionally clickable to drill into related pages.
// ---------------------------------------------------------------------------

export type Tone = "success" | "warning" | "danger" | "accent" | "default";

export const DOT_TONE_CLASS: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  default: "bg-default-400",
};

export const TEXT_TONE_CLASS: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  accent: "text-accent",
  default: "text-muted-foreground",
};

export function DenseSection({
  title,
  action,
  onHeaderClick,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  onHeaderClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-card", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        {onHeaderClick ? (
          <button
            type="button"
            onClick={onHeaderClick}
            className="group flex items-center gap-1 text-sm font-semibold tracking-tight hover:text-accent"
          >
            {title}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-accent" />
          </button>
        ) : (
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        )}
        {action}
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

export interface DenseRowProps {
  tone?: Tone;
  label: string;
  labelClassName?: string;
  badge?: ReactNode;
  detail?: ReactNode;
  detailTone?: Tone;
  meta?: ReactNode;
  chipLabel?: string;
  chipColor?: "success" | "warning" | "danger" | "default" | "accent";
  sub?: ReactNode;
  onClick?: () => void;
}

export function DenseRow({
  tone = "default",
  label,
  labelClassName,
  badge,
  detail,
  detailTone,
  meta,
  chipLabel,
  chipColor,
  sub,
  onClick,
}: DenseRowProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex flex-col gap-1 px-4 py-2 outline-none",
        onClick && "cursor-pointer transition-colors hover:bg-default-100/60 focus-visible:bg-default-100/60",
      )}
    >
      <div className="flex items-center gap-3 text-sm">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT_TONE_CLASS[tone])} aria-hidden />
        <span className={cn("font-medium shrink-0 w-36 truncate", labelClassName)}>{label}</span>
        {badge}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            detailTone ? TEXT_TONE_CLASS[detailTone] : "text-muted-foreground",
          )}
        >
          {detail}
        </span>
        {meta && <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{meta}</span>}
        {chipLabel && (
          <Chip size="sm" variant="soft" color={chipColor} className="shrink-0">
            {chipLabel}
          </Chip>
        )}
        {onClick && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
      </div>
      {sub && (
        <div className="pl-5 truncate font-mono text-[10.5px] leading-relaxed text-muted-foreground/60">
          {sub}
        </div>
      )}
    </div>
  );
}

export function DenseRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <Skeleton className="h-2 w-2 rounded-full" />
      <Skeleton className="h-4 w-24 rounded" />
      <Skeleton className="h-3 flex-1 rounded" />
      <Skeleton className="h-5 w-16 rounded" />
    </div>
  );
}
