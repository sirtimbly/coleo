import { TabContainer } from "../components/TabContainer";
import { FilterBar } from "../components/FilterBar";
import { useTabSystem } from "../hooks/useTabSystem";
import { useGridFilters } from "../hooks/useGridFilters";
import { useGridData } from "../hooks/useGridData";
import type { GridItem } from "../types/grid";
import "./UnifiedGridPage.css";

export function UnifiedGridPage() {
	const { activeTab, tabs, setActiveTab, getActiveTabConfig } = useTabSystem();
	const activeTabConfig = getActiveTabConfig();

	const {
		filters,
		sort,
		searchQuery,
		setSearchQuery,
		addFilter,
		removeFilter,
		clearFilters,
		setSort,
		activeFilterCount,
	} = useGridFilters();

	const {
		items,
		loading,
		page,
		setPage,
		totalItems,
	} = useGridData({
		itemType: activeTab,
		pageSize: 50,
	});

	const handleItemClick = (item: GridItem) => {
		console.log("Clicked item:", item);
		// TODO: Navigate to item detail page
	};

	return (
		<div className="unified-grid-page">
			<header className="grid-page-header">
				<h1>Unified Grid View</h1>
			</header>

			<div className="grid-page-tabs">
				<div className="tab-list" role="tablist">
					{tabs.map((tab) => (
						<button
							key={tab.id}
							role="tab"
							aria-selected={activeTab === tab.id}
							className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
							onClick={() => {
								setActiveTab(tab.id);
								clearFilters();
							}}
							type="button"
						>
							{tab.label}
							<span className="tab-count">({totalItems})</span>
						</button>
					))}
				</div>
			</div>

			<FilterBar
				filters={filters}
				sort={sort}
				searchQuery={searchQuery}
				onSearchChange={setSearchQuery}
				onFilterAdd={addFilter}
				onFilterRemove={removeFilter}
				onClearFilters={clearFilters}
				onSortChange={setSort}
				activeFilterCount={activeFilterCount}
			/>

			<div className="grid-page-content">
				{/* TODO: Import and use GridCore with proper props */}
				<div className="grid-placeholder">
					{loading ? (
						<div>Loading {activeTab} items...</div>
					) : (
						<div>
							Showing {items.length} of {totalItems} {activeTab} items
							<pre>{JSON.stringify(items.slice(0, 2), null, 2)}</pre>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
