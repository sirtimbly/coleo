/**
 * Grid types for the multi-tabbed grid view
 * Provides unified interfaces for plan items, tasks, and discoveries
 */

// Grid types for the multi-tabbed grid view

export type GridItemType = "plan" | "task" | "discovery";

export interface GridItem {
	id: string;
	type: GridItemType;
	subject: string;
	description: string;
	status: string;
	priority?: string;
	createdAt: Date;
	updatedAt: Date;
	assignedTo?: string;
	metadata: Record<string, unknown>;
}

export interface GridColumn {
	key: string;
	title: string;
	width?: number;
	minWidth?: number;
	maxWidth?: number;
	resizable?: boolean;
	sortable?: boolean;
	filterable?: boolean;
	renderer?: (item: GridItem) => React.ReactNode;
}

export interface GridFilter {
	field: string;
	operator: "eq" | "neq" | "contains" | "gt" | "lt" | "gte" | "lte";
	value: string | number | boolean | Date;
}

export interface GridSort {
	field: string;
	direction: "asc" | "desc";
}

export interface GridPagination {
	page: number;
	pageSize: number;
	totalItems: number;
	totalPages: number;
}

export interface GridState {
	items: GridItem[];
	columns: GridColumn[];
	filters: GridFilter[];
	sort: GridSort[];
	pagination: GridPagination;
	loading: boolean;
	selectedIds: string[];
}

export interface GridDataResponse {
	items: GridItem[];
	total: number;
}

export interface GridDataRequest {
	page: number;
	pageSize: number;
	filters: GridFilter[];
	sort: GridSort[];
	search?: string;
}

// Tab configuration
export interface GridTab {
	id: GridItemType;
	label: string;
	icon?: string;
	columns: GridColumn[];
	defaultSort: GridSort[];
}
