import { useState, useCallback, useMemo } from "react";
import type { GridItem, GridColumn, GridSort } from "../types/grid";

export interface GridCoreProps {
	items: GridItem[];
	columns: GridColumn[];
	loading?: boolean;
	sort?: GridSort[];
	onSort?: (sort: GridSort[]) => void;
	selectedIds?: string[];
	onSelectionChange?: (selectedIds: string[]) => void;
	onRowClick?: (item: GridItem) => void;
	emptyMessage?: string;
}

export function GridCore({
	items,
	columns,
	loading = false,
	sort = [],
	onSort,
	selectedIds = [],
	onSelectionChange,
	onRowClick,
	emptyMessage = "No items to display",
}: GridCoreProps) {
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);

	const handleSortClick = useCallback(
		(columnKey: string) => {
			if (!onSort) return;

			const existingSort = sort.find((s) => s.field === columnKey);
			let newSort: GridSort[];

			if (!existingSort) {
				newSort = [{ field: columnKey, direction: "asc" }];
			} else if (existingSort.direction === "asc") {
				newSort = [{ field: columnKey, direction: "desc" }];
			} else {
				newSort = [];
			}

			onSort(newSort);
		},
		[sort, onSort],
	);

	const handleRowClick = useCallback(
		(item: GridItem, event: React.MouseEvent) => {
			if (onRowClick) {
				onRowClick(item);
			}

			if (onSelectionChange) {
				const isSelected = selectedIds.includes(item.id);
				let newSelection: string[];

				if (event.ctrlKey || event.metaKey) {
					newSelection = isSelected
						? selectedIds.filter((id) => id !== item.id)
						: [...selectedIds, item.id];
				} else if (event.shiftKey && selectedIds.length > 0) {
					const lastSelected = selectedIds[selectedIds.length - 1];
					const lastIndex = items.findIndex((i) => i.id === lastSelected);
					const currentIndex = items.findIndex((i) => i.id === item.id);
					const start = Math.min(lastIndex, currentIndex);
					const end = Math.max(lastIndex, currentIndex);
					const rangeIds = items.slice(start, end + 1).map((i) => i.id);
					newSelection = [...new Set([...selectedIds, ...rangeIds])];
				} else {
					newSelection = isSelected ? [] : [item.id];
				}

				onSelectionChange(newSelection);
			}
		},
		[items, selectedIds, onSelectionChange, onRowClick],
	);

	const getSortIndicator = useCallback(
		(columnKey: string) => {
			const sortItem = sort.find((s) => s.field === columnKey);
			if (!sortItem) return null;
			return sortItem.direction === "asc" ? "↑" : "↓";
		},
		[sort],
	);

	const renderCell = useCallback(
		(item: GridItem, column: GridColumn) => {
			if (column.renderer) {
				return column.renderer(item);
			}

			const value = item[column.key as keyof GridItem];
			if (value instanceof Date) {
				return value.toLocaleDateString();
			}
			return String(value ?? "");
		},
		[],
	);

	const gridRows = useMemo(() => {
		return items.map((item) => ({
			item,
			isSelected: selectedIds.includes(item.id),
			isHovered: hoveredRow === item.id,
		}));
	}, [items, selectedIds, hoveredRow]);

	if (loading) {
		return (
			<div className="grid-container loading" role="status" aria-live="polite">
				<div className="grid-loading-message">Loading...</div>
			</div>
		);
	}

	if (items.length === 0) {
		return (
			<div className="grid-container empty" role="status">
				<div className="grid-empty-message">{emptyMessage}</div>
			</div>
		);
	}

	return (
		<div className="grid-container" role="grid" aria-label="Data grid">
			<div className="grid-header" role="rowgroup">
				<div className="grid-header-row" role="row">
					{columns.map((column) => (
						<div
							key={column.key}
							className={`grid-header-cell ${column.sortable ? "sortable" : ""}`}
							role="columnheader"
							aria-sort={
								sort.find((s) => s.field === column.key)?.direction === "asc"
									? "ascending"
									: sort.find((s) => s.field === column.key)?.direction === "desc"
										? "descending"
										: "none"
							}
							style={{
								width: column.width,
								minWidth: column.minWidth,
								maxWidth: column.maxWidth,
							}}
							onClick={() => column.sortable && handleSortClick(column.key)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									column.sortable && handleSortClick(column.key);
								}
							}}
							tabIndex={column.sortable ? 0 : -1}
						>
							<span className="grid-header-title">{column.title}</span>
							{column.sortable && (
								<span className="grid-sort-indicator" aria-hidden="true">
									{getSortIndicator(column.key)}
								</span>
							)}
						</div>
					))}
				</div>
			</div>
			<div className="grid-body" role="rowgroup">
				{gridRows.map(({ item, isSelected, isHovered }) => (
					<div
						key={item.id}
						className={`grid-row ${isSelected ? "selected" : ""} ${isHovered ? "hovered" : ""}`}
						role="row"
						aria-selected={isSelected}
						onClick={(e) => handleRowClick(item, e)}
						onMouseEnter={() => setHoveredRow(item.id)}
						onMouseLeave={() => setHoveredRow(null)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								handleRowClick(item, e as unknown as React.MouseEvent);
							}
						}}
						tabIndex={0}
					>
						{columns.map((column) => (
							<div
								key={`${item.id}-${column.key}`}
								className="grid-cell"
								role="gridcell"
								style={{
									width: column.width,
									minWidth: column.minWidth,
									maxWidth: column.maxWidth,
								}}
							>
								{renderCell(item, column)}
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
