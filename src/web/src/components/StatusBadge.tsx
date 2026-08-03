import { Chip } from '@heroui/react';

interface StatusBadgeProps {
  status: 'idle' | 'busy' | 'paused' | 'error' | 'stopped' | 'starting' | 'running' | string;
  size?: 'sm' | 'md';
}

const statusConfig = {
  idle: { label: 'Idle', color: 'default' },
  busy: { label: 'Busy', color: 'warning' },
  paused: { label: 'Paused', color: 'accent' },
  error: { label: 'Error', color: 'danger' },
  stopped: { label: 'Stopped', color: 'default' },
  starting: { label: 'Starting', color: 'warning' },
  running: { label: 'Running', color: 'success' },
} as const;

const defaultConfig = { label: 'Unknown', color: 'default' as const };

const isKnownStatus = (
  status: string,
): status is keyof typeof statusConfig => status in statusConfig;

export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const config = isKnownStatus(status) ? statusConfig[status] : defaultConfig;
  const chipSize = size === 'sm' ? 'sm' : 'md';

  return (
    <Chip size={chipSize} variant="soft" color={config.color}>
      {config.label}
    </Chip>
  );
}
