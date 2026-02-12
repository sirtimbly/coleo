import { useGridFilters } from "../hooks/useGridFilters";
import type { GridFilter, GridSort } from "../types/grid";

export interface FilterBarProps {
	filters: GridFilter[];
	sort: GridSort[];
	searchQuery: string;
	onSearchChange: (query: string) => void;
	onFilterAdd: (filter: GridFilter) => void;
	onFilterRemove: (field: string) => void;
	onClearFilters: () => void;
	onSortChange: (sort: GridSort[]) => void;
	activeFilterCount: number;
}

export function FilterBar({
	filters,
	sort,
	searchQuery,
	onSearchChange,
	onFilterRemove,
	onClearFilters,
	activeFilterCount,
}: FilterBarProps) {
	const nonSearchFilters = filters.filter((f) => f.field !== "search");

	return (
		<div className="filter-bar">
			<div className="filter-search">
				<input
					type="text"
					placeholder="Search..."
					value={searchQuery}
					onChange={(e) => onSearchChange(e.target.value)}
					className="filter-search-input"
					aria-label="Search items"
				/>
			</div>

			<div className="filter-chips">
				{nonSearchFilters.map((filter) => (
					<span key={filter.field} className="filter-chip">
						<span className="filter-chip-text">
							{filter.field}: {String(filter.value)}
						</span>
						<button
							className="filter-chip-remove"
							onClick={() => onFilterRemove(filter.field)}
							aria-label={`Remove ${filter.field} filter`}
							type="button"
						>
							&times;
						</button>
					</span>
				))}
			</div>

			{activeFilterCount > 0 && (
				<button
					className="filter-clear-btn"
					onClick={onClearFilters}
					type="button"
				>
					Clear filters ({activeFilterCount})
				</button>
			)}
		</div>
	);
}
