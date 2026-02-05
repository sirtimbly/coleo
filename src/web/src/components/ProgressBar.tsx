import { cn } from '@/lib/utils'

interface ProgressBarProps {
  /** Completion percentage (0–100) */
  percent: number
}

/**
 * Horizontal progress bar showing completion percentage.
 */
export function ProgressBar({ percent }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div className={cn('w-full bg-default-200 rounded-full h-2 overflow-hidden')}>
      <div
        className="bg-accent h-2 rounded-full transition-width"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
