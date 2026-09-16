import { Button } from '@heroui/react';
import type { ComponentProps, JSX } from 'react';

/** Opens another route or screen; mutations and in-place toggles use Button. */
export function NavigationButton(props: Omit<ComponentProps<typeof Button>, 'variant'>): JSX.Element {
  return <Button {...props} variant="ghost" data-navigation-control />;
}
