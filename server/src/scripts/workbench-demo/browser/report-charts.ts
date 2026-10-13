import { reconcileMessagingPage } from "../../../workbench/messaging-collection";
import { normalizeMessagingQuery } from "../../../workbench/messaging-query";
import { fixtureSnapshot } from "../snapshots";

import type { MessagingItem } from "../../../workbench/messaging-collection";
import type { PagingEvidence } from "../types";

export function escapeHtml(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (character) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	})[character]!);
}

export function pagingChart(evidence: PagingEvidence, page: number): string {
	const width = 630, height = 270, left = 43, right = 40, top = 20, bottom = 39;
	const pages = evidence.after.length;
	const x = (index: number) => left + index / pages * (width - left - right);
	const y = (count: number) => height - bottom - count / evidence.fixtureTotal * (height - top - bottom);
	const value = (series: readonly number[], index: number) => index === 0 ? 0 : series[Math.min(index, series.length) - 1] ?? 0;
	const path = (series: readonly number[]) => Array.from({ length: page + 1 }, (_, index) =>
		`${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(value(series, index)).toFixed(2)}`).join(" ");
	const grid = [0, 100, 200, 300, 400, 500].map((count) =>
		`<line x1="${left}" x2="${width - right}" y1="${y(count)}" y2="${y(count)}" stroke="#e1ebf2"/>
		<text x="${left - 10}" y="${y(count) + 3}" text-anchor="end" fill="#597587" font-size="9">${count}</text>`).join("");
	const ticks = [0, 5, 10, 15, 20, pages].map((index) =>
		`<text x="${x(index)}" y="${height - 19}" text-anchor="middle" fill="#597587" font-size="9">${index}</text>`).join("");
	return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="At page ${page}, the fixed endpoint reached ${value(evidence.after, page)} of ${evidence.fixtureTotal} records; the old algorithm reached ${value(evidence.before, page)}.">
		${grid}${ticks}<text x="${width - right}" y="${height - 3}" text-anchor="end" fill="#597587" font-size="9">cursor pages</text>
		<path d="${path(evidence.after)} L${x(page)},${height - bottom} L${left},${height - bottom} Z" fill="#e7edff"/>
		<line x1="${x(page)}" x2="${x(page)}" y1="${top}" y2="${height - bottom}" stroke="#cfdee9" stroke-dasharray="3 4"/>
		<path d="${path(evidence.before)}" fill="none" stroke="#e68a31" stroke-width="2.5" stroke-dasharray="5 4"/>
		<path d="${path(evidence.after)}" fill="none" stroke="#2457da" stroke-width="3"/>
		<circle cx="${x(page)}" cy="${y(value(evidence.after, page))}" r="4" fill="#2457da"/>
		<circle cx="${x(page)}" cy="${y(value(evidence.before, page))}" r="3" fill="#e68a31"/>
		<text x="${x(page) - 8}" y="${y(value(evidence.after, page)) - 9}" text-anchor="end" fill="#2457da" font-size="12" font-weight="700">${value(evidence.after, page)}</text>
		<text x="${x(page) - 8}" y="${y(value(evidence.before, page)) + 17}" text-anchor="end" fill="#a95c16" font-size="11">${value(evidence.before, page)}</text>
	</svg>`;
}

export function outageChart(items: readonly MessagingItem[]): string {
	const query = normalizeMessagingQuery({ facet: "all" });
	const previous = fixtureSnapshot(items, query, "healthy");
	const rows = (["healthy", "unavailable", "empty"] as const).map((mode) => {
		const incoming = fixtureSnapshot(items, query, mode);
		const resolved = reconcileMessagingPage(previous, incoming);
		return { mode, received: incoming.items.length, retained: resolved.items.length - incoming.items.length };
	});
	const titles = { healthy: "Healthy snapshot", unavailable: "Mail unavailable", empty: "Mail confirmed empty" };
	const plotWidth = 205;
	return `<svg viewBox="0 0 470 192" role="img" aria-label="Healthy: eight received. Outage: six received plus two retained. Authoritative empty mailbox: six received, no mail retained.">
		<text x="0" y="14" font-size="11" fill="#172a3a" font-weight="600">A missing source is not a missing resource</text>
		${rows.map((row, index) => `<text x="0" y="${54 + index * 38}" fill="#597587" font-size="10">${titles[row.mode]}</text>
			<rect x="156" y="${42 + index * 38}" width="${plotWidth}" height="18" rx="3" fill="#edf3f7"/>
			<rect x="156" y="${42 + index * 38}" width="${row.received / items.length * plotWidth}" height="18" rx="3" fill="#2457da"/>
			<rect x="${156 + row.received / items.length * plotWidth}" y="${42 + index * 38}" width="${row.retained / items.length * plotWidth}" height="18" fill="#e68a31"/>
			<text x="375" y="${55 + index * 38}" fill="#172a3a" font-size="10">${row.received}${row.retained ? ` + ${row.retained}` : ""}</text>`).join("")}
		<circle cx="160" cy="177" r="3" fill="#2457da"/><text x="169" y="180" fill="#597587" font-size="9">Received</text>
		<circle cx="240" cy="177" r="3" fill="#e68a31"/><text x="249" y="180" fill="#597587" font-size="9">Retained, labelled stale</text>
	</svg>`;
}

export function fingerprint(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
	return (hash >>> 0).toString(16).padStart(8, "0");
}
