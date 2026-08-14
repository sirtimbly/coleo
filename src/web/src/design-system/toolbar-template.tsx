import { Fragment, type ReactNode } from "react";
import { Separator, Toolbar } from "@heroui/react";

import { cn } from "@/lib";

export type ToolbarRowSize = "small" | "large";
export type ToolbarScreenId =
	| "inbox"
	| "plan-documents"
	| "tasks"
	| "bugs"
	| "arms"
	| "processes"
	| "arm-viewer";

interface ToolbarItemBase {
	readonly id: string;
	readonly hidden?: boolean;
}

export interface ToolbarWidgetItem extends ToolbarItemBase {
	readonly kind: "widget";
	readonly widget: string;
	readonly label?: string;
}

export interface ToolbarLabelItem extends ToolbarItemBase {
	readonly kind: "label";
	readonly text: string;
}

export interface ToolbarDividerItem extends ToolbarItemBase {
	readonly kind: "divider";
}

export interface ToolbarSpacerItem extends ToolbarItemBase {
	readonly kind: "spacer";
}

export type ToolbarTemplateItem =
	| ToolbarWidgetItem
	| ToolbarLabelItem
	| ToolbarDividerItem
	| ToolbarSpacerItem;

export interface ToolbarRowTemplate {
	readonly id: string;
	readonly label: string;
	readonly size: ToolbarRowSize;
	readonly items: readonly ToolbarTemplateItem[];
}

export interface WorkbenchToolbarTemplate {
	readonly id: ToolbarScreenId;
	readonly rows: readonly [ToolbarRowTemplate, ToolbarRowTemplate];
}

export interface ToolbarWidgetRegistry {
	readonly [widget: string]: ReactNode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value;
}

function parseToolbarItem(
	value: unknown,
	path: string,
	allowedWidgets: ReadonlySet<string>,
): ToolbarTemplateItem {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const id = readString(value.id, `${path}.id`);
	const kind = readString(value.kind, `${path}.kind`);
	const hidden = value.hidden;
	if (hidden !== undefined && typeof hidden !== "boolean") {
		throw new Error(`${path}.hidden must be a boolean`);
	}
	const base = hidden === undefined ? { id } : { id, hidden };

	if (kind === "widget") {
		const widget = readString(value.widget, `${path}.widget`);
		if (!allowedWidgets.has(widget)) {
			throw new Error(`${path}.widget references unknown widget "${widget}"`);
		}
		if (value.label !== undefined && typeof value.label !== "string") {
			throw new Error(`${path}.label must be a string`);
		}
		return value.label === undefined
			? { ...base, kind, widget }
			: { ...base, kind, widget, label: value.label };
	}

	if (kind === "label") {
		return { ...base, kind, text: readString(value.text, `${path}.text`) };
	}

	if (kind === "divider" || kind === "spacer") {
		return { ...base, kind };
	}

	throw new Error(`${path}.kind must be widget, label, divider, or spacer`);
}

export function parseToolbarTemplate(
	value: unknown,
	screenId: ToolbarScreenId,
	allowedWidgetIds: readonly string[],
): WorkbenchToolbarTemplate {
	if (!isRecord(value)) throw new Error("Toolbar configuration must be an object");
	if (value.id !== screenId) throw new Error(`Toolbar id must be "${screenId}"`);
	if (!Array.isArray(value.rows) || value.rows.length !== 2) {
		throw new Error("Toolbar configuration must contain exactly two rows");
	}

	const allowedWidgets = new Set(allowedWidgetIds);
	const rowIds = new Set<string>();
	const rows = value.rows.map((rowValue, rowIndex): ToolbarRowTemplate => {
		const path = `rows[${rowIndex}]`;
		if (!isRecord(rowValue)) throw new Error(`${path} must be an object`);
		const id = readString(rowValue.id, `${path}.id`);
		if (rowIds.has(id)) throw new Error(`${path}.id must be unique`);
		rowIds.add(id);
		const label = readString(rowValue.label, `${path}.label`);
		if (rowValue.size !== "small" && rowValue.size !== "large") {
			throw new Error(`${path}.size must be "small" or "large"`);
		}
		if (!Array.isArray(rowValue.items)) throw new Error(`${path}.items must be an array`);

		const itemIds = new Set<string>();
		const items = rowValue.items.map((itemValue, itemIndex) => {
			const item = parseToolbarItem(itemValue, `${path}.items[${itemIndex}]`, allowedWidgets);
			if (itemIds.has(item.id)) {
				throw new Error(`${path}.items[${itemIndex}].id must be unique within its row`);
			}
			itemIds.add(item.id);
			return item;
		});

		return { id, label, size: rowValue.size, items };
	});

	return { id: screenId, rows: [rows[0]!, rows[1]!] };
}

export function parseToolbarTemplateJson(
	source: string,
	screenId: ToolbarScreenId,
	allowedWidgetIds: readonly string[],
): WorkbenchToolbarTemplate {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new Error(error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON");
	}
	return parseToolbarTemplate(value, screenId, allowedWidgetIds);
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
