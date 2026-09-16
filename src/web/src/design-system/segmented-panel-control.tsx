import { Button } from '@heroui/react';
import type { JSX, ReactNode } from 'react';

interface PanelOption<T extends string> {
  value: T;
  content: ReactNode;
  label?: string;
  controls: string;
}

interface SegmentedPanelControlProps<T extends string> {
  label: string;
  value: T | null;
  options: readonly PanelOption<T>[];
  onChange: (value: T | null) => void;
}

/** Mutually exclusive panel toggles; pressing the selected segment closes the panel. */
export function SegmentedPanelControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedPanelControlProps<T>): JSX.Element {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 self-center items-center gap-0.5 rounded-md border border-border bg-surface-secondary/40 p-0.5">
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Button
            key={option.value}
            size="sm"
            variant={selected ? 'secondary' : 'ghost'}
            aria-label={option.label}
            aria-pressed={selected}
            aria-controls={option.controls}
            onPress={() => onChange(selected ? null : option.value)}
            className="relative h-7 min-h-7 min-w-0 touch-manipulation px-2"
          >
            {option.content}
            {selected ? <span aria-hidden="true" className="pointer-events-none absolute inset-x-2 bottom-0.5 h-0.5 rounded-full bg-current" /> : null}
          </Button>
        );
      })}
    </div>
  );
}
