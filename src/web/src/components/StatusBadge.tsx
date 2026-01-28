import { Chip } from '@heroui/react';

interface StatusBadgeProps {
  status: 'idle' | 'busy' | 'paused' | 'error' | 'stopped' | 'starting' | 'running' | string;
  size?: 'sm' | 'md';
}

const statusConfig: Record<string, { label: string; color: 'default' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  idle: { label: 'Idle', color: 'default' },
  busy: { label: 'Busy', color: 'warning' },
  paused: { label: 'Paused', color: 'accent' },
  error: { label: 'Error', color: 'danger' },
  stopped: { label: 'Stopped', color: 'default' },
  starting: { label: 'Starting', color: 'warning' },
  running: { label: 'Running', color: 'success' },
};

const defaultConfig = { label: 'Unknown', color: 'default' as const };

export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const config = statusConfig[status] || defaultConfig;
  const chipSize = size === 'sm' ? 'sm' : 'md';

  return (
    <Chip size={chipSize} variant="soft" color={config.color}>
      {config.label}
    </Chip>
  );
}
