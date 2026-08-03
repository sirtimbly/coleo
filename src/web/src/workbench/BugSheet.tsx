/**
 * Bug spreadsheet projection.
 *
 * The sheet mirrors the task interaction model so future structured grids use
 * one consistent editing, insertion, configuration, and navigation language.
 */

import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { SlidersHorizontal } from "lucide-react";

import {
	PRIORITY_OPTIONS,
	STATUS_OPTIONS,
} from "@/components/bug-styles";
import {
	normalizeRowColor,
	RowFormattingToolbar,
	type RowFormattingValue,
} from "@/design-system/RowFormattingToolbar";
import type {
	Bug,
	BugMetadata,
	UiMetadata,
} from "@/lib";

import { ResourceSheet, type ResourceSheetColumn } from "./ResourceSheet";
import { normalizeTagValues } from "./tag-values";
import { useKnownTagOptions } from "./use-known-tag-options";
import { ViewConfigurator } from "./ViewConfigurator";
import { useViewPreferences } from "./use-view-preferences";

import type { BugUpdate } from "./resource-updates";

function readTags(bug: Bug): string[] {
	return bug.metadata?.ui?.tags ?? [];
}

function bugMetadataWithUi(bug: Bug, updates: Partial<UiMetadata>): BugMetadata {
	return {
		...bug.metadata,
		ui: {
			...bug.metadata?.ui,
			...updates,
		},
	};
}

function readBugFormatting(bug: Bug): RowFormattingValue {
	return {
		bold: bug.metadata?.ui?.bold ?? false,
		color: normalizeRowColor(bug.metadata?.ui?.color),
	};
}

const BUG_COLUMNS: ResourceSheetColumn<Bug>[] = [
	{
		id: "title",
		header: "Subject",
		read: (bug) => bug.title,
		width: 360,
		className: "coleo-sheet-primary-cell",
	},
	{
		id: "status",
		header: "Status",
		read: (bug) => bug.status,
		type: "dropdown",
		options: STATUS_OPTIONS,
		width: 128,
	},
	{
		id: "priority",
		header: "Priority",
		read: (bug) => bug.priority,
		type: "dropdown",
		options: PRIORITY_OPTIONS,
		readOnly: true,
		width: 104,
	},
	{
		id: "source",
		header: "Source",
		read: (bug) => bug.source,
		readOnly: true,
		width: 136,
	},
	{
		id: "tags",
		header: "Tags",
		read: readTags,
		type: "multiselect",
		width: 180,
	},
	{
		id: "assignee",
		header: "Arm",
		read: (bug) => bug.assigneeArmName ?? bug.assigneeArmId ?? "",
		readOnly: true,
		width: 140,
	},
	{
		id: "createdAt",
		header: "Created",
		read: (bug) => new Date(bug.createdAt).toLocaleString(),
		readOnly: true,
		width: 170,
	},
	{
		id: "updatedAt",
		header: "Updated",
		read: (bug) => new Date(bug.updatedAt).toLocaleString(),
		readOnly: true,
		width: 170,
	},
];

export function BugSheet({
	bugs,
	selectedBugId,
	onOpenDetails,
	onUpdateBug,
	onDelete,
	onCreateBugAt,
}: {
	bugs: Bug[];
	selectedBugId?: string;
	onOpenDetails?: (bug: Bug) => void;
	onUpdateBug?: (bugId: string, updates: BugUpdate) => void;
	onDelete?: (bug: Bug) => void;
	onCreateBugAt?: (index: number, title: string) => void;
}) {
	const [configuring, setConfiguring] = useState(false);
	const [formattingBugId, setFormattingBugId] = useState<string>();
	const tagOptions = useKnownTagOptions(bugs, readTags);
	const columns = useMemo(
		() => BUG_COLUMNS.map((column) => (
			column.id === "tags" ? { ...column, options: tagOptions } : column
		)),
		[tagOptions],
	);
	const { view, preferences, updatePreferences, updateShared } = useViewPreferences("bugs-sheet", {
		id: "bugs-sheet",
		name: "Bugs",
		kind: "sheet",
		resourceKind: "bug",
		description: "Editable bug spreadsheet",
		query: { resourceKinds: ["bug"] },
		preferences: {
			density: "compact",
			// Natural server order preserves between-row insertion.
			sort: [],
		},
		shared: false,
	});
	const configurableColumns = useMemo(
		() => columns.map((column) => ({
			id: column.id,
			header: column.header,
			defaultWidth: column.width,
			hideable: column.id !== "title",
		})),
		[columns],
	);
	const formattingBug = useMemo(
		() => bugs.find((bug) => bug.id === formattingBugId),
		[bugs, formattingBugId],
	);

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-secondary/35 px-3">
				{formattingBug ? (
					<RowFormattingToolbar
						label={formattingBug.title}
						value={readBugFormatting(formattingBug)}
						onChange={(updates) => {
							onUpdateBug?.(formattingBug.id, {
								metadata: bugMetadataWithUi(formattingBug, updates),
							});
						}}
					/>
				) : (
					<span className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
						Spreadsheet · select a row to format · double-click for details
					</span>
				)}
				<Button size="sm" variant="ghost" onPress={() => setConfiguring(true)}>
					<SlidersHorizontal className="h-3.5 w-3.5" />
					View
				</Button>
			</div>
			<ResourceSheet
				rows={bugs}
				columns={columns}
				preferences={preferences}
				onPreferencesChange={updatePreferences}
				onChange={(bug, columnId, value) => {
					if (columnId === "title" && typeof value === "string" && value.trim()) {
						onUpdateBug?.(bug.id, { title: value.trim() });
					}
					if (columnId === "status" && STATUS_OPTIONS.includes(value as Bug["status"])) {
						onUpdateBug?.(bug.id, { status: value as Bug["status"] });
					}
					if (columnId === "tags") {
						onUpdateBug?.(bug.id, {
							metadata: bugMetadataWithUi(bug, { tags: normalizeTagValues(value) }),
						});
					}
				}}
				onCreateRowAt={onCreateBugAt
					? (index) => onCreateBugAt(index, "New bug")
					: undefined}
				onDeleteRows={onDelete ? (removed) => {
					for (const bug of removed) onDelete?.(bug);
				} : undefined}
				onOpenRow={onOpenDetails}
				selectedRowId={selectedBugId}
				onRowSelectionChange={(bug) => setFormattingBugId(bug?.id)}
				getRowFormatting={readBugFormatting}
				className="min-h-0 flex-1"
			/>
			<ViewConfigurator
				open={configuring}
				columns={configurableColumns}
				preferences={preferences}
				shared={view.shared}
				onChange={updatePreferences}
				onSharedChange={(shared) => {
					void updateShared(shared);
				}}
				onClose={() => setConfiguring(false)}
			/>
		</div>
	);
}
