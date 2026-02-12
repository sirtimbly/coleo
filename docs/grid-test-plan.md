# Grid Components Test Plan

## Components to Test

### 1. GridCore
**File:** `src/web/src/components/GridCore.tsx`

**Test Cases:**
- [ ] Renders without crashing
- [ ] Displays loading state correctly
- [ ] Displays empty state when no items
- [ ] Renders column headers
- [ ] Renders rows with data
- [ ] Handles row click events
- [ ] Handles row selection (single)
- [ ] Handles multi-selection with Ctrl/Cmd
- [ ] Handles range selection with Shift
- [ ] Handles sort click on column headers
- [ ] Cycles through sort states (asc → desc → none)
- [ ] Renders custom cell renderers
- [ ] Formats date values correctly
- [ ] Applies selected row styling
- [ ] Applies hover row styling
- [ ] Handles keyboard navigation (Enter, Space)
- [ ] Respects column width/minWidth/maxWidth

### 2. TabContainer
**File:** `src/web/src/components/TabContainer.tsx`

**Test Cases:**
- [ ] Renders all tabs
- [ ] Shows active tab indicator
- [ ] Switches tabs on click
- [ ] Updates grid data when tab changes
- [ ] Handles keyboard navigation (Enter, Space)
- [ ] Displays correct column configuration per tab

### 3. FilterBar
**File:** `src/web/src/components/FilterBar.tsx`

**Test Cases:**
- [ ] Renders search input
- [ ] Handles search input changes
- [ ] Displays filter chips
- [ ] Removes filter chips on click
- [ ] Shows clear filters button when filters active
- [ ] Clears all filters on button click
- [ ] Displays active filter count

### 4. Hooks

#### useGridData
**File:** `src/web/src/hooks/useGridData.ts`

**Test Cases:**
- [ ] Fetches data on mount
- [ ] Updates when itemType changes
- [ ] Handles pagination
- [ ] Handles loading state
- [ ] Handles errors
- [ ] Refreshes data on demand

#### useTabSystem
**File:** `src/web/src/hooks/useTabSystem.ts`

**Test Cases:**
- [ ] Initializes with default tab
- [ ] Returns correct tab configuration
- [ ] Updates active tab
- [ ] Returns correct columns for active tab

#### useGridFilters
**File:** `src/web/src/hooks/useGridFilters.ts`

**Test Cases:**
- [ ] Initializes with empty filters
- [ ] Adds filters
- [ ] Removes filters
- [ ] Clears all filters
- [ ] Debounces search input
- [ ] Counts active filters correctly

#### useVirtualization
**File:** `src/web/src/hooks/useVirtualization.ts`

**Test Cases:**
- [ ] Calculates total height correctly
- [ ] Handles empty items
- [ ] Handles large datasets
- [ ] Provides scrollToIndex function

## Test Utilities Needed

1. **Mock Data Factory**
   - Generate test GridItems
   - Generate test columns
   - Generate test filters

2. **Render Helpers**
   - Wrap components with providers
   - Mock hooks return values

3. **Event Simulators**
   - Click with modifiers (Ctrl, Shift)
   - Keyboard events

## Implementation Order

1. Create test utilities
2. Test hooks (useGridData, useTabSystem, useGridFilters, useVirtualization)
3. Test GridCore
4. Test TabContainer
5. Test FilterBar
6. Run full test suite
7. Open PR

## Coverage Goals

- Components: 80%+ coverage
- Hooks: 90%+ coverage
- Total: 85%+ coverage
