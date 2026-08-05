/**
 * Focused React-to-Tabulator synchronization for ResourceSheet.
 *
 * The imperative table instance remains mounted while these effects reconcile
 * live rows, saved view configuration, selection, and externally persisted row
 * formatting. Active editors defer reconciliation until editing completes.
 */

import { useEffect } from "react";

import {
	areProjectedResourceRowsEqual,
	type ResourceSheetDataRow,
} from "./resource-sheet-model";
import { toTabulatorSort } from "./resource-sheet-tabulator";

import type { ProjectionSort } from "./types";
import type { ColumnDefinition, Tabulator } from "tabulator-tables";
import type { RefObject } from "react";

interface ResourceSheetSynchronizationOptions {
	tableRef: RefObject<Tabulator | null>;
	tableReadyRef: RefObject<boolean>;
	configurationDeferredRef: RefObject<boolean>;
	syncingColumnsRef: RefObject<boolean>;
	syncingSortRef: RefObject<boolean>;
	appliedColumnConfigurationRef: RefObject<string>;
	appliedSortConfigurationRef: RefObject<string>;
	sheetRows: ResourceSheetDataRow[];
	selectedRowId?: string;
	synchronizationRevision: number;
	columnConfigurationKey: string;
	tabulatorColumns: ColumnDefinition[];
	sortConfigurationKey: string;
	sort: readonly ProjectionSort[] | undefined;
	canMoveRows: boolean;
	formattingConfigurationKey: string;
	containerRef: RefObject<HTMLDivElement | null>;
}

export function useResourceSheetSynchronization({
	tableRef,
	tableReadyRef,
	configurationDeferredRef,
	syncingColumnsRef,
	syncingSortRef,
	appliedColumnConfigurationRef,
	appliedSortConfigurationRef,
	sheetRows,
	selectedRowId,
	synchronizationRevision,
	columnConfigurationKey,
	tabulatorColumns,
	sortConfigurationKey,
	sort,
	canMoveRows,
	formattingConfigurationKey,
	containerRef,
}: ResourceSheetSynchronizationOptions): void {
	useEffect(() => {
		const table = tableRef.current;
		if (!table || !tableReadyRef.current) return;
		const currentData = table.getData() as ResourceSheetDataRow[];
		if (areProjectedResourceRowsEqual(currentData, sheetRows)) return;
		if (table.element.classList.contains("tabulator-editing")) {
			configurationDeferredRef.current = true;
			return;
		}
		const currentIds = currentData.map((row) => String(row.__resourceId));
		const nextIds = sheetRows.map((row) => row.__resourceId);
		const sameOrderAndShape =
			currentIds.length === nextIds.length &&
			currentIds.every((id, index) => id === nextIds[index]);
		const sync = sameOrderAndShape && sheetRows.length > 0
			? table.updateData(sheetRows)
			: table.replaceData(sheetRows);
		void sync.then(() => {
			if (selectedRowId) table.selectRow(selectedRowId);
		});
	}, [
		configurationDeferredRef,
		selectedRowId,
		sheetRows,
		synchronizationRevision,
		tableReadyRef,
		tableRef,
	]);

	useEffect(() => {
		const table = tableRef.current;
		if (!table || !tableReadyRef.current) return;
		if (appliedColumnConfigurationRef.current === columnConfigurationKey) return;
		if (table.element.classList.contains("tabulator-editing")) {
			configurationDeferredRef.current = true;
			return;
		}
		appliedColumnConfigurationRef.current = columnConfigurationKey;
		syncingColumnsRef.current = true;
		table.setColumns(tabulatorColumns);
		syncingColumnsRef.current = false;
		table.getRows().forEach((row) => row.reformat());
	}, [
		appliedColumnConfigurationRef,
		columnConfigurationKey,
		configurationDeferredRef,
		synchronizationRevision,
		syncingColumnsRef,
		tableReadyRef,
		tableRef,
		tabulatorColumns,
	]);

	useEffect(() => {
		const table = tableRef.current;
		if (!table || !tableReadyRef.current) return;
		if (appliedSortConfigurationRef.current === sortConfigurationKey) {
			containerRef.current?.setAttribute(
				"data-manual-order",
				canMoveRows ? "enabled" : "disabled",
			);
			return;
		}
		if (table.element.classList.contains("tabulator-editing")) {
			configurationDeferredRef.current = true;
			return;
		}
		appliedSortConfigurationRef.current = sortConfigurationKey;
		syncingSortRef.current = true;
		table.setSort(toTabulatorSort(sort));
		syncingSortRef.current = false;
		containerRef.current?.setAttribute(
			"data-manual-order",
			canMoveRows ? "enabled" : "disabled",
		);
	}, [
		appliedSortConfigurationRef,
		canMoveRows,
		configurationDeferredRef,
		containerRef,
		sort,
		sortConfigurationKey,
		synchronizationRevision,
		syncingSortRef,
		tableReadyRef,
		tableRef,
	]);

	useEffect(() => {
		const table = tableRef.current;
		if (!table || !tableReadyRef.current) return;
		table.deselectRow();
		if (selectedRowId) table.selectRow(selectedRowId);
		table.getRows().forEach((row) => row.reformat());
	}, [
		formattingConfigurationKey,
		selectedRowId,
		tableReadyRef,
		tableRef,
	]);
}
