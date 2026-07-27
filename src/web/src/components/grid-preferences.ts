import { useEffect, useState } from "react";

import type { Dispatch, SetStateAction } from "react";
import type { ColumnFiltersState, SortingState } from "@tanstack/react-table";

interface GridPreferences {
	sorting: SortingState;
	columnFilters: ColumnFiltersState;
}

interface PersistedGridPreferences extends GridPreferences {
	setSorting: Dispatch<SetStateAction<SortingState>>;
	setColumnFilters: Dispatch<SetStateAction<ColumnFiltersState>>;
}

function readPreferences(
	storageKey: string,
	columnIds: ReadonlySet<string>,
	defaultSorting: SortingState,
): GridPreferences {
	if (typeof window === "undefined") {
		return { sorting: defaultSorting, columnFilters: [] };
	}

	try {
		const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as unknown;
		if (!saved || typeof saved !== "object") {
			return { sorting: defaultSorting, columnFilters: [] };
		}

		const value = saved as Partial<GridPreferences>;
		const savedSorting = Array.isArray(value.sorting)
			? value.sorting.filter(
				(entry): entry is SortingState[number] =>
					Boolean(entry) &&
					typeof entry === "object" &&
					typeof entry.id === "string" &&
					columnIds.has(entry.id) &&
					typeof entry.desc === "boolean",
			)
			: defaultSorting;
		const sorting = Array.isArray(value.sorting) && value.sorting.length > 0 && savedSorting.length === 0
			? defaultSorting
			: savedSorting;
		const columnFilters = Array.isArray(value.columnFilters)
			? value.columnFilters.flatMap((entry) => {
				if (
					!entry ||
					typeof entry !== "object" ||
					typeof entry.id !== "string" ||
					!columnIds.has(entry.id) ||
					!Array.isArray(entry.value)
				) {
					return [];
				}
				const filterValue = entry.value.filter((item): item is string => typeof item === "string");
				return filterValue.length > 0 ? [{ id: entry.id, value: filterValue }] : [];
			})
			: [];

		return { sorting, columnFilters };
	} catch {
		return { sorting: defaultSorting, columnFilters: [] };
	}
}

export function useGridPreferences(
	storageKey: string,
	columnIds: ReadonlySet<string>,
	defaultSorting: SortingState,
): PersistedGridPreferences {
	const [initialPreferences] = useState(() => readPreferences(storageKey, columnIds, defaultSorting));
	const [sorting, setSorting] = useState<SortingState>(initialPreferences.sorting);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(initialPreferences.columnFilters);

	useEffect(() => {
		try {
			window.localStorage.setItem(storageKey, JSON.stringify({ sorting, columnFilters }));
		} catch {
			// The grid remains usable when browser storage is unavailable or full.
		}
	}, [columnFilters, sorting, storageKey]);

	return { sorting, columnFilters, setSorting, setColumnFilters };
}
