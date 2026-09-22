# Theme System Documentation

## Overview

The Coleo workbench supports Light, Dark, and System themes, with System as the
default. CSS variables and Tailwind CSS v4 provide the shared tokens used by
HeroUI controls, Coleo components, and specialized rendering adapters. This
implements ADR-004 (`.project/decisions/004-shadcn-components.md`); see the
[workbench overview](./workbench/README.md) for the surrounding architecture.

## Features

- **Three theme modes**: Light, Dark, and System (follows OS preference)
- **Instant switching**: Theme changes apply immediately without page reload
- **Persistent preference**: Theme preference is stored in browser localStorage
- **Smooth transitions**: CSS transitions provide smooth color changes when switching themes
- **Accessibility**: Check contrast and focus visibility in both themes, including library overlays

## User Guide

### Changing the Theme

1. Navigate to **Settings** page
2. Under the **Appearance** section, find the **Theme** dropdown
3. Select your preferred theme:
   - **Light**: Always use light color scheme
   - **Dark**: Always use dark color scheme
   - **System**: Automatically match your device's color scheme preference

### Theme Persistence

- Your theme preference is saved automatically when you make a selection
- The preference persists across browser sessions using localStorage
- `ThemeProvider` reads `coleo-theme`; it does not synchronize this preference
  with a backend profile
- On page load, a valid stored Light/Dark/System choice wins; otherwise System
  is selected. System resolves through `prefers-color-scheme` and follows later
  OS changes. The initial non-browser fallback is Light.
- Workbench profiles, views, layouts, and toolbar templates have separate
  API-backed persistence; do not confuse that with theme storage.

## Developer Guide

### Architecture

The theme system consists of:

1. **CSS Variables** (`src/web/src/index.css`): Define color values for both light and dark modes
2. **Tailwind Theme Config** (`@theme` directive in CSS): Maps CSS variables to Tailwind classes
3. **Theme Provider** (`src/web/src/lib/theme.tsx`): React context for theme state management
4. **Theme Toggle UI** (`src/web/src/pages/SettingsPage.tsx`): User interface for theme selection
5. **Shared adaptations** (`src/web/src/design-system/shapes.css` and `controls.css`): Consistent geometry and control behavior across libraries
6. **Projection themes** (`sheet-theme.css`, Adaptive Cards styles, and Golden Layout styles): Specialized surfaces consuming the same application tokens

### CSS Variables

Theme variables are defined in `:root` for light mode and `.dark` class for dark mode:

```css
:root {
  --background: oklch(0.9702 0 0);
  --foreground: oklch(0.2103 0.0059 285.89);
  --card: oklch(100% 0 0);
  --card-foreground: oklch(0.2103 0.0059 285.89);
  /* ... more variables */
}

.dark {
  --background: oklch(12% 0.005 285.823);
  --foreground: oklch(0.9911 0 0);
  --card: oklch(0.2103 0.0059 285.89);
  --card-foreground: oklch(0.9911 0 0);
  /* ... more variables */
}
```

### Tailwind Integration

The `@theme` directive maps CSS variables to Tailwind utility classes:

```css
@theme {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  /* ... more mappings */
}
```

This allows using Tailwind classes like:
- `bg-background` - Background color
- `text-foreground` - Text color
- `border-border` - Border color
- `bg-card` - Card background

### Using the Theme in Components

Components automatically respond to theme changes when using the CSS variable-based Tailwind classes:

```tsx
// This component will automatically adapt to theme changes
function MyComponent() {
  return (
    <div className="bg-card text-card-foreground border border-border">
      Content
    </div>
  );
}
```

### Programmatic Theme Access

Use the `useTheme` hook to access or change the theme programmatically:

```tsx
import { useTheme } from '@/lib';

function MyComponent() {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();

  return (
    <button onClick={toggleTheme}>
      Current: {resolvedTheme}
    </button>
  );
}
```

The hook returns:
- `theme`: Current theme setting ('light' | 'dark' | 'system')
- `resolvedTheme`: Actual applied theme ('light' | 'dark')
- `setTheme(theme)`: Function to set the theme
- `toggleTheme()`: Function to toggle between light and dark

### Adding New Theme-Aware Components

When creating new components:

1. Use CSS variable-based Tailwind classes:
   - `bg-background`, `text-foreground` for base colors
   - `bg-card`, `text-card-foreground` for card surfaces
   - `border-border` for borders
   - `text-muted-foreground` for secondary text

2. Avoid hardcoded colors like `bg-white` or `text-black`

3. Test in both light and dark modes

4. Ensure contrast ratios meet WCAG AA standards (4.5:1 for normal text, 3:1 for large text)

### Color Tokens Reference

| Token | Light Mode | Dark Mode | Usage |
|-------|-----------|-----------|-------|
| `--background` | Light gray | Very dark gray | Page background |
| `--foreground` | Dark gray | White | Primary text |
| `--card` | White | Dark gray | Card backgrounds |
| `--card-foreground` | Dark gray | White | Card text |
| `--muted` | Medium gray | Light gray | Secondary text |
| `--border` | Light gray | Dark gray | Borders |
| `--accent` | Blue | Blue | Primary actions, links |
| `--sidebar` | Light gray | Dark gray | Sidebar background |

### Testing Themes

To test theme switching:

1. Open the Settings page
2. Toggle between Light, Dark, and System themes
3. Verify all components update correctly
4. Check that the preference persists after page reload
5. Test system preference detection by changing OS theme

### Browser Support

The theme system uses:
- CSS Custom Properties (variables) - supported in all modern browsers
- `oklch()` color format - supported in Chrome 111+, Firefox 128+, Safari 15.4+
- `prefers-color-scheme` media query - supported in all modern browsers

For older browsers, the system gracefully falls back to light mode.

## Implementation Notes

### Tailwind v4 Differences

This project uses Tailwind CSS v4, which has significant differences from v3:

- No `tailwind.config.js` file - configuration is done via CSS using `@theme`
- CSS variables are defined directly in CSS files
- The `@import "tailwindcss"` statement includes all Tailwind features

### HeroUI v3 Integration

`index.css` imports Tailwind, HeroUI styles, then the shared shape/control
adaptations. Keep library adjustments in those shared adapters instead of
inventing per-page overrides. The same button, field, or menu should retain its
shape and state cues in toolbars, panels, and portals.

Tabulator editors and menus, Adaptive Cards, and Golden Layout chrome also need
theme verification. Resource status colors come from
`design-system/resource-status-styles.ts` so sheet cells and charts agree.

Sizing remains scoped: toolbar row hierarchy, compact/comfortable collection
density, card presentation, and grid font size are distinct preferences. A grid
font-size change must not resize the surrounding controls. See
`src/web/src/design-system/README.md` for the exact shape and typography contract.

### Performance Considerations

- Theme switching is instant (no page reload)
- CSS transitions are applied to color properties only
- The `no-transitions` class prevents flash of wrong theme on initial load
- localStorage access is wrapped in try-catch for privacy mode compatibility
