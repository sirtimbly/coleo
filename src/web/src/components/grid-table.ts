import type { Row } from "@tanstack/react-table";

export function selectedValuesFilter<TData>(row: Row<TData>, columnId: string, filterValue: unknown): boolean {
	const selected = Array.isArray(filterValue) ? filterValue.map(String) : [];
	return selected.length === 0 || selected.includes(String(row.getValue(columnId)));
}

export function selectedTagsFilter<TData>(row: Row<TData>, columnId: string, filterValue: unknown): boolean {
	const selected = Array.isArray(filterValue) ? filterValue.map(String) : [];
	const tags = row.getValue(columnId);
	return selected.length === 0 || (Array.isArray(tags) && tags.some((tag) => selected.includes(String(tag))));
}

export const GRID_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

export function formatGridDate(value: string): string {
	const timestamp = new Date(value);
	return Number.isNaN(timestamp.getTime()) ? value : GRID_DATE_FORMATTER.format(timestamp);
}
