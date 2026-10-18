/** Semantic toolbar intent and deterministic packing; all widths are supplied by the client adapter. */
import { z } from "zod";

export const toolbarControlLayoutOverrideSchema = z.object({
	priority: z.number().int().min(0).max(100).optional(),
	kind: z.enum(["identity", "action", "choice", "toggle", "value", "status"]).optional(),
	collapse: z.enum(["none", "icon", "value", "hide"]).optional(),
	overflow: z.boolean().optional(),
}).strict();
export const toolbarControlLayoutSchema = toolbarControlLayoutOverrideSchema.extend({
	priority: toolbarControlLayoutOverrideSchema.shape.priority.unwrap().default(50),
	collapse: toolbarControlLayoutOverrideSchema.shape.collapse.unwrap().default("none"),
	overflow: toolbarControlLayoutOverrideSchema.shape.overflow.unwrap().default(false),
});

export type ToolbarControlLayout = z.infer<typeof toolbarControlLayoutSchema>;
export interface ToolbarGroupLayout {
	readonly label: string;
	readonly align: "start" | "end";
}
export interface MeasuredToolbarControl extends ToolbarControlLayout {
	readonly id: string;
	readonly group: string;
	readonly fullWidth: number;
	/** Compact width: icon-only action/toggle, or a choice that still displays its value. */
	readonly iconWidth: number;
}
export interface ToolbarLayoutResult {
	readonly rows: readonly (readonly string[])[];
	readonly hiddenIds: readonly string[];
	readonly overflowIds: readonly string[];
	readonly labels: "full" | "icons";
	readonly fits: boolean;
}

/** Prefer an uncompressed one-row layout, then two rows, before sacrificing information. */
export function resolveToolbarLayout(
	controls: readonly MeasuredToolbarControl[], width: number, maxRows: 1 | 2 = 2,
	options: { gap?: number; overflowWidth?: number } = {},
): ToolbarLayoutResult {
	const gap = options.gap ?? 6;
	const overflowWidth = options.overflowWidth ?? 32;
	if (!Number.isFinite(width) || width < 0 || gap < 0 || overflowWidth < 0) throw new Error("Invalid toolbar dimensions");
	const ids = new Set<string>();
	for (const control of controls) {
		if (ids.has(control.id)) throw new Error(`Duplicate toolbar control: ${control.id}`);
		ids.add(control.id);
		if (![control.fullWidth, control.iconWidth].every((value) => Number.isFinite(value) && value >= 0)) throw new Error(`Invalid width: ${control.id}`);
	}
	const hidden = new Set<string>();
	const overflow = new Set<string>();
	let labels: ToolbarLayoutResult["labels"] = "full";
	const pack = (): string[][] | undefined => {
		const visible = controls.filter((control) => !hidden.has(control.id) && !overflow.has(control.id));
		const items = visible.map((control) => ({ id: control.id, group: control.group,
			width: labels === "icons" && (control.collapse === "icon" || control.collapse === "value") ? control.iconWidth : control.fullWidth }));
		if (overflow.size) items.push({ id: "$overflow", group: "$overflow", width: overflowWidth });
		const units: { ids: string[]; width: number }[] = [];
		for (let index = 0; index < items.length;) {
			const group = items[index]!.group;
			const members: typeof items = [];
			while (index < items.length && items[index]!.group === group) members.push(items[index++]!);
			const groupWidth = members.reduce((sum, member) => sum + member.width, 0) + gap * (members.length - 1);
			// Keep a semantic group together when possible; oversized groups split at control boundaries.
			if (groupWidth <= width) units.push({ ids: members.map((member) => member.id), width: groupWidth });
			else units.push(...members.map((member) => ({ ids: [member.id], width: member.width })));
		}
		const rows: string[][] = [[]];
		const used: number[] = [0];
		for (const item of units) {
			if (item.width > width) return undefined;
			let row = rows.findIndex((ids, index) => used[index]! + item.width + (ids.length ? gap : 0) <= width);
			if (row === -1) {
				if (rows.length >= maxRows) return undefined;
				row = rows.length; rows.push([]); used.push(0);
			}
			used[row]! += item.width + (rows[row]!.length ? gap : 0);
			rows[row]!.push(...item.ids);
		}
		return rows.filter((row) => row.length);
	};
	const result = (rows: string[][] | undefined): ToolbarLayoutResult => ({
		rows: rows ?? [[...controls.filter((control) => !hidden.has(control.id) && !overflow.has(control.id)).map((control) => control.id),
			...overflow.size ? ["$overflow"] : []]],
		hiddenIds: [...hidden], overflowIds: [...overflow], labels, fits: rows !== undefined,
	});
	let rows = pack();
	if (rows) return result(rows);
	// Identity/avatar is the first expendable region, before labels or actions are moved.
	for (const control of controls) if (control.collapse === "hide") hidden.add(control.id);
	rows = pack();
	if (rows) return result(rows);
	labels = "icons";
	rows = pack();
	if (rows) return result(rows);
	const candidates = controls.filter((control) => control.overflow && !hidden.has(control.id))
		.map((control, index) => ({ control, index }))
		.sort((a, b) => a.control.priority - b.control.priority || a.index - b.index);
	const kind = (control: MeasuredToolbarControl) => control.kind ?? (control.collapse === "icon" ? "action" : "value");
	// Actions consolidate as one context menu before choices. Toggles remain directly accessible longest.
	const actions = candidates.filter(({ control }) => kind(control) === "action");
	if (actions.length) {
		for (const { control } of actions) overflow.add(control.id);
		rows = pack();
		if (rows) return result(rows);
	}
	for (const types of [["status", "value"], ["choice"], ["toggle"]]) {
		for (const { control } of candidates.filter(({ control }) => types.includes(kind(control)))) {
			overflow.add(control.id);
			rows = pack();
			if (rows) return result(rows);
		}
	}
	// Explicitly report impossible pinned-width constraints. The adapter can provide bounded scrolling.
	return result(undefined);
}
