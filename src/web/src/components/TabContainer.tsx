import { GridCore } from "./GridCore";
import { useTabSystem } from "../hooks/useTabSystem";
import { useGridData } from "../hooks/useGridData";
import type { GridItem } from "../types/grid";
import "./TabContainer.css";

export interface TabContainerProps {
	onItemClick?: (item: GridItem) => void;
	onSelectionChange?: (selectedIds: string[]) => void;
}

export function TabContainer({
	onItemClick,
	onSelectionChange,
}: TabContainerProps) {
	const { activeTab, tabs, setActiveTab, getActiveTabConfig } = useTabSystem();
	const activeTabConfig = getActiveTabConfig();

	const {
		items,
		loading,
		sort,
		setSort,
	} = useGridData({
		itemType: activeTab,
		pageSize: 50,
	});

	const handleTabClick = (tabId: typeof activeTab) => {
		setActiveTab(tabId);
	};

	return (
		<div className="tab-container">
			<div className="tab-header" role="tablist">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						role="tab"
						aria-selected={activeTab === tab.id}
						className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
						onClick={() => handleTabClick(tab.id)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								handleTabClick(tab.id);
							}
						}}
						tabIndex={0}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div className="tab-content">
				<GridCore
					items={items}
					columns={activeTabConfig?.columns ?? []}
					loading={loading}
					sort={sort}
					onSort={setSort}
					onRowClick={onItemClick}
				/>
			</div>
		</div>
	);
}
