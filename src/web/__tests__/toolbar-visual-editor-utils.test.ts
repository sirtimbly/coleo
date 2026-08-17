import { describe, expect, it } from "bun:test";

import { DEFAULT_TOOLBAR_TEMPLATES } from "../../workbench/toolbar-templates";
import {
	createToolbarStructureItem,
	createToolbarWidgetItem,
	insertToolbarItem,
	moveToolbarItem,
	removeToolbarItem,
	replaceToolbarItem,
	updateToolbarRow,
} from "../src/pages/toolbar-visual-editor-utils";

describe("visual toolbar editor operations", () => {
	it("creates repeated widgets and structure items with unique IDs", () => {
		const template = DEFAULT_TOOLBAR_TEMPLATES.inbox;
		const first = createToolbarWidgetItem(template, "inbox.refresh");
		const withFirst = insertToolbarItem(template, 0, template.rows[0].items.length, first);
		const second = createToolbarWidgetItem(withFirst, "inbox.refresh");
		const label = createToolbarStructureItem(withFirst, "label");

		expect(first.id).toBe("inbox-refresh");
		expect(second.id).toBe("inbox-refresh-2");
		expect(label).toMatchObject({ id: "label", kind: "label", text: "Label" });
	});

	it("reorders within a row and moves items between rows", () => {
		const template = DEFAULT_TOOLBAR_TEMPLATES.inbox;
		const reordered = moveToolbarItem(template, 0, 0, 0, 3);
		expect(reordered.rows[0].items[3]?.id).toBe("identity");

		const moved = moveToolbarItem(reordered, 0, 3, 1, 1);
		expect(moved.rows[0].items.some((item) => item.id === "identity")).toBe(false);
		expect(moved.rows[1].items[1]?.id).toBe("identity");
	});

	it("renames an item when its destination row already uses the same ID", () => {
		const template = {
			...DEFAULT_TOOLBAR_TEMPLATES.inbox,
			rows: [
				{
					...DEFAULT_TOOLBAR_TEMPLATES.inbox.rows[0],
					items: [{ id: "shared", kind: "widget" as const, widget: "inbox.refresh" }],
				},
				{
					...DEFAULT_TOOLBAR_TEMPLATES.inbox.rows[1],
					items: [{ id: "shared", kind: "divider" as const }],
				},
			],
		};
		const moved = moveToolbarItem(template, 0, 0, 1, 1);
		expect(moved.rows[1].items.map((item) => item.id)).toEqual(["shared", "shared-2"]);
	});

	it("updates and removes visual items without changing the two-row contract", () => {
		const template = DEFAULT_TOOLBAR_TEMPLATES.inbox;
		const updatedRow = updateToolbarRow(template, 1, { label: "Presentation", size: "large" });
		const item = updatedRow.rows[1].items[0]!;
		const hidden = replaceToolbarItem(updatedRow, 1, 0, { ...item, hidden: true });
		const removed = removeToolbarItem(hidden, 1, 0);

		expect(hidden.rows[1]).toMatchObject({ label: "Presentation", size: "large" });
		expect(hidden.rows[1].items[0]?.hidden).toBe(true);
		expect(removed.rows).toHaveLength(2);
		expect(removed.rows[1].items).toHaveLength(template.rows[1].items.length - 1);
	});
});
