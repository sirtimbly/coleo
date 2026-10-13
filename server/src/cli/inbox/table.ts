import Table from "cli-table3";
import boxen from "boxen";
import wrapAnsi from "wrap-ansi";
import { inboxReference } from "./references";
import { terminalText } from "./terminal-text";
import { inboxColorEnabled, inboxInk } from "./terminal-theme";

import type { InboxSnapshot, InboxSnapshotRow } from "./snapshot";
import type { InboxInk } from "./terminal-theme";

interface Column { key: string; label: string; min: number; ideal: number; priority: number; width: number }
export interface InboxTextOptions { readonly columns?: number; readonly now?: number; readonly color?: boolean }

/** Choose the available terminal width, falling back to COLUMNS and then a conventional 80 columns. */
export function inboxTerminalColumns(): number {
	const env = Number(process.env.COLUMNS);
	return process.stdout.columns || (Number.isFinite(env) && env >= 20 ? env : 80);
}

/** Strip terminal controls and truncate to a display width without splitting grapheme clusters. */
export function fitInboxCell(value: string, width: number): string {
	if (width <= 0) return "";
	const text = terminalText(value);
	if (Bun.stringWidth(text) <= width) return text;
	// wrap-ansi 10 segments graphemes; cli-truncate/slice-ansi can split ZWJ emoji.
	if (width === 1) return "…";
	const prefix = wrapAnsi(text, width - 1, { hard: true, wordWrap: false, trim: false }).split("\n")[0]!;
	if (Bun.stringWidth(prefix) > width - 1) return "…";
	// The library normalizes NFC. Restore original code points without changing its layout decision.
	const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	return [...segments.segment(text)].slice(0, [...segments.segment(prefix)].length).map(({ segment }) => segment).join("") + "…";
}

/** Sanitize and wrap terminal text into physical lines. */
function wrap(text: string, width: number): string[] {
	return wrapAnsi(terminalText(text), width, { hard: true }).split("\n");
}

/** Format an ISO timestamp as a compact relative age or calendar date. */
function age(timestamp: unknown, now: number): string {
	if (typeof timestamp !== "string") return "—";
	const time = Date.parse(timestamp);
	if (!Number.isFinite(time)) return "—";
	const seconds = Math.floor((now - time) / 1000);
	if (seconds < 0) return timestamp.slice(5, 10);
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
	const date = new Date(time);
	if (date.getUTCFullYear() !== new Date(now).getUTCFullYear()) return timestamp.slice(0, 7);
	return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Fit declared presentation fields to the terminal, preserving references and subject first. */
function columnsFor(snapshot: InboxSnapshot, width: number): { visible: Column[]; hidden: string[] } {
	const fields = snapshot.presentation.fields;
	const columns: Column[] = [{ key: "ref", label: "Ref", min: 9, ideal: 9, priority: 1000, width: 9 }];
	const add = (key: string, label: string, min: number, ideal: number, priority: number) => columns.push({ key, label, min, ideal, priority, width: min });
	if (fields.includes("unread") || fields.includes("requiresAction")) add("state", "State", 6, 6, 80);
	for (const field of fields) {
		if (field === "unread" || field === "requiresAction") continue;
		if (field === "title") add(field, "Subject", 12, Math.max(28, width), 500);
		else if (field === "summary") add(field, "Preview", 12, 28, 10);
		else if (field === "source") add(field, "Source", 8, 14, 40);
		else if (field === "timestamp") add(field, "When", 6, 8, 60);
		else add(field, field.replace(/([A-Z])/g, " $1"), 8, 16, 30);
	}
	const hidden: string[] = [];
	const size = () => columns.reduce((sum, column) => sum + column.width, 0) + (columns.length - 1) * 2;
	while (size() > width && columns.length > 2) {
		const removable = columns.filter((column) => column.key !== "ref" && column.key !== "title").sort((a, b) => a.priority - b.priority)[0];
		if (!removable) break;
		hidden.push(removable.label); columns.splice(columns.indexOf(removable), 1);
	}
	if (size() > width && columns.length === 2) columns[1]!.width = Math.max(1, width - 11);
	let remaining = Math.max(0, width - size());
	for (const key of ["timestamp", "source", "summary"]) {
		const column = columns.find((column) => column.key === key);
		if (!column) continue;
		const growth = Math.min(remaining, column.ideal - column.width);
		column.width += growth; remaining -= growth;
	}
	const main = columns.find((column) => column.key === "title") ?? columns.find((column) => column.key !== "ref");
	if (main) main.width += remaining;
	return { visible: columns, hidden };
}

/** Build Unicode branch prefixes from visible parent relationships in row order. */
function treePrefixes(rows: readonly InboxSnapshotRow[]): ReadonlyMap<string, string> {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const lastSibling = new Map<string | null, string>();
	for (const row of rows) lastSibling.set(row.parentId, row.id);
	return new Map(rows.map((row) => {
		if (row.parentId === null) return [row.id, ""];
		const parents: InboxSnapshotRow[] = [];
		let parent = byId.get(row.parentId);
		while (parent?.parentId) { parents.push(parent); parent = byId.get(parent.parentId); }
		const prefix = parents.reverse().map((node) => lastSibling.get(node.parentId) === node.id ? "   " : "│  ").join("");
		return [row.id, prefix + (lastSibling.get(row.parentId) === row.id ? "└─ " : "├─ ")];
	}));
}

/** Render grid presentation rows with compact state, age, ancestry, and stable references. */
function tableRows(snapshot: InboxSnapshot, width: number, now: number): { lines: string[]; hidden: string[] } {
	const columns = columnsFor(snapshot, width);
	const prefixes = treePrefixes(snapshot.rows);
	const table = new Table({
		head: columns.visible.map((column) => column.label),
		colWidths: columns.visible.map((column) => column.width),
		chars: { top: "", "top-mid": "", "top-left": "", "top-right": "", bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "", left: "", right: "", middle: "  ", mid: "─", "left-mid": "", "right-mid": "", "mid-mid": "  " },
		style: { head: [], border: [], "padding-left": 0, "padding-right": 0, compact: true },
	});
	for (const row of snapshot.rows) table.push(columns.visible.map((column) => {
		const value = () => {
			if (column.key === "ref") return inboxReference(row.id);
			if (column.key === "state") return row.values.requiresAction ? "Action" : row.values.unread ? "Unread" : "Read";
			if (column.key === "timestamp") return age(row.values.timestamp, now);
			if (column.key === "title") {
				const prefix = prefixes.get(row.id) ?? "";
				return (Bun.stringWidth(prefix) > Math.floor(column.width / 3) ? "… └─ " : prefix) + terminalText(row.values.title);
			}
			if (column.key === "source") return terminalText(row.values.source).replace(/\s*·\s*(\d+) messages?\b/, " ($1)").replace(/\s*<[^>]+>/g, "");
			return terminalText(row.values[column.key]);
		};
		return fitInboxCell(value(), column.width);
	}));
	return { lines: table.toString().split("\n").map((line) => line.trimEnd()), hidden: columns.hidden };
}

/** Render cards or the timeline's text-list fallback using declared fields and loaded ancestry. */
function listRows(snapshot: InboxSnapshot, width: number, now: number, ink: InboxInk): string[] {
	const fields = snapshot.presentation.fields;
	const cards = snapshot.view.definition.presentation.renderers.find((renderer) => renderer.id === snapshot.presentation.id)?.kind === "cards";
	const prefixes = treePrefixes(snapshot.rows);
	const inner = cards ? width - 4 : width - 3;
	const lines: string[] = [];
	const data = new Map<string, { unread: boolean; requiresAction: boolean; icon: string }>();
	for (const item of snapshot.items) {
		data.set(item.id, { unread: item.unread, requiresAction: item.requiresAction,
			icon: item.thread || item.kind === "project" ? "✉" : item.resource?.kind === "bug" ? "⚑" : item.actor?.kind === "brain" ? "⚙" : "▣" });
		for (const node of item.thread?.hierarchy.nodes ?? []) data.set(node.id, { unread: node.data.unread, requiresAction: node.data.requiresAction, icon: "✉" });
	}
	let date: string | undefined;
	for (const row of snapshot.rows) {
		const body: string[] = [];
		const prefix = prefixes.get(row.id) ?? "";
		const tree = Bun.stringWidth(prefix) > Math.floor(inner / 3) ? "… └─ " : prefix;
		const info = data.get(row.id);
		const state = info?.requiresAction || row.values.requiresAction ? "action" : info?.unread || row.values.unread ? "unread" : "read";
		const dot = state === "action" ? "◆" : state === "unread" ? "●" : "○";
		const titles = wrap(`${info?.icon ?? "▣"} ${fields.includes("title") ? `${tree}${terminalText(row.values.title)}` : inboxReference(row.id)}`, inner);
		const facts: string[] = [];
		if (cards && fields.includes("timestamp")) facts.push(age(row.values.timestamp, now));
		if (fields.includes("source")) facts.push(terminalText(row.values.source));
		if (fields.includes("unread")) facts.push(row.values.unread ? "Unread" : "Read");
		if (fields.includes("requiresAction") && row.values.requiresAction) facts.push("Needs action");
		if (facts.length) body.push(...wrap(facts.join(" · "), inner));
		if (fields.includes("summary") && row.values.summary) {
			body.push("");
			const preview = wrap(terminalText(row.values.summary), inner);
			body.push(...preview.slice(0, 4));
			if (preview.length > 4) body.push("…");
		}
		for (const field of fields.filter((field) => !["title", "timestamp", "source", "unread", "requiresAction", "summary"].includes(field))) {
			body.push(...wrap(`${field}: ${terminalText(row.values[field])}`, inner));
		}
		if (cards) {
			const stateLine = wrap(`${dot} ${inboxReference(row.id)} · ${state === "action" ? "Needs action" : state === "unread" ? "Unread" : "Read"}`, inner);
			lines.push(boxen([...titles.map(ink.title), "", ...stateLine.map((line) => ink.point(line, state)), ...body].join("\n"), {
				width, borderStyle: "single", padding: { left: 1, right: 1, top: 0, bottom: 0 },
			}), "");
		} else {
			const day = fields.includes("timestamp") && typeof row.values.timestamp === "string" ? row.values.timestamp.slice(0, 10) : undefined;
			if (row.parentId === null && day && date !== day) {
				date = day;
				lines.push(ink.muted(fitInboxCell(`── ${day}`, width)));
			}
			const list = new Table({ colWidths: [1, inner],
				chars: { top: "", "top-mid": "", "top-left": "", "top-right": "", bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "", left: "", right: "", middle: "  ", mid: "", "left-mid": "", "right-mid": "", "mid-mid": "" },
				style: { head: [], border: [], "padding-left": 0, "padding-right": 0, compact: true },
			});
			list.push([ink.point(dot, state), wrap(`${fields.includes("timestamp") ? `${age(row.values.timestamp, now)}  ` : ""}${inboxReference(row.id)}`, inner).map(ink.reference).join("\n")]);
			list.push([ink.border("│"), [...titles.map(ink.title), ...body].join("\n")]);
			lines.push(list.toString(), "");
		}
	}
	return lines;
}

/** Format a one-shot snapshot with scope, freshness, diagnostics, and its resolved text presentation. */
export function formatInboxSnapshot(snapshot: InboxSnapshot, options: InboxTextOptions = {}): string {
	const supplied = options.columns ?? inboxTerminalColumns();
	const width = Math.max(18, Math.floor(Number.isFinite(supplied) ? supplied : 80) - 2);
	const now = options.now ?? Date.now();
	const ink = inboxInk(options.color ?? inboxColorEnabled());
	const query = snapshot.query, counts = snapshot.pages[0]!.summaries;
	const title = snapshot.view.definition.slots["toolbar.primary.identity"]?.[0]?.label ?? snapshot.view.definition.id;
	const scope = query.facet === "messages" ? `Messages / ${query.mailbox}` : query.facet === "brain" ? `Brain / ${query.brainCategory}` : query.facet;
	const lines = wrap(`${title} · ${scope}`, width);
	lines.push(...wrap(`${snapshot.items.length} shown · ${counts.total?.toLocaleString("en-US") ?? "unknown"} total · ${counts.unread?.toLocaleString("en-US") ?? "unknown"} unread · ${counts.requiresAction?.toLocaleString("en-US") ?? "unknown"} need action`, width));
	if (query.search || query.profileId !== "local" || query.sort.direction !== "desc") lines.push(...wrap(
		[query.search ? `Search: ${query.search}` : "", query.profileId !== "local" ? `Profile: ${query.profileId}` : "", query.sort.direction === "asc" ? "Oldest first" : ""].filter(Boolean).join(" · "), width));
	const sources = [...new Set(snapshot.pages.flatMap((page) => page.sources.map((source) => `${source.id}: ${source.status}${source.complete ? "" : " / incomplete"}`)))];
	lines.push(...wrap(`Sources: ${sources.join(" · ")}`, width));
	if (!snapshot.complete) lines.push(...wrap("INCOMPLETE SOURCES — these rows are not an authoritative empty Inbox.", width));
	for (const diagnostic of snapshot.diagnostics) lines.push(...wrap(`Notice: ${diagnostic}`, width));
	for (const value of snapshot.metadata) lines.push(...wrap(`${value.label}: ${value.field === "timestamp" ? age(value.value, now) : terminalText(value.value)} (${value.scope})`, width));
	const grid = snapshot.presentation.implementation === "collection.grid";
	const rendered = grid ? tableRows(snapshot, width, now) : { lines: listRows(snapshot, width, now, ink), hidden: [] };
	lines.push("", ...rendered.lines);
	if (!snapshot.rows.length) lines.push(...wrap(snapshot.complete ? "Nothing in this view." : "No items could be loaded authoritatively; this is not an empty Inbox.", width));
	while (lines.at(-1) === "") lines.pop();
	lines.push("");
	if (rendered.hidden.length) lines.push(...wrap(`Hidden at this width: ${rendered.hidden.join(", ")}. Use --width or --json for more detail.`, width));
	if (!grid && snapshot.rows.length) lines.push(...wrap("◆ needs action · ● unread · ○ read", width));
	lines.push(...wrap("Open: coleo inbox show <ref> · Full IDs and cursors: --json", width));
	if (snapshot.traversal.exhausted) lines.push(...wrap(`${snapshot.traversal.loadedPages} page${snapshot.traversal.loadedPages === 1 ? "" : "s"} · End of history`, width));
	else if (snapshot.complete) lines.push(...wrap("More history available · use --pages or --json for the next cursor.", width));
	else lines.push(...wrap("Traversal stopped · retry the same window; retryCursor is in --json.", width));
	return lines.join("\n");
}
