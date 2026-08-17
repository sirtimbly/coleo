import { Fragment, type ReactNode } from "react";
import { Separator, Toolbar } from "@heroui/react";

import type {
	ToolbarRowTemplate,
	WorkbenchToolbarTemplate,
} from "../../../workbench/toolbar-templates";
import { cn } from "@/lib";

export {
	parseToolbarTemplate,
	parseToolbarTemplateJson,
} from "../../../workbench/toolbar-templates";
export type {
	ToolbarDividerItem,
	ToolbarLabelItem,
	ToolbarRowSize,
	ToolbarRowTemplate,
	ToolbarScreenId,
	ToolbarSpacerItem,
	ToolbarTemplateItem,
	ToolbarWidgetItem,
	WorkbenchToolbarTemplate,
} from "../../../workbench/toolbar-templates";

export interface ToolbarWidgetRegistry {
	readonly [widget: string]: ReactNode;
}

export function ToolbarTemplateRows({
	template,
	widgets,
}: {
	template: WorkbenchToolbarTemplate;
	widgets: ToolbarWidgetRegistry;
}) {
	return template.rows.map((row) => (
		<ToolbarTemplateRow key={row.id} row={row} widgets={widgets} />
	));
}

export function ToolbarTemplateRow({
	row,
	widgets,
	className,
}: {
	row: ToolbarRowTemplate;
	widgets: ToolbarWidgetRegistry;
	className?: string;
}) {
	return (
		<Toolbar
			aria-label={row.label}
			data-toolbar-row={row.id}
			className={cn(
				"!flex !w-full min-w-0 shrink-0 flex-nowrap overflow-x-auto rounded-none border-b border-border bg-surface-secondary/35",
				"[&_button]:!rounded-none [&_input]:!rounded-none [&_select]:!rounded-none",
				"[&_[role=button]]:!rounded-none [&_[role=combobox]]:!rounded-none [&_[role=switch]]:!rounded-none [&_[role=tab]]:!rounded-none",
				"[&_[data-projection-menu-trigger]]:!h-8 [&_[data-projection-menu-trigger]]:!min-h-8",
				"[&_[role=group]]:bg-accent/5 [&_[role=group]]:p-0.5",
				"[&_[role=group]_.button--secondary]:!bg-accent/20 [&_[role=group]_.button--secondary]:!text-accent",
				row.size === "small"
					? "min-h-8 gap-1 px-3 py-0.5"
					: "min-h-12 gap-2 px-3 py-2",
				className,
			)}
		>
			{row.items.map((item) => {
				if (item.hidden) return null;

				if (item.kind === "divider") {
					return (
						<Separator
							key={item.id}
							orientation="vertical"
							className="mx-1 h-5 shrink-0 self-center"
						/>
					);
				}

				if (item.kind === "spacer") {
					return <span key={item.id} aria-hidden="true" className="min-w-2 flex-1" />;
				}

				if (item.kind === "label") {
					return (
						<span
							key={item.id}
							className="mr-1 inline-flex shrink-0 self-center items-center text-[0.68rem] font-semibold leading-none uppercase tracking-[0.12em] text-muted-foreground"
						>
							{item.text}
						</span>
					);
				}

				const widget = widgets[item.widget];
				if (widget === null || widget === undefined || widget === false) return null;
				if (!item.label) return <Fragment key={item.id}>{widget}</Fragment>;

				return (
					<div key={item.id} className="flex shrink-0 items-center gap-1.5">
						<span className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
							{item.label}
						</span>
						{widget}
					</div>
				);
			})}
		</Toolbar>
	);
}
