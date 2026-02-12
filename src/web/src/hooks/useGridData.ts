import { useState, useCallback, useEffect, useMemo } from "react";
import type {
	GridItem,
	GridItemType,
	GridDataRequest,
	GridDataResponse,
	GridFilter,
	GridSort,
} from "../types/grid";

interface UseGridDataOptions {
	itemType: GridItemType;
	pageSize?: number;
}

interface UseGridDataReturn {
	items: GridItem[];
	totalItems: number;
	loading: boolean;
	error: Error | null;
	page: number;
	setPage: (page: number) => void;
	filters: GridFilter[];
	setFilters: (filters: GridFilter[]) => void;
	sort: GridSort[];
	setSort: (sort: GridSort[]) => void;
	search: string;
	setSearch: (search: string) => void;
	refresh: () => Promise<void>;
}

export function useGridData(options: UseGridDataOptions): UseGridDataReturn {
	const { itemType, pageSize = 50 } = options;

	const [items, setItems] = useState<GridItem[]>([]);
	const [totalItems, setTotalItems] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const [page, setPage] = useState(1);
	const [filters, setFilters] = useState<GridFilter[]>([]);
	const [sort, setSort] = useState<GridSort[]>([]);
	const [search, setSearch] = useState("");

	const fetchData = useCallback(async () => {
		setLoading(true);
		setError(null);

		try {
			const request: GridDataRequest = {
				page,
				pageSize,
				filters,
				sort,
				search: search || undefined,
			};

			// TODO: Replace with actual API call
			const response = await mockFetchGridData(itemType, request);
			setItems(response.items);
			setTotalItems(response.total);
		} catch (err) {
			setError(err instanceof Error ? err : new Error(String(err)));
		} finally {
			setLoading(false);
		}
	}, [itemType, page, pageSize, filters, sort, search]);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const refresh = useCallback(async () => {
		await fetchData();
	}, [fetchData]);

	return useMemo(
		() => ({
			items,
			totalItems,
			loading,
			error,
			page,
			setPage,
			filters,
			setFilters,
			sort,
			setSort,
			search,
			setSearch,
			refresh,
		}),
		[
			items,
			totalItems,
			loading,
			error,
			page,
			filters,
			sort,
			search,
			refresh,
		],
	);
}

// Mock function - replace with actual API integration
async function mockFetchGridData(
	itemType: GridItemType,
	request: GridDataRequest,
): Promise<GridDataResponse> {
	// This is a placeholder - will be replaced with actual API call
	console.log(`Fetching ${itemType} data:`, request);

	return {
		items: [],
		total: 0,
	};
}
