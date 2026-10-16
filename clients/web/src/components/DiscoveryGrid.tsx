import { useCallback, useEffect, useMemo, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import {
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	useReactTable,
	type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type Discovery as ApiDiscovery, type UiMetadata } from '@/lib';
import { cn } from '@/lib';
import { DiscoveryGridRow, type DiscoveryUpdate } from './DiscoveryGridRow';
import { FilterableGridHeader, SortableGridHeader, type GridFilterOption } from './GridColumnHeader';
import { useGridPreferences } from './grid-preferences';
import { selectedValuesFilter } from './grid-table';
import {
	DISCOVERY_GRID_COLUMNS_CLASS,
	DISCOVERY_GRID_DEFAULT_SORTING,
	DISCOVERY_GRID_KINDS,
	DISCOVERY_GRID_COLUMN_IDS,
	DISCOVERY_GRID_PREFERENCES_KEY,
	DISCOVERY_GRID_SEVERITIES,
	DISCOVERY_GRID_STATUSES,
} from './discovery-styles';

export type DiscoveryUiMeta = UiMetadata;

const DISCOVERY_COLUMNS: ColumnDef<ApiDiscovery>[] = [
	{
		id: 'order',
		accessorFn: (_discovery, index) => index,
		sortingFn: 'basic',
	},
	{
		id: 'title',
		accessorKey: 'title',
		sortingFn: 'alphanumeric',
	},
	{
		id: 'createdAt',
		accessorFn: (discovery) => new Date(discovery.createdAt).getTime(),
		sortingFn: 'basic',
	},
	{
		id: 'kind',
		accessorKey: 'kind',
		filterFn: selectedValuesFilter,
	},
	{
		id: 'severity',
		accessorKey: 'severity',
		filterFn: selectedValuesFilter,
	},
	{
		id: 'status',
		accessorKey: 'status',
		filterFn: selectedValuesFilter,
	},
];
function labelGridValue(value: string): string {
	return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function buildFilterOptions(values: readonly string[], rows: ApiDiscovery[], readValue: (discovery: ApiDiscovery) => string): GridFilterOption[] {
	return values.map((value) => ({
		value,
		label: labelGridValue(value),
		count: rows.filter((discovery) => readValue(discovery) === value).length,
	}));
}

interface DiscoveryGridProps {
	discoveries: ApiDiscovery[];
	isLoading?: boolean;
	hasNextPage?: boolean;
	isFetchingNextPage?: boolean;
	onLoadMore?: () => void | Promise<unknown>;
	selectedDiscoveryId?: string;
	onOpenDetails?: (discovery: ApiDiscovery) => void;
	onUpdateDiscovery?: (discoveryId: string, updates: DiscoveryUpdate) => void;
	onDelete?: (discoveryId: string) => void;
	className?: string;
}

export function DiscoveryGrid({
	discoveries,
	isLoading = false,
	hasNextPage = false,
	isFetchingNextPage = false,
	onLoadMore,
	selectedDiscoveryId,
	onOpenDetails,
	onUpdateDiscovery,
	onDelete,
	className,
}: DiscoveryGridProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const { sorting, columnFilters, setSorting, setColumnFilters } = useGridPreferences(
		DISCOVERY_GRID_PREFERENCES_KEY,
		DISCOVERY_GRID_COLUMN_IDS,
		DISCOVERY_GRID_DEFAULT_SORTING,
	);

	// TanStack Table intentionally exposes non-memoizable callbacks; React Compiler safely skips this component.
	// eslint-disable-next-line react-hooks/incompatible-library
	const table = useReactTable({
		data: discoveries,
		columns: DISCOVERY_COLUMNS,
		getRowId: (discovery) => discovery.id,
		state: { sorting, columnFilters },
		onSortingChange: setSorting,
		onColumnFiltersChange: setColumnFilters,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});

	const displayRows = table.getRowModel().rows;

	const kindOptions = useMemo(
		() => buildFilterOptions(DISCOVERY_GRID_KINDS, discoveries, (discovery) => discovery.kind),
		[discoveries],
	);
	const severityOptions = useMemo(
		() => buildFilterOptions(DISCOVERY_GRID_SEVERITIES, discoveries, (discovery) => discovery.severity),
		[discoveries],
	);
	const statusOptions = useMemo(
		() => buildFilterOptions(DISCOVERY_GRID_STATUSES, discoveries, (discovery) => discovery.status),
		[discoveries],
	);

	const virtualItemCount = displayRows.length > 0 || hasNextPage ? displayRows.length + 1 : 0;
	const rowVirtualizer = useVirtualizer({
		count: virtualItemCount,
		getScrollElement: () => containerRef.current,
		estimateSize: () => 56,
		getItemKey: (index) => displayRows[index]?.id ?? 'discovery-grid-end',
		overscan: 10,
		measureElement: (element) => element.getBoundingClientRect().height,
	});
	const virtualItems = rowVirtualizer.getVirtualItems();
	const lastVirtualIndex = virtualItems.at(-1)?.index ?? -1;

	useEffect(() => {
		if (
			hasNextPage &&
			!isFetchingNextPage &&
			lastVirtualIndex >= Math.max(0, displayRows.length - 10)
		) {
			void onLoadMore?.();
		}
	}, [displayRows.length, hasNextPage, isFetchingNextPage, lastVirtualIndex, onLoadMore]);

	const handleUpdate = useCallback(
		(discoveryId: string, updates: DiscoveryUpdate) => {
			onUpdateDiscovery?.(discoveryId, updates);
		},
		[onUpdateDiscovery],
	);

	const handleDelete = useCallback(
		(discoveryId: string) => {
			onDelete?.(discoveryId);
		},
		[onDelete],
	);

	return (
		<div className={cn('flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card', className)}>
			<div
				className={cn(
					'mx-2 grid min-w-[900px] items-center gap-2 border-b border-border px-3 py-2.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground',
					DISCOVERY_GRID_COLUMNS_CLASS,
				)}
			>
				<SortableGridHeader label="Order" column={table.getColumn('order')!} className="justify-end" />
				<div aria-hidden="true" />
				<SortableGridHeader label="Title" column={table.getColumn('title')!} />
				<FilterableGridHeader label="Kind" column={table.getColumn('kind')!} options={kindOptions} />
				<FilterableGridHeader label="Severity" column={table.getColumn('severity')!} options={severityOptions} />
				<FilterableGridHeader label="Status" column={table.getColumn('status')!} options={statusOptions} />
				<SortableGridHeader label="Created" column={table.getColumn('createdAt')!} />
				<div className="border-l border-border/60 pl-3 text-right">Actions</div>
			</div>
			<div ref={containerRef} className="min-h-0 min-w-[900px] flex-1 overflow-y-auto overflow-x-hidden p-2">
				{displayRows.length === 0 && !isLoading ? (
					<div className="p-6 text-center text-muted-foreground text-sm">
						{discoveries.length > 0 ? 'No discoveries match the selected column filters' : 'No discoveries found'}
					</div>
				) : (
					<div
						className="relative w-full"
						style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
					>
						{virtualItems.map((virtualRow) => {
							if (virtualRow.index >= displayRows.length) {
								return (
									<div
										key="discovery-grid-end"
										ref={rowVirtualizer.measureElement}
										data-index={virtualRow.index}
										className="absolute left-0 top-0 flex w-full items-center justify-center"
										style={{ transform: `translateY(${virtualRow.start}px)`, height: `${virtualRow.size}px` }}
									>
										{hasNextPage ? (
											<div className="flex h-12 items-center justify-center gap-2 text-xs text-muted-foreground">
												<LoaderCircle className={cn('h-4 w-4', isFetchingNextPage && 'animate-spin')} />
												{isFetchingNextPage ? 'Loading more discoveries...' : 'Loading more discoveries'}
											</div>
										) : null}
									</div>
								);
							}

							const row = displayRows[virtualRow.index];
							const discovery = row.original;
							return (
								<div
									key={discovery.id}
									ref={rowVirtualizer.measureElement}
									data-index={virtualRow.index}
									className="absolute left-0 top-0 w-full"
									style={{ transform: `translateY(${virtualRow.start}px)` }}
								>
									<DiscoveryGridRow
										discovery={discovery}
										index={virtualRow.index}
										isSelected={discovery.id === selectedDiscoveryId}
										onOpenDetails={onOpenDetails}
										onUpdateDiscovery={handleUpdate}
										onDelete={handleDelete}
									/>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
