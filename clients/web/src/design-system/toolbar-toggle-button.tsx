import { Button } from '@heroui/react';
import type { ComponentProps, JSX, ReactNode } from 'react';

interface ToolbarToggleButtonProps extends Omit<ComponentProps<typeof Button>, 'aria-pressed' | 'variant' | 'children'> {
  isSelected: boolean;
  children: ReactNode;
}

/** A compact toggle with a positional cue, while the entire button remains the target. */
export function ToolbarToggleButton({
  isSelected,
  children,
  size = 'sm',
  ...props
}: ToolbarToggleButtonProps): JSX.Element {
  return (
    <Button {...props} size={size} variant={isSelected ? 'secondary' : 'ghost'} aria-pressed={isSelected}>
      {children}
      <svg
        aria-hidden="true"
        focusable="false"
        width="22"
        height="12"
        viewBox="0 0 22 12"
        style={{ width: 22, height: 12 }}
        className="shrink-0 text-current"
      >
        <rect x="0.75" y="0.75" width="20.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x={isSelected ? 13 : 3} y="3" width="6" height="6" rx="1" fill="currentColor" />
      </svg>
    </Button>
  );
}
