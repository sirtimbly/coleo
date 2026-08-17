import { describe, expect, it } from "bun:test";

import {
	DEFAULT_TOOLBAR_TEMPLATES,
	TOOLBAR_WIDGET_IDS,
} from "../../workbench/toolbar-templates";
import { insertToolbarWidgetAtCursor } from "../src/pages/toolbars-page-utils";

function inboxSource(): string {
	return JSON.stringify(DEFAULT_TOOLBAR_TEMPLATES.inbox, null, 2);
}

describe("toolbar widget insertion", () => {
	it("inserts at the item boundary nearest the cursor in either row", () => {
		const source = inboxSource();
		const firstItems = source.indexOf('"items": [');
		const primaryResult = insertToolbarWidgetAtCursor({
			source,
			cursorOffset: firstItems,
			screenId: "inbox",
			allowedWidgetIds: TOOLBAR_WIDGET_IDS.inbox,
			widgetId: "inbox.refresh",
		});
		const primary = JSON.parse(primaryResult.source) as typeof DEFAULT_TOOLBAR_TEMPLATES.inbox;
		expect(primary.rows[0].items[0]).toMatchObject({
			id: "inbox-refresh",
			kind: "widget",
			widget: "inbox.refresh",
		});

		const displayItems = source.lastIndexOf('"items": [');
		const displayResult = insertToolbarWidgetAtCursor({
			source,
			cursorOffset: displayItems,
			screenId: "inbox",
			allowedWidgetIds: TOOLBAR_WIDGET_IDS.inbox,
			widgetId: "collection.view-mode",
		});
		const display = JSON.parse(displayResult.source) as typeof DEFAULT_TOOLBAR_TEMPLATES.inbox;
		expect(display.rows[1].items[0]).toMatchObject({
			id: "collection-view-mode",
			widget: "collection.view-mode",
		});
	});

	it("supports minified JSON and ignores misleading items text in strings", () => {
		const source = JSON.stringify({
			...DEFAULT_TOOLBAR_TEMPLATES.inbox,
			rows: [
				{ ...DEFAULT_TOOLBAR_TEMPLATES.inbox.rows[0], label: "The items string is not an array" },
				DEFAULT_TOOLBAR_TEMPLATES.inbox.rows[1],
			],
		});
		const result = insertToolbarWidgetAtCursor({
			source,
			cursorOffset: source.lastIndexOf('"items":['),
			screenId: "inbox",
			allowedWidgetIds: TOOLBAR_WIDGET_IDS.inbox,
			widgetId: "collection.grid-density",
		});
		const template = JSON.parse(result.source) as typeof DEFAULT_TOOLBAR_TEMPLATES.inbox;
		expect(template.rows[1].items[0]).toMatchObject({ widget: "collection.grid-density" });
		expect(result.source.startsWith('{\n  "id"')).toBe(true);
	});

	it("keeps repeated widget item IDs unique and selects the inserted widget value", () => {
		const source = inboxSource();
		const first = insertToolbarWidgetAtCursor({
			source,
			cursorOffset: source.lastIndexOf('"items": ['),
			screenId: "inbox",
			allowedWidgetIds: TOOLBAR_WIDGET_IDS.inbox,
			widgetId: "collection.view-mode",
		});
		const second = insertToolbarWidgetAtCursor({
			source: first.source,
			cursorOffset: first.selectionEnd,
			screenId: "inbox",
			allowedWidgetIds: TOOLBAR_WIDGET_IDS.inbox,
			widgetId: "collection.view-mode",
		});
		const template = JSON.parse(second.source) as typeof DEFAULT_TOOLBAR_TEMPLATES.inbox;
		const insertedIds = template.rows[1].items
			.filter((item) => item.kind === "widget" && item.widget === "collection.view-mode")
			.map((item) => item.id);
		expect(insertedIds).toContain("collection-view-mode");
		expect(insertedIds).toContain("collection-view-mode-2");
		expect(second.source.slice(second.selectionStart, second.selectionEnd)).toBe("collection.view-mode");
	});

	it("rejects invalid JSON and widgets outside the screen registry", () => {
		expect(() => insertToolbarWidgetAtCursor({
			source: "{",
			cursorOffset: 0,
			screenId: "inbox",
			allowedWidgetIds: TOOLBAR_WIDGET_IDS.inbox,
			widgetId: "inbox.refresh",
		})).toThrow("Invalid JSON");

		expect(() => insertToolbarWidgetAtCursor({
			source: inboxSource(),
			cursorOffset: 0,
			screenId: "inbox",
			allowedWidgetIds: TOOLBAR_WIDGET_IDS.inbox,
			widgetId: "tasks.workflow-help",
		})).toThrow("not available for inbox");
	});
});
