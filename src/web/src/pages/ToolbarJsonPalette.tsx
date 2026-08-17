import { Button } from "@heroui/react";
import { Plus } from "lucide-react";

import { WorkbenchSurface } from "@/design-system/WorkbenchSurface";
import { formatToolbarWidgetLabel } from "./toolbars-page-utils";

export function ToolbarJsonPalette({
	widgetIds,
	disabled,
	error,
	onInsert,
}: {
	widgetIds: readonly string[];
	disabled: boolean;
	error: string | null;
	onInsert: (widgetId: string) => void;
}) {
	return (
		<WorkbenchSurface className="flex min-h-[36rem] min-w-0 flex-col overflow-hidden">
			<div className="border-b border-border px-4 py-3">
				<h2 className="text-sm font-semibold">Insert a widget</h2>
				<p className="mt-1 text-xs leading-5 text-muted-foreground">
					Click a valid widget to place it at the nearest item boundary to your JSON cursor.
				</p>
			</div>
			<div className="flex-1 space-y-1 overflow-auto p-2">
				{widgetIds.map((widgetId) => (
					<Button
						key={widgetId}
						fullWidth
						size="sm"
						variant="ghost"
						onPress={() => onInsert(widgetId)}
						isDisabled={disabled}
						className="h-auto min-h-11 justify-start gap-2 px-2.5 py-2 text-left"
					>
						<span className="flex h-6 w-6 shrink-0 items-center justify-center border border-border bg-surface-secondary text-accent">
							<Plus className="h-3.5 w-3.5" aria-hidden="true" />
						</span>
						<span className="min-w-0">
							<span className="block text-xs font-medium text-foreground">{formatToolbarWidgetLabel(widgetId)}</span>
							<code className="block truncate text-[0.65rem] font-normal text-muted-foreground">{widgetId}</code>
						</span>
					</Button>
				))}
			</div>
			<div className="border-t border-border px-4 py-2 text-[0.68rem] leading-4 text-muted-foreground">
				{error ? "Repair the JSON before inserting widgets." : "Repeated widgets are allowed; item IDs stay unique."}
			</div>
		</WorkbenchSurface>
	);
}
