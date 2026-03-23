---
## Goal

Fix browser crashes in the GoldenLayout workspace when interacting with the Tasks page, specifically when clicking on task row action buttons (chevron/"Open details" and "more actions" dropdown).

## Instructions

- The crash manifests as the browser hanging for a second and then going completely black
- This only happens in the new GoldenLayout workspace, not in the classic layout
- The crash is caused by an infinite React rendering loop ("Maximum update depth exceeded" error)

## Discoveries

**Root Cause**: The Tasks page had a bidirectional sync between filter state and URL search params that created an infinite loop in the GoldenLayout workspace context:

1. A `useEffect` rehydrated filter from URL params and called `setFilter()`
2. Another `useEffect` saved filter to URL params via `setSearchParams()`

In the GoldenLayout workspace, `setSearchParams` triggered a route change which updated the component props, causing the first effect to run again, creating a feedback loop.

**Fix Applied**: Changed the filter state initialization approach in `/Users/tim/developer/coleo/src/web/src/pages/TasksPage.tsx`:

- Initialize `filter` state directly using a lazy initialization function that reads from localStorage and URL params during component initialization (not in useEffect)
- Use a ref to track the previous filter value
- Only save to localStorage/URL when filter actually changes (comparing with previous value using JSON.stringify)

This breaks the infinite loop by removing the bidirectional sync pattern.

## Accomplished

✅ **Fixed in TasksPage.tsx** (lines 205-249):
- Changed filter state initialization to use lazy initialization function
- Modified save effect to only run when filter actually changes from previous value
- Verified the fix works by testing both action buttons in the GoldenLayout workspace

✅ **Testing completed**:
- Verified clicking "Open details" button opens task details in a split view without crashing
- Verified clicking "more actions" dropdown (row color menu) opens without crashing
- Page remains fully responsive after multiple interactions

## Summary

The infinite rendering loop in the Tasks page has been successfully fixed. The issue was caused by a bidirectional sync between React state and URL search params. The fix uses lazy initialization and proper comparison to prevent unnecessary updates, breaking the feedback loop that caused the crashes in the GoldenLayout workspace.

**File modified**: `/Users/tim/developer/coleo/src/web/src/pages/TasksPage.tsx` (lines 205-249)
---
