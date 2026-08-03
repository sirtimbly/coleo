/**
 * Task and plan-item spreadsheet projection.
 *
 * Handsontable supplies the Excel-like interaction model. Subject and status
 * are intentionally editable inline; richer task fields continue to open in a
 * dedicated Golden Layout detail panel.
 */

import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { SlidersHorizontal } from "lucide-react";

import { PRIORITY_OPTIONS } from "@/components/task-styles";
import {
	normalizeRowColor,
	RowFormattingToolbar,
	type RowFormattingValue,
} from "@/design-system/RowFormattingToolbar";
import type {
	Task,
	TaskMetadata,
	UiMetadata,
} from "@/lib";

import {
	ResourceSheet,
	type ResourceSheetColumn,
	type ResourceSheetRowMove,
} from "./ResourceSheet";
import { normalizeTagValues } from "./tag-values";
import { useKnownTagOptions } from "./use-known-tag-options";
import { ViewConfigurator } from "./ViewConfigurator";
import { useViewPreferences } from "./use-view-preferences";

import type { TaskUpdate } from "./resource-updates";

const TASK_STATUSES: Task["status"][] = [
	"pending",
	"claimed",
	"in_progress",
	"completing",
	"completed",
	"blocked",
	"failed",
	"cancelled",
];

function readTags(task: Task): string[] {
	return task.metadata.ui?.tags ?? [];
}

function taskMetadataWithUi(task: Task, updates: Partial<UiMetadata>): TaskMetadata {
	return {
		...task.metadata,
		ui: {
			...task.metadata.ui,
			...updates,
		},
	};
}

function readTaskFormatting(task: Task): RowFormattingValue {
	return {
		bold: task.metadata.ui?.bold ?? false,
		color: normalizeRowColor(task.metadata.ui?.color),
	};
}

const TASK_COLUMNS: ResourceSheetColumn<Task>[] = [
	{
		id: "subject",
		header: "Subject",
		read: (task) => task.subject,
		width: 360,
		className: "coleo-sheet-primary-cell",
	},
	{
		id: "status",
		header: "Status",
		read: (task) => task.status,
		type: "dropdown",
		options: TASK_STATUSES,
		statusEntity: "task",
		width: 128,
	},
	{
		id: "priority",
		header: "Priority",
		read: (task) => task.priority,
		type: "dropdown",
		options: PRIORITY_OPTIONS,
		readOnly: true,
		width: 104,
	},
	{
		id: "phase",
		header: "Phase",
		read: (task) => task.phase ?? "",
		readOnly: true,
		width: 130,
	},
	{
		id: "domain",
		header: "Domain",
		read: (task) => task.domain ?? "",
		readOnly: true,
		width: 120,
	},
	{
		id: "assignedArm",
		header: "Arm",
		read: (task) => task.assignedArmName ?? task.assignedTo ?? "",
		readOnly: true,
		width: 140,
	},
	{
		id: "progress",
		header: "Progress",
		read: (task) => task.progress ?? 0,
		type: "numeric",
		readOnly: true,
		width: 92,
	},
	{
		id: "sourceType",
		header: "Source",
		read: (task) => task.sourceType,
		readOnly: true,
		width: 104,
	},
	{
		id: "tags",
		header: "Tags",
		read: readTags,
		type: "multiselect",
		allowCreateOptions: true,
		optionLabel: "tag",
		width: 180,
	},
	{
		id: "updatedAt",
		header: "Updated",
		read: (task) => new Date(task.updatedAt).toLocaleString(),
		readOnly: true,
		width: 170,
	},
];

export function TaskSheet({
	tasks,
	selectedTaskId,
	onOpenDetails,
	onUpdateTask,
	onDelete,
	onCreateTaskAt,
	onRowsMove,
	onLoadMore,
	hasNextPage,
	viewId = "tasks-sheet",
}: {
	tasks: Task[];
	selectedTaskId?: string;
	onOpenDetails?: (task: Task) => void;
	onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
	onDelete?: (task: Task) => void;
	onCreateTaskAt?: (index: number, subject: string) => void;
	onRowsMove?: (moves: ResourceSheetRowMove<Task>[]) => void | Promise<void>;
	onLoadMore?: () => void;
	hasNextPage?: boolean;
	viewId?: string;
}) {
	const [configuring, setConfiguring] = useState(false);
	const [formattingTaskId, setFormattingTaskId] = useState<string>();
	const tagOptions = useKnownTagOptions(tasks, readTags);
	const columns = useMemo(
		() => TASK_COLUMNS.map((column) => (
			column.id === "tags" ? { ...column, options: tagOptions } : column
		)),
		[tagOptions],
	);
	const { view, preferences, updatePreferences, updateShared } = useViewPreferences(viewId, {
		id: viewId,
		name: viewId === "plan-items-sheet" ? "Plan items" : "Tasks",
		kind: "sheet",
		resourceKind: "task",
		description: "Editable task spreadsheet",
		query: viewId === "plan-items-sheet"
			? { resourceKinds: ["task"], filters: [{ field: "sourceType", operator: "equals", value: "plan" }] }
			: { resourceKinds: ["task"] },
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
			hideable: column.id !== "subject",
		})),
		[columns],
	);
	const formattingTask = useMemo(
		() => tasks.find((task) => task.id === formattingTaskId),
		[formattingTaskId, tasks],
	);

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-secondary/35 px-3">
				{formattingTask ? (
					<RowFormattingToolbar
						label={formattingTask.subject}
						value={readTaskFormatting(formattingTask)}
						onChange={(updates) => {
							onUpdateTask?.(formattingTask.id, {
								metadata: taskMetadataWithUi(formattingTask, updates),
							});
						}}
					/>
				) : (
					<span className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
						Spreadsheet · drag the Order gutter · double-click to edit
					</span>
				)}
				<Button size="sm" variant="ghost" onPress={() => setConfiguring(true)}>
					<SlidersHorizontal className="h-3.5 w-3.5" />
					View
				</Button>
			</div>
			<ResourceSheet
				rows={tasks}
				columns={columns}
				preferences={preferences}
				onPreferencesChange={updatePreferences}
				onChange={(task, columnId, value) => {
					if (columnId === "subject" && typeof value === "string" && value.trim()) {
						onUpdateTask?.(task.id, { subject: value.trim() });
					}
					if (columnId === "status" && TASK_STATUSES.includes(value as Task["status"])) {
						onUpdateTask?.(task.id, { status: value as Task["status"] });
					}
					if (columnId === "tags") {
						onUpdateTask?.(task.id, {
							metadata: taskMetadataWithUi(task, { tags: normalizeTagValues(value) }),
						});
					}
				}}
				onCreateRowAt={onCreateTaskAt
					? (index) => onCreateTaskAt(index, "New task")
					: undefined}
				onDeleteRows={onDelete ? (removed) => {
					for (const task of removed) onDelete?.(task);
				} : undefined}
				onRowsMove={onRowsMove}
				onOpenRow={onOpenDetails}
				selectedRowId={selectedTaskId}
				onNearEnd={hasNextPage ? onLoadMore : undefined}
				onRowSelectionChange={(task) => setFormattingTaskId(task?.id)}
				getRowFormatting={readTaskFormatting}
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
