import { findNodeAtLocation, parseTree, type Node } from "jsonc-parser";

import { parseToolbarTemplateJson } from "../../../workbench/toolbar-templates";

import type {
	ToolbarScreenId,
	ToolbarTemplateItem,
	WorkbenchToolbarTemplate,
} from "../../../workbench/toolbar-templates";

export interface InsertToolbarWidgetInput {
	source: string;
	cursorOffset: number;
	screenId: ToolbarScreenId;
	allowedWidgetIds: readonly string[];
	widgetId: string;
}

export interface InsertToolbarWidgetResult {
	source: string;
	selectionStart: number;
	selectionEnd: number;
}

export function formatToolbarWidgetLabel(widgetId: string): string {
	return widgetId
		.split(".")
		.at(-1)!
		.replaceAll("-", " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());
}

function distanceToNode(offset: number, node: Node): number {
	if (offset < node.offset) return node.offset - offset;
	const end = node.offset + node.length;
	return offset > end ? offset - end : 0;
}

function nearestInsertionIndex(itemsNode: Node, cursorOffset: number): number {
	const items = itemsNode.children ?? [];
	if (items.length === 0) return 0;
	const slots = items.map((item) => item.offset);
	const lastItem = items.at(-1)!;
	slots.push(lastItem.offset + lastItem.length);

	let nearestIndex = 0;
	let nearestDistance = Math.abs(cursorOffset - slots[0]!);
	for (let index = 1; index < slots.length; index += 1) {
		const distance = Math.abs(cursorOffset - slots[index]!);
		if (distance < nearestDistance) {
			nearestIndex = index;
			nearestDistance = distance;
		}
	}
	return nearestIndex;
}

function createWidgetItemId(template: WorkbenchToolbarTemplate, widgetId: string): string {
	const usedIds = new Set(template.rows.flatMap((row) => row.items.map((item) => item.id)));
	const base = widgetId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "widget";
	if (!usedIds.has(base)) return base;
	let suffix = 2;
	while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
	return `${base}-${suffix}`;
}

export function insertToolbarWidgetAtCursor({
	source,
	cursorOffset,
	screenId,
	allowedWidgetIds,
	widgetId,
}: InsertToolbarWidgetInput): InsertToolbarWidgetResult {
	if (!allowedWidgetIds.includes(widgetId)) {
		throw new Error(`Widget "${widgetId}" is not available for ${screenId}`);
	}
	const template = parseToolbarTemplateJson(source, screenId, allowedWidgetIds);
	const sourceTree = parseTree(source);
	if (!sourceTree) throw new Error("Toolbar configuration must be valid JSON");
	const itemNodes = [0, 1].map((rowIndex) => findNodeAtLocation(sourceTree, ["rows", rowIndex, "items"]));
	if (!itemNodes[0] || !itemNodes[1]) {
		throw new Error("Toolbar configuration must contain an items array in both rows");
	}

	const clampedOffset = Math.max(0, Math.min(source.length, cursorOffset));
	const rowIndex = distanceToNode(clampedOffset, itemNodes[0]) <= distanceToNode(clampedOffset, itemNodes[1])
		? 0
		: 1;
	const insertionIndex = nearestInsertionIndex(itemNodes[rowIndex]!, clampedOffset);
	const nextRows = template.rows.map((row) => ({ ...row, items: [...row.items] }));
	const item: ToolbarTemplateItem = {
		id: createWidgetItemId(template, widgetId),
		kind: "widget",
		widget: widgetId,
	};
	nextRows[rowIndex]!.items.splice(insertionIndex, 0, item);
	const nextTemplate: WorkbenchToolbarTemplate = {
		...template,
		rows: [nextRows[0]!, nextRows[1]!],
	};
	const nextSource = JSON.stringify(nextTemplate, null, 2);
	const nextTree = parseTree(nextSource);
	const widgetNode = nextTree
		? findNodeAtLocation(nextTree, ["rows", rowIndex, "items", insertionIndex, "widget"])
		: undefined;
	if (!widgetNode || widgetNode.type !== "string") {
		throw new Error("Could not locate the inserted widget in the formatted configuration");
	}

	return {
		source: nextSource,
		selectionStart: widgetNode.offset + 1,
		selectionEnd: widgetNode.offset + widgetNode.length - 1,
	};
}
