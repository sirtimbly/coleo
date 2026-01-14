# ADR-004: UI Component Approach

**Status**: Accepted (Updated)  
**Date**: 2025-01-13  
**Updated**: 2025-01-14

## Context

The Observatory web UI needs a component library. Options considered:
- Shadcn/ui - Copy-paste components built on Radix
- Radix UI - Primitives only, more DIY
- Plain Tailwind - Maximum control, most work

## Decision

Use **shadcn/ui-inspired** components - simple, custom Tailwind components that follow shadcn patterns without the full CLI tooling overhead.

## Rationale

1. **Dark mode support** - Built via CSS variables (matches requirement)
2. **Accessibility** - Uses semantic HTML, follows WCAG patterns
3. **Customizable** - Components are simple, fully editable in the project
4. **TypeScript** - First-class TypeScript support
5. **Tailwind integration** - Works with our existing Tailwind setup
6. **Simplicity** - No extra dependencies, no CLI tooling to maintain

## Consequences

- Components live in `src/web/src/components/`
- Components use `cn()` utility (tailwind-merge + clsx)
- Theming via CSS variables in `index.css`
- Dark mode is the default theme
- Can upgrade to full shadcn/ui CLI later if needed

## Implementation

```typescript
// Example component pattern used
import { cn } from '@/lib';

export function Card({ className }: CardProps) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-4', className)}>
      {children}
    </div>
  );
}
```

## To Upgrade to Full Shadcn Later

```bash
# When ready for full shadcn
bunx shadcn-ui@latest init
# Components can be copied from existing implementations
```
