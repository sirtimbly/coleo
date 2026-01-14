# ADR-004: Shadcn UI Components

**Status**: Accepted  
**Date**: 2025-01-13  
**Deciders**: Human

## Context

The Observatory web UI needs a component library. Options considered:
- Shadcn/ui - Copy-paste components built on Radix
- Radix UI - Primitives only, more DIY
- Plain Tailwind - Maximum control, most work

## Decision

Use **Shadcn/ui** components as documented in their latest documentation.

## Rationale

1. **Dark mode support** - Built-in, matches our requirement
2. **Accessibility** - Built on Radix primitives (WCAG compliant)
3. **Customizable** - Components are copied into project, fully editable
4. **TypeScript** - First-class TypeScript support
5. **Tailwind integration** - Works with our existing Tailwind setup

## Consequences

- Components live in `src/web/components/ui/`
- Use `bunx shadcn-ui@latest add <component>` to add components
- Theming via CSS variables in `globals.css`
- Dark mode is the default theme

## Implementation

```bash
# Initialize shadcn
bunx shadcn-ui@latest init

# Add components as needed
bunx shadcn-ui@latest add button card table
```
