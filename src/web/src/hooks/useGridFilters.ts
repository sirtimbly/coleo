import { useState, useCallback, useEffect } from "react";
import type { GridFilter, GridSort } from "../types/grid";

export interface UseGridFiltersOptions {
	initialFilters?: GridFilter[];
	initialSort?: GridSort[];
	onFiltersChange?: (filters: GridFilter[]) => void;
	onSortChange?: (sort: GridSort[]) => void;
	debounceMs?: number;
}

export interface UseGridFiltersReturn {
	filters: GridFilter[];
	sort: GridSort[];
	searchQuery: string;
	setSearchQuery: (query: string) => void;
	addFilter: (filter: GridFilter) => void;
	removeFilter: (field: string) => void;
	clearFilters: () => void;
	setSort: (sort: GridSort[]) => void;
	activeFilterCount: number;
}

export function useGridFilters(
	options: UseGridFiltersOptions = {},
): UseGridFiltersReturn {
	const {
		initialFilters = [],
		initialSort = [],
		onFiltersChange,
		onSortChange,
		debounceMs = 300,
	} = options;

	const [filters, setFilters] = useState<GridFilter[]>(initialFilters);
	const [sort, setSortState] = useState<GridSort[]>(initialSort);
	const [searchQuery, setSearchQueryState] = useState("");
	const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

	// Debounce search query
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedSearchQuery(searchQuery);
		}, debounceMs);

		return () => clearTimeout(timer);
	}, [searchQuery, debounceMs]);

	// Update filters when debounced search changes
	useEffect(() => {
		if (debouncedSearchQuery) {
			const searchFilter: GridFilter = {
				field: "search",
				operator: "contains",
				value: debouncedSearchQuery,
			};

			setFilters((prev) => {
				const withoutSearch = prev.filter((f) => f.field !== "search");
				return [...withoutSearch, searchFilter];
			});
		} else {
			setFilters((prev) => prev.filter((f) => f.field !== "search"));
		}
	}, [debouncedSearchQuery]);

	// Notify parent of filter changes
	useEffect(() => {
		onFiltersChange?.(filters);
	}, [filters, onFiltersChange]);

	const setSearchQuery = useCallback((query: string) => {
		setSearchQueryState(query);
	}, []);

	const addFilter = useCallback((filter: GridFilter) => {
		setFilters((prev) => {
			const withoutField = prev.filter((f) => f.field !== filter.field);
			return [...withoutField, filter];
		});
	}, []);

	const removeFilter = useCallback((field: string) => {
		setFilters((prev) => prev.filter((f) => f.field !== field));
		if (field === "search") {
			setSearchQueryState("");
		}
	}, []);

	const clearFilters = useCallback(() => {
		setFilters([]);
		setSearchQueryState("");
	}, []);

	const setSort = useCallback(
		(newSort: GridSort[]) => {
			setSortState(newSort);
			onSortChange?.(newSort);
		},
		[onSortChange],
	);

	const activeFilterCount = filters.filter((f) => f.field !== "search").length;

	return {
		filters,
		sort,
		searchQuery,
		setSearchQuery,
		addFilter,
		removeFilter,
		clearFilters,
		setSort,
		activeFilterCount,
	};
}
