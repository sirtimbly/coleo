# Multi-Tabbed Grid View

A high-performance, unified grid interface for managing plan items, tasks, and discoveries with advanced filtering, sorting, and virtualization capabilities.

![Grid View Preview](./assets/grid-view-preview.png)

## Features

- **Multi-tab Interface**: Switch between Tasks, Plan Items, and Discoveries
- **Advanced Filtering**: Search, filter by status/priority, and date ranges
- **Sorting**: Click column headers to sort (ascending/descending)
- **Selection**: Single, multi-select, and range selection with keyboard shortcuts
- **Virtualization**: Optimized for large datasets (1000+ items)
- **Accessibility**: Full keyboard navigation and ARIA labels
- **Responsive**: Adapts to different screen sizes

## Installation

```bash
# Components are already included in the project
import { GridCore, TabContainer, FilterBar } from "@/components";
import { useGridData, useTabSystem, useGridFilters } from "@/hooks";
```

## Quick Start

### Basic Usage

```tsx
import { UnifiedGridPage } from "@/pages/UnifiedGridPage";

function App() {
  return <UnifiedGridPage />;
}
```

### Custom Integration

```tsx
import { GridCore } from "./components/GridCore";
import { useGridData } from "./hooks/useGridData";
import type { GridColumn } from "./types/grid";

function MyCustomGrid() {
  const { items, loading } = useGridData({
    itemType: "task",
    pageSize: 50,
  });

  const columns: GridColumn[] = [
    { key: "subject", title: "Subject", width: 300, sortable: true },
    { key: "status", title: "Status", width: 120, sortable: true },
    { key: "priority", title: "Priority", width: 100 },
  ];

  return (
    <GridCore
      items={items}
      columns={columns}
      loading={loading}
      onRowClick={(item) => console.log("Clicked:", item)}
    />
  );
}
```

## API Reference

### GridCore

The main grid component for displaying tabular data.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `items` | `GridItem[]` | required | Data to display |
| `columns` | `GridColumn[]` | required | Column definitions |
| `loading` | `boolean` | `false` | Show loading state |
| `sort` | `GridSort[]` | `[]` | Current sort state |
| `onSort` | `(sort: GridSort[]) => void` | - | Sort change handler |
| `selectedIds` | `string[]` | `[]` | Selected row IDs |
| `onSelectionChange` | `(ids: string[]) => void` | - | Selection change handler |
| `onRowClick` | `(item: GridItem) => void` | - | Row click handler |
| `emptyMessage` | `string` | `"No items"` | Empty state message |

#### Events

- **onRowClick**: Fired when a row is clicked
  ```tsx
  onRowClick={(item) => {
    navigate(`/tasks/${item.id}`);
  }}
  ```

- **onSelectionChange**: Fired when selection changes
  ```tsx
  onSelectionChange={(selectedIds) => {
    setSelectedItems(selectedIds);
  }}
  ```

- **onSort**: Fired when sort changes
  ```tsx
  onSort={(sort) => {
    updateSort(sort);
  }}
  ```

### TabContainer

Manages tab switching between different data types.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `onItemClick` | `(item: GridItem) => void` | - | Item click handler |
| `onSelectionChange` | `(ids: string[]) => void` | - | Selection change handler |

### FilterBar

Search and filtering controls.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `filters` | `GridFilter[]` | required | Active filters |
| `searchQuery` | `string` | required | Search text |
| `onSearchChange` | `(query: string) => void` | required | Search change handler |
| `onClearFilters` | `() => void` | required | Clear all filters |
| `activeFilterCount` | `number` | required | Number of active filters |

## Hooks

### useGridData

Manages data fetching and state.

```tsx
const {
  items,        // GridItem[]
  loading,      // boolean
  error,        // Error | null
  page,         // number
  setPage,      // (page: number) => void
  totalItems,   // number
  refresh,      // () => Promise<void>
} = useGridData({
  itemType: "task",  // "task" | "plan" | "discovery"
  pageSize: 50,
});
```

### useTabSystem

Manages tab state.

```tsx
const {
  activeTab,         // GridItemType
  tabs,              // GridTab[]
  setActiveTab,      // (tab: GridItemType) => void
  getActiveTabConfig // () => GridTab | undefined
} = useTabSystem({
  defaultTab: "task",
  onTabChange: (tab) => console.log("Switched to:", tab),
});
```

### useGridFilters

Manages filtering state.

```tsx
const {
  filters,           // GridFilter[]
  searchQuery,       // string
  setSearchQuery,    // (query: string) => void
  addFilter,         // (filter: GridFilter) => void
  removeFilter,      // (field: string) => void
  clearFilters,      // () => void
  activeFilterCount, // number
} = useGridFilters({
  debounceMs: 300,
});
```

## Theming

The grid uses CSS variables for theming:

```css
:root {
  --grid-bg: #ffffff;
  --grid-border: #e0e0e0;
  --grid-header-bg: #f5f5f5;
  --grid-row-hover: #f0f7ff;
  --grid-row-selected: #e3f2fd;
  --grid-text-primary: #333333;
  --grid-text-secondary: #666666;
}
```

Override these variables to customize the appearance.

## Common Use Cases

### 1. Task Management Dashboard

```tsx
function TaskDashboard() {
  const { items, loading } = useGridData({ itemType: "task" });
  
  return (
    <div className="dashboard">
      <FilterBar {...filterProps} />
      <GridCore
        items={items}
        columns={taskColumns}
        loading={loading}
        onRowClick={openTaskDetail}
      />
    </div>
  );
}
```

### 2. Discovery Review Interface

```tsx
function DiscoveryReview() {
  const { items } = useGridData({ itemType: "discovery" });
  const [selected, setSelected] = useState<string[]>([]);
  
  const handleBulkAction = () => {
    console.log("Processing:", selected);
  };
  
  return (
    <>
      <button onClick={handleBulkAction}>
        Process Selected ({selected.length})
      </button>
      <GridCore
        items={items}
        columns={discoveryColumns}
        selectedIds={selected}
        onSelectionChange={setSelected}
      />
    </>
  );
}
```

### 3. Custom Cell Renderer

```tsx
const columns: GridColumn[] = [
  {
    key: "status",
    title: "Status",
    renderer: (item) => (
      <span className={`badge ${item.status}`}>
        {item.status}
      </span>
    ),
  },
];
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` / `Space` | Select row or activate sort |
| `Ctrl/Cmd + Click` | Toggle multi-select |
| `Shift + Click` | Range select |
| `Tab` | Navigate between focusable elements |

## Testing

```bash
# Run all grid tests
bun test src/web/src/components/__tests__/

# Run specific component tests
bun test src/web/src/components/__tests__/GridCore.test.ts

# Run hook tests
bun test src/web/src/hooks/__tests__/
```

See [grid-test-plan.md](./grid-test-plan.md) for detailed test coverage.

## Performance Tips

1. **Use virtualization for large datasets**: Enable `useVirtualization` hook
2. **Debounce search input**: Built into `useGridFilters`
3. **Memoize expensive computations**: Use `useMemo` for cell renderers
4. **Limit page size**: Use pagination instead of infinite scroll for 1000+ items

## Troubleshooting

### Grid not rendering

Check that `items` and `columns` props are provided and have the correct shape.

### Sorting not working

Ensure column has `sortable: true` and `onSort` handler is provided.

### Selection not working

Provide both `selectedIds` and `onSelectionChange` props.

## Related

- [Test Plan](./grid-test-plan.md)
- [Component Source](../src/web/src/components/)
- [Hooks Source](../src/web/src/hooks/)
- [Types](../src/web/src/types/grid.ts)

## Changelog

### v1.0.0 (2026-02-12)

- Initial release
- Multi-tab support (Tasks, Plans, Discoveries)
- Filtering and sorting
- Row selection with keyboard shortcuts
- Virtualization support
- Full test coverage

## License

MIT
