import { describe, expect, it } from "bun:test";
import { resolveToolbarLayout } from "../toolbar-layout";

import type { MeasuredToolbarControl } from "../toolbar-layout";

const control = (id: string, fullWidth: number, extra: Partial<MeasuredToolbarControl> = {}): MeasuredToolbarControl => ({
	id, group: "actions", fullWidth, iconWidth: 32, priority: 50, collapse: "icon", overflow: true, ...extra,
});

describe("adaptive toolbar packing", () => {
	it("keeps full labels and identity when one or two rows fit", () => {
		const controls = [control("title", 180, { collapse: "hide", overflow: false }), control("action", 100), control("filter", 100)];
		expect(resolveToolbarLayout(controls, 400)).toMatchObject({ rows: [["title", "action", "filter"]], hiddenIds: [], labels: "full", fits: true });
		expect(resolveToolbarLayout(controls, 250)).toMatchObject({ rows: [["title"], ["action", "filter"]], hiddenIds: [], labels: "full", fits: true });
	});
	it("hides identity before collapsing labels, then moves lower-priority controls to overflow", () => {
		const controls = [control("title", 180, { collapse: "hide", overflow: false }),
			control("search", 120, { collapse: "none", overflow: false }), control("important", 100, { priority: 90 }),
			control("optional", 100, { priority: 10 }), control("help", 100, { priority: 0 })];
		expect(resolveToolbarLayout(controls, 220)).toMatchObject({ hiddenIds: ["title"], labels: "icons", overflowIds: [], fits: true });
		const small = resolveToolbarLayout(controls, 150, 1);
		expect(small.hiddenIds).toEqual(["title"]);
		expect(small.overflowIds).toEqual(["help", "optional", "important"]);
		expect(small.fits).toBe(false); // Pinned search + More cannot fit: do not silently remove search.
		expect(small.rows.flat()).toContain("search");
	});
	it("reserves room for the overflow trigger and restores full controls as space grows", () => {
		const controls = [control("search", 120, { collapse: "none", overflow: false }), ...Array.from({ length: 8 }, (_, i) => control(`action-${i}`, 100, { priority: i }))];
		const compact = resolveToolbarLayout(controls, 200);
		expect(compact.fits).toBe(true);
		expect(compact.rows.length).toBeLessThanOrEqual(2);
		expect(compact.rows.flat()).toContain("$overflow");
		expect(compact.overflowIds).toEqual(controls.slice(1).map((control) => control.id));
		expect(resolveToolbarLayout(controls, 1000)).toMatchObject({ labels: "full", hiddenIds: [], overflowIds: [] });
	});

	it("keeps a semantic group on the same row when its members fit together", () => {
		const controls = [control("context", 130, { group: "context" }),
			control("read", 80, { group: "actions" }), control("refresh", 80, { group: "actions" })];
		expect(resolveToolbarLayout(controls, 230).rows).toEqual([["context"], ["read", "refresh"]]);
	});
	it("consolidates actions before choices regardless of priority and keeps toggles separate longer", () => {
		const controls = [control("search", 128, { group: "search", kind: "value", collapse: "none", overflow: false }),
			control("dropdown", 200, { group: "filters", kind: "choice", collapse: "value", iconWidth: 100, priority: 0 }),
			control("toggle", 140, { group: "toggles", kind: "toggle", priority: 0 }),
			control("action-1", 200, { kind: "action", priority: 99 }), control("action-2", 200, { kind: "action", priority: 99 })];
		const roomy = resolveToolbarLayout(controls, 330, 1);
		expect(roomy.overflowIds).toEqual(["action-1", "action-2"]);
		expect(roomy.rows.flat()).toContain("dropdown");
		expect(roomy.rows.flat()).toContain("toggle");
		const narrower = resolveToolbarLayout(controls, 220, 1);
		expect(narrower.overflowIds).toEqual(["action-1", "action-2", "dropdown"]);
		expect(narrower.rows.flat()).toContain("toggle");
		expect(narrower.fits).toBe(true);
	});
	it("uses both rows and backfills spare group space before overflowing a dropdown", () => {
		const controls = [control("view", 110, { group: "context", kind: "choice", collapse: "value", iconWidth: 100 }),
			control("search", 160, { group: "search", kind: "value", collapse: "none", overflow: false }),
			control("toggle", 32, { group: "toggle", kind: "toggle" })];
		const layout = resolveToolbarLayout(controls, 180);
		expect(layout.rows).toEqual([["view", "toggle"], ["search"]]);
		expect(layout.labels).toBe("full");
		expect(layout.overflowIds).toEqual([]);
	});
	it("preserves every non-hidden control in either the rows or overflow, without changing input", () => {
		const controls = [control("title", 180, { collapse: "hide", overflow: false }), ...Array.from({ length: 12 }, (_, i) => control(`item-${i}`, 80))];
		const before = JSON.stringify(controls);
		for (const width of [2000, 800, 390, 240, 100]) {
			const layout = resolveToolbarLayout(controls, width);
			const all = [...layout.rows.flat().filter((id) => id !== "$overflow"), ...layout.overflowIds, ...layout.hiddenIds];
			expect(all.toSorted()).toEqual(controls.map((control) => control.id).toSorted());
			expect(new Set(all).size).toBe(all.length);
			expect(layout.rows.length).toBeLessThanOrEqual(2);
		}
		expect(JSON.stringify(controls)).toBe(before);
	});
	it("rejects invalid dimensions and duplicate IDs", () => {
		expect(() => resolveToolbarLayout([control("same", 10), control("same", 10)], 200)).toThrow("Duplicate");
		expect(() => resolveToolbarLayout([control("invalid", Number.NaN)], 200)).toThrow("Invalid width");
		expect(() => resolveToolbarLayout([], -1)).toThrow("dimensions");
	});
});
