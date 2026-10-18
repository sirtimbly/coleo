import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { SlidersHorizontal } from "lucide-react";

import { ResourceSheet, type ResourceSheetColumn } from "./ResourceSheet";
import { ViewConfigurator } from "./ViewConfigurator";
import { useViewPreferences } from "./use-view-preferences";

import type { ArmRun, ViewPreferences } from "./types";

const PROCESS_COLUMNS: ResourceSheetColumn<ArmRun>[] = [
	{
		id: "workTitle",
		header: "Work",
		read: (run) => run.workTitle,
		readOnly: true,
		width: 360,
		className: "coleo-sheet-primary-cell",
	},
	{
		id: "status",
		header: "Status",
		read: (run) => run.status,
		readOnly: true,
		width: 120,
	},
	{
		id: "armName",
		header: "Arm",
		read: (run) => run.armName,
		readOnly: true,
		width: 160,
	},
	{
		id: "workKind",
		header: "Type",
		read: (run) => run.workKind,
		readOnly: true,
		width: 90,
	},
	{
		id: "startedAt",
		header: "Started",
		read: (run) => new Date(run.startedAt).toLocaleString(),
		readOnly: true,
		width: 180,
	},
	{
		id: "endedAt",
		header: "Ended",
		read: (run) => run.endedAt ? new Date(run.endedAt).toLocaleString() : "Running",
		readOnly: true,
		width: 180,
	},
];

export function ProcessSheet({
	runs,
	density,
	onOpenDetails,
}: {
	runs: ArmRun[];
	density: ViewPreferences["density"];
	onOpenDetails: (run: ArmRun) => void;
}) {
	const [configuring, setConfiguring] = useState(false);
	const { view, preferences, updatePreferences, updateShared } = useViewPreferences("processes-grid", {
		id: "processes-grid",
		name: "Processes",
		kind: "process",
		resourceKind: "run",
		description: "Read-only Arm process data grid",
		query: { resourceKinds: ["run"] },
		preferences: { density: "compact", sort: [] },
		shared: false,
	});
	const effectivePreferences = density === preferences.density
		? preferences
		: { ...preferences, density };
	const configurableColumns = useMemo(() => PROCESS_COLUMNS.map((column) => ({
		id: column.id,
		header: column.header,
		defaultWidth: column.width,
		hideable: column.id !== "workTitle",
	})), []);

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-secondary/35 px-3">
				<span className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
					Data grid · double-click a process to open its work
				</span>
				<Button size="sm" variant="ghost" onPress={() => setConfiguring(true)}>
					<SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
					View
				</Button>
			</div>
			<ResourceSheet
				rows={runs}
				columns={PROCESS_COLUMNS}
				preferences={effectivePreferences}
				onPreferencesChange={updatePreferences}
				onOpenRow={onOpenDetails}
				className="min-h-0 flex-1"
			/>
			<ViewConfigurator
				open={configuring}
				columns={configurableColumns}
				preferences={effectivePreferences}
				shared={view.shared}
				onChange={updatePreferences}
				onSharedChange={(shared) => void updateShared(shared)}
				onClose={() => setConfiguring(false)}
			/>
		</div>
	);
}
