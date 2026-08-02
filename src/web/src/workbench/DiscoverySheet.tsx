/**
 * Discovery spreadsheet projection.
 *
 * Discoveries are the first non-task resource using the shared sheet
 * infrastructure. Only workflow status is editable; evidence and provenance
 * remain read-only and can later open in a dedicated inspector projection.
 */

import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { SlidersHorizontal } from "lucide-react";

import { DISCOVERY_GRID_STATUSES } from "@/components/discovery-styles";

import { ResourceSheet, type ResourceSheetColumn } from "./ResourceSheet";
import { ViewConfigurator } from "./ViewConfigurator";
import { useViewPreferences } from "./use-view-preferences";

import type { Discovery } from "@/lib";

const DISCOVERY_COLUMNS: ResourceSheetColumn<Discovery>[] = [
	{
		id: "title",
		header: "Subject",
		read: (discovery) => discovery.title,
		readOnly: true,
		width: 360,
		className: "coleo-sheet-primary-cell",
	},
	{
		id: "status",
		header: "Status",
		read: (discovery) => discovery.status,
		type: "dropdown",
		options: [...DISCOVERY_GRID_STATUSES],
		width: 132,
	},
	{
		id: "severity",
		header: "Severity",
		read: (discovery) => discovery.severity,
		readOnly: true,
		width: 110,
	},
	{
		id: "kind",
		header: "Kind",
		read: (discovery) => discovery.kind,
		readOnly: true,
		width: 140,
	},
	{
		id: "armName",
		header: "Arm",
		read: (discovery) => discovery.armName,
		readOnly: true,
		width: 140,
	},
	{
		id: "filePath",
		header: "File",
		read: (discovery) => discovery.filePath ?? "",
		readOnly: true,
		width: 240,
	},
	{
		id: "createdAt",
		header: "Created",
		read: (discovery) => new Date(discovery.createdAt).toLocaleString(),
		readOnly: true,
		width: 170,
	},
];

export function DiscoverySheet({
	discoveries,
	onUpdateStatus,
	onLoadMore,
	hasNextPage,
}: {
	discoveries: Discovery[];
	onUpdateStatus?: (discoveryId: string, status: string) => void;
	onLoadMore?: () => void;
	hasNextPage?: boolean;
}) {
	const [configuring, setConfiguring] = useState(false);
	const { view, preferences, updatePreferences, updateShared } = useViewPreferences(
		"discoveries-sheet",
		{
			id: "discoveries-sheet",
			name: "Discoveries",
			kind: "sheet",
			resourceKind: "discovery",
			description: "Evidence and findings reported by Arms",
			query: { resourceKinds: ["discovery"] },
			preferences: {
				density: "compact",
				sort: [{ field: "createdAt", direction: "desc" }],
			},
			shared: false,
		},
	);
	const configurableColumns = useMemo(
		() => DISCOVERY_COLUMNS.map((column) => ({
			id: column.id,
			header: column.header,
			defaultWidth: column.width,
			hideable: column.id !== "title",
		})),
		[],
	);

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-secondary/35 px-3">
				<span className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
					Spreadsheet · status is editable
				</span>
				<Button size="sm" variant="ghost" onPress={() => setConfiguring(true)}>
					<SlidersHorizontal className="h-3.5 w-3.5" />
					View
				</Button>
			</div>
			<ResourceSheet
				rows={discoveries}
				columns={DISCOVERY_COLUMNS}
				preferences={preferences}
				onPreferencesChange={updatePreferences}
				onChange={(discovery, columnId, value) => {
					if (columnId === "status" && DISCOVERY_GRID_STATUSES.includes(
						value as (typeof DISCOVERY_GRID_STATUSES)[number],
					)) {
						onUpdateStatus?.(discovery.id, String(value));
					}
				}}
				onNearEnd={hasNextPage ? onLoadMore : undefined}
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
