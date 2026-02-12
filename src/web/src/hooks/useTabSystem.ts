import { useState, useCallback } from "react";
import type { GridItemType, GridTab } from "../types/grid";

export interface TabSystemState {
	activeTab: GridItemType;
	tabs: GridTab[];
}

export interface UseTabSystemOptions {
	defaultTab?: GridItemType;
	onTabChange?: (tab: GridItemType) => void;
}

export interface UseTabSystemReturn {
	activeTab: GridItemType;
	tabs: GridTab[];
	setActiveTab: (tab: GridItemType) => void;
	getActiveTabConfig: () => GridTab | undefined;
}

const DEFAULT_TABS: GridTab[] = [
	{
		id: "task",
		label: "Tasks",
		columns: [
			{ key: "subject", title: "Subject", width: 300, sortable: true },
			{ key: "status", title: "Status", width: 120, sortable: true },
			{ key: "priority", title: "Priority", width: 100, sortable: true },
			{ key: "assignedTo", title: "Assigned To", width: 150 },
			{ key: "updatedAt", title: "Last Updated", width: 150, sortable: true },
		],
		defaultSort: [{ field: "updatedAt", direction: "desc" }],
	},
	{
		id: "plan",
		label: "Plan Items",
		columns: [
			{ key: "subject", title: "Item", width: 400, sortable: true },
			{ key: "status", title: "Status", width: 120, sortable: true },
			{ key: "updatedAt", title: "Last Updated", width: 150, sortable: true },
		],
		defaultSort: [{ field: "updatedAt", direction: "desc" }],
	},
	{
		id: "discovery",
		label: "Discoveries",
		columns: [
			{ key: "subject", title: "Discovery", width: 350, sortable: true },
			{ key: "status", title: "Status", width: 120, sortable: true },
			{ key: "priority", title: "Priority", width: 100, sortable: true },
			{ key: "updatedAt", title: "Found", width: 150, sortable: true },
		],
		defaultSort: [{ field: "updatedAt", direction: "desc" }],
	},
];

export function useTabSystem(options: UseTabSystemOptions = {}): UseTabSystemReturn {
	const { defaultTab = "task", onTabChange } = options;
	const [activeTab, setActiveTabState] = useState<GridItemType>(defaultTab);
	const [tabs] = useState<GridTab[]>(DEFAULT_TABS);

	const setActiveTab = useCallback(
		(tab: GridItemType) => {
			setActiveTabState(tab);
			if (onTabChange) {
				onTabChange(tab);
			}
		},
		[onTabChange],
	);

	const getActiveTabConfig = useCallback(() => {
		return tabs.find((tab) => tab.id === activeTab);
	}, [tabs, activeTab]);

	return {
		activeTab,
		tabs,
		setActiveTab,
		getActiveTabConfig,
	};
}
