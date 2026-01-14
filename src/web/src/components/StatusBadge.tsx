import { cn } from '@/lib';

interface StatusBadgeProps {
  status: 'idle' | 'busy' | 'paused' | 'error' | 'stopped';
  size?: 'sm' | 'md';
}

const statusConfig = {
  idle: { label: 'Idle', className: 'bg-status-idle/20 text-status-idle border-status-idle/50' },
  busy: { label: 'Busy', className: 'bg-status-busy/20 text-status-busy border-status-busy/50' },
  paused: { label: 'Paused', className: 'bg-status-paused/20 text-status-paused border-status-paused/50' },
  error: { label: 'Error', className: 'bg-status-error/20 text-status-error border-status-error/50' },
  stopped: { label: 'Stopped', className: 'bg-muted text-muted-foreground border-muted' },
};

export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const config = statusConfig[status];
  
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm',
        config.className
      )}
    >
      <span className={cn(
        'rounded-full mr-1.5',
        size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
        status === 'idle' && 'bg-status-idle',
        status === 'busy' && 'bg-status-busy animate-pulse',
        status === 'paused' && 'bg-status-paused',
        status === 'error' && 'bg-status-error',
        status === 'stopped' && 'bg-muted-foreground',
      )} />
      {config.label}
    </span>
  );
}
