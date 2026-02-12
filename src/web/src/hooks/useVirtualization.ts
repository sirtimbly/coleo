import { useMemo, useCallback } from "react";
import type { GridItem } from "../types/grid";

export interface UseVirtualizationOptions {
	items: GridItem[];
	rowHeight: number;
	containerHeight: number;
	overscan?: number;
}

export interface UseVirtualizationReturn {
	virtualItems: GridItem[];
	startIndex: number;
	endIndex: number;
	totalHeight: number;
	scrollToIndex: (index: number) => void;
}

export function useVirtualization(
	options: UseVirtualizationOptions,
): UseVirtualizationReturn {
	const { items, rowHeight, containerHeight, overscan = 5 } = options;

	// Calculate visible range based on scroll position
	const calculateVisibleRange = useCallback(
		(scrollTop: number) => {
			const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
			const visibleCount = Math.ceil(containerHeight / rowHeight);
			const endIndex = Math.min(
				items.length - 1,
				startIndex + visibleCount + overscan * 2,
			);

			return { startIndex, endIndex };
		},
		[items.length, rowHeight, containerHeight, overscan],
	);

	// Get virtual items for current viewport
	const virtualItems = useMemo(() => {
		// For now, return all items (full virtualization requires scroll container ref)
		// TODO: Implement proper virtualization with scroll tracking
		return items;
	}, [items]);

	const totalHeight = useMemo(() => {
		return items.length * rowHeight;
	}, [items.length, rowHeight]);

	const scrollToIndex = useCallback(
		(index: number) => {
			const scrollTop = index * rowHeight;
			// TODO: Implement scroll to index when container ref is available
			console.log(`Scroll to index ${index}, position: ${scrollTop}`);
		},
		[rowHeight],
	);

	return {
		virtualItems,
		startIndex: 0,
		endIndex: items.length - 1,
		totalHeight,
		scrollToIndex,
	};
}

// Memoization helpers for expensive computations
export function useMemoizedFilters<T>(
	items: T[],
	filterFn: (item: T) => boolean,
	deps: unknown[],
): T[] {
	return useMemo(() => {
		return items.filter(filterFn);
	}, [items, ...deps]);
}

export function useMemoizedSort<T>(
	items: T[],
	sortFn: (a: T, b: T) => number,
	deps: unknown[],
): T[] {
	return useMemo(() => {
		return [...items].sort(sortFn);
	}, [items, ...deps]);
}
