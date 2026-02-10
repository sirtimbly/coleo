# Theme System Documentation

## Overview

The Coleo Observatory web UI supports both Light and Dark themes, with automatic system preference detection. The theme system is built using CSS variables and Tailwind CSS v4.

## Features

- **Three theme modes**: Light, Dark, and System (follows OS preference)
- **Instant switching**: Theme changes apply immediately without page reload
- **Persistent preference**: User preference is stored in localStorage and synced to backend API
- **Smooth transitions**: CSS transitions provide smooth color changes when switching themes
- **Accessibility**: All color combinations meet WCAG AA contrast standards

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
- If you're signed in, the preference is also synced to your user profile
- On page load, the theme is applied in this priority order:
  1. Stored user preference (from backend if signed in)
  2. Client local override (localStorage)
  3. System preference (prefers-color-scheme)
  4. Default to Light

## Developer Guide

### Architecture

The theme system consists of:

1. **CSS Variables** (`src/web/src/index.css`): Define color values for both light and dark modes
2. **Tailwind Theme Config** (`@theme` directive in CSS): Maps CSS variables to Tailwind classes
3. **Theme Provider** (`src/web/src/lib/theme.tsx`): React context for theme state management
4. **Theme Toggle UI** (`src/web/src/pages/SettingsPage.tsx`): User interface for theme selection

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

The theme system works alongside HeroUI v3 components:

- HeroUI components use their own theming system
- Our CSS variables complement HeroUI's variables
- Some components may need custom overrides for perfect dark mode support

### Performance Considerations

- Theme switching is instant (no page reload)
- CSS transitions are applied to color properties only
- The `no-transitions` class prevents flash of wrong theme on initial load
- localStorage access is wrapped in try-catch for privacy mode compatibility
