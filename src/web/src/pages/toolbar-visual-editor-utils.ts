import type {
	ToolbarRowSize,
	ToolbarTemplateItem,
	ToolbarWidgetItem,
	WorkbenchToolbarTemplate,
} from "../../../workbench/toolbar-templates";

export type ToolbarRowIndex = 0 | 1;
export type ToolbarStructureKind = "label" | "divider" | "spacer";

function itemIdBase(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "item";
}

export function createUniqueToolbarItemId(
	template: WorkbenchToolbarTemplate,
	value: string,
): string {
	const usedIds = new Set(template.rows.flatMap((row) => row.items.map((item) => item.id)));
	const base = itemIdBase(value);
	if (!usedIds.has(base)) return base;
	let suffix = 2;
	while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
	return `${base}-${suffix}`;
}

export function createToolbarWidgetItem(
	template: WorkbenchToolbarTemplate,
	widgetId: string,
): ToolbarWidgetItem {
	return {
		id: createUniqueToolbarItemId(template, widgetId),
		kind: "widget",
		widget: widgetId,
	};
}

export function createToolbarStructureItem(
	template: WorkbenchToolbarTemplate,
	kind: ToolbarStructureKind,
): ToolbarTemplateItem {
	const id = createUniqueToolbarItemId(template, kind);
	return kind === "label"
		? { id, kind, text: "Label" }
		: { id, kind };
}

function mutableRows(template: WorkbenchToolbarTemplate) {
	return template.rows.map((row) => ({ ...row, items: [...row.items] }));
}

function withRows(
	template: WorkbenchToolbarTemplate,
	rows: ReturnType<typeof mutableRows>,
): WorkbenchToolbarTemplate {
	return { ...template, rows: [rows[0]!, rows[1]!] };
}

export function insertToolbarItem(
	template: WorkbenchToolbarTemplate,
	rowIndex: ToolbarRowIndex,
	itemIndex: number,
	item: ToolbarTemplateItem,
): WorkbenchToolbarTemplate {
	const rows = mutableRows(template);
	const items = rows[rowIndex].items;
	const nextItem = items.some((candidate) => candidate.id === item.id)
		? { ...item, id: createUniqueToolbarItemId(template, item.id) }
		: item;
	items.splice(Math.max(0, Math.min(items.length, itemIndex)), 0, nextItem);
	return withRows(template, rows);
}

export function moveToolbarItem(
	template: WorkbenchToolbarTemplate,
	sourceRowIndex: ToolbarRowIndex,
	sourceItemIndex: number,
	targetRowIndex: ToolbarRowIndex,
	targetItemIndex: number,
): WorkbenchToolbarTemplate {
	const rows = mutableRows(template);
	const sourceItems = rows[sourceRowIndex].items;
	const [item] = sourceItems.splice(sourceItemIndex, 1);
	if (!item) return template;
	const targetItems = rows[targetRowIndex].items;
	const nextItem = sourceRowIndex !== targetRowIndex
		&& targetItems.some((candidate) => candidate.id === item.id)
		? { ...item, id: createUniqueToolbarItemId(template, item.id) }
		: item;
	targetItems.splice(Math.max(0, Math.min(targetItems.length, targetItemIndex)), 0, nextItem);
	return withRows(template, rows);
}

export function removeToolbarItem(
	template: WorkbenchToolbarTemplate,
	rowIndex: ToolbarRowIndex,
	itemIndex: number,
): WorkbenchToolbarTemplate {
	const rows = mutableRows(template);
	rows[rowIndex].items.splice(itemIndex, 1);
	return withRows(template, rows);
}

export function replaceToolbarItem(
	template: WorkbenchToolbarTemplate,
	rowIndex: ToolbarRowIndex,
	itemIndex: number,
	item: ToolbarTemplateItem,
): WorkbenchToolbarTemplate {
	const rows = mutableRows(template);
	if (!rows[rowIndex].items[itemIndex]) return template;
	rows[rowIndex].items[itemIndex] = item;
	return withRows(template, rows);
}

export function updateToolbarRow(
	template: WorkbenchToolbarTemplate,
	rowIndex: ToolbarRowIndex,
	updates: { label?: string; size?: ToolbarRowSize },
): WorkbenchToolbarTemplate {
	const rows = mutableRows(template);
	rows[rowIndex] = { ...rows[rowIndex], ...updates };
	return withRows(template, rows);
}
