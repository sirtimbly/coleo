import { useEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TabulatorFull as Tabulator } from "tabulator-tables";

import { cn } from "@/lib";

import type { InboxProjectionItem } from "./ProjectionInbox";
import type {
	CellComponent,
	ColumnDefinition,
	Formatter,
	RowComponent,
} from "tabulator-tables";

import "tabulator-tables/dist/css/tabulator.min.css";
import "./inbox-card-table.css";

interface InboxTableRow {
	id: string;
	state: string;
	source: string;
	title: string;
	summary: string;
	kind: string;
	timestamp: string;
	timestampValue: number;
	unread: boolean;
	requiresAction: boolean;
	severity: InboxProjectionItem["severity"];
}

interface MountedCard {
	id: string;
	host: HTMLDivElement;
	root: Root;
	resizeObserver: ResizeObserver;
	normalizeFrame: number | null;
}

interface InboxCardTableRuntime {
	itemsById: Map<string, InboxProjectionItem>;
	renderCard: (item: InboxProjectionItem) => ReactNode;
	onOpen: (item: InboxProjectionItem) => void;
}

function disposeMountedCard(mounted: MountedCard): void {
	mounted.resizeObserver.disconnect();
	if (mounted.normalizeFrame !== null) window.cancelAnimationFrame(mounted.normalizeFrame);
	mounted.host.remove();
	// A card action can update the parent Inbox while its nested React root is
	// still rendering. Deferring disposal avoids unmounting that root mid-commit.
	queueMicrotask(() => mounted.root.unmount());
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, {
	numeric: "auto",
	style: "narrow",
});

function relativeTime(timestamp: string): string {
	const difference = Date.parse(timestamp) - Date.now();
	if (!Number.isFinite(difference)) return "Unknown";
	const absolute = Math.abs(difference);
	if (absolute < 60_000) return RELATIVE_TIME.format(Math.round(difference / 1_000), "second");
	if (absolute < 3_600_000) return RELATIVE_TIME.format(Math.round(difference / 60_000), "minute");
	if (absolute < 86_400_000) return RELATIVE_TIME.format(Math.round(difference / 3_600_000), "hour");
	return RELATIVE_TIME.format(Math.round(difference / 86_400_000), "day");
}

function projectRow(item: InboxProjectionItem): InboxTableRow {
	const timestampValue = Date.parse(item.timestamp);
	return {
		id: item.id,
		state: item.requiresAction ? "Action" : item.unread ? "Unread" : "Read",
		source: item.source ?? item.kind,
		title: item.title,
		summary: item.summary,
		kind: item.kind,
		timestamp: item.timestamp,
		timestampValue: Number.isFinite(timestampValue) ? timestampValue : 0,
		unread: item.unread,
		requiresAction: item.requiresAction,
		severity: item.severity,
	};
}

function readRow(row: RowComponent): InboxTableRow | null {
	const data = row.getData() as Partial<InboxTableRow>;
	return typeof data.id === "string" ? data as InboxTableRow : null;
}

function textElement(tag: "span" | "strong", className: string, text: string): HTMLElement {
	const element = document.createElement(tag);
	element.className = className;
	element.textContent = text;
	return element;
}

const stateFormatter: Formatter = (cell) => {
	const data = cell.getRow().getData() as InboxTableRow;
	const wrapper = document.createElement("span");
	wrapper.className = "coleo-inbox-state";
	const dot = document.createElement("span");
	dot.className = cn(
		"coleo-inbox-state-dot",
		data.severity === "danger" && "is-danger",
		data.severity === "warning" && "is-warning",
		data.severity === "success" && "is-success",
		(!data.severity || data.severity === "info") && "is-info",
	);
	dot.setAttribute("aria-hidden", "true");
	wrapper.append(dot, textElement("span", "", data.state));
	return wrapper;
};

const subjectFormatter: Formatter = (cell) => {
	const data = cell.getRow().getData() as InboxTableRow;
	const wrapper = document.createElement("span");
	wrapper.className = "coleo-inbox-subject";
	wrapper.append(
		textElement("strong", "coleo-inbox-subject-title", data.title),
		textElement("span", "coleo-inbox-subject-summary", data.summary),
	);
	return wrapper;
};

const timeFormatter: Formatter = (cell) => {
	const data = cell.getRow().getData() as InboxTableRow;
	const time = document.createElement("time");
	time.dateTime = data.timestamp;
	if (data.timestampValue > 0) time.title = new Date(data.timestampValue).toLocaleString();
	time.textContent = relativeTime(data.timestamp);
	return time;
};

export function InboxCardTable({
	items,
	renderCard,
	onOpen,
	className,
}: {
	items: InboxProjectionItem[];
	renderCard: (item: InboxProjectionItem) => ReactNode;
	onOpen: (item: InboxProjectionItem) => void;
	className?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const tableRef = useRef<Tabulator | null>(null);
	const expandedIdsRef = useRef(new Set<string>());
	const mountedCardsRef = useRef(new Map<HTMLElement, MountedCard>());
	const runtimeRef = useRef<InboxCardTableRuntime>({
		itemsById: new Map(items.map((item) => [item.id, item])),
		renderCard,
		onOpen,
	});
	runtimeRef.current = {
		itemsById: new Map(items.map((item) => [item.id, item])),
		renderCard,
		onOpen,
	};

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const mountedCards = mountedCardsRef.current;
		let disposed = false;
		let table: Tabulator | null = null;
		let resizeObserver: ResizeObserver | null = null;
		let redrawFrame: number | null = null;

		const unmountCard = (element: HTMLElement) => {
			const mounted = mountedCards.get(element);
			if (!mounted) return;
			mountedCards.delete(element);
			element.classList.remove("coleo-inbox-row-expanded");
			disposeMountedCard(mounted);
		};

		const updateExpander = (row: RowComponent, expanded: boolean) => {
			const data = readRow(row);
			const button = row.getElement().querySelector<HTMLButtonElement>(".coleo-inbox-expand");
			if (!data || !button) return;
			button.setAttribute("aria-expanded", String(expanded));
			button.setAttribute(
				"aria-label",
				`${expanded ? "Collapse" : "Expand"} ${data.title} card`,
			);
			button.title = expanded ? "Collapse card" : "Expand card";
			const glyph = button.querySelector<HTMLElement>("[aria-hidden='true']");
			if (glyph) glyph.textContent = expanded ? "⌄" : "›";
		};

		const renderExpandedCard = (row: RowComponent) => {
			const data = readRow(row);
			if (!data) return;
			const element = row.getElement();
			if (!expandedIdsRef.current.has(data.id)) {
				unmountCard(element);
				updateExpander(row, false);
				row.normalizeHeight();
				return;
			}
			const item = runtimeRef.current.itemsById.get(data.id);
			if (!item) return;
			const existing = mountedCards.get(element);
			if (existing?.id === data.id) {
				existing.root.render(runtimeRef.current.renderCard(item));
				updateExpander(row, true);
				queueMicrotask(() => row.normalizeHeight());
				return;
			}
			if (existing) unmountCard(element);
			const host = document.createElement("div");
			host.className = "coleo-inbox-card-detail";
			host.setAttribute("role", "region");
			host.setAttribute("aria-label", `${data.title} card`);
			element.classList.add("coleo-inbox-row-expanded");
			element.append(host);
			const root = createRoot(host);
			const mounted: MountedCard = {
				id: data.id,
				host,
				root,
				resizeObserver: new ResizeObserver(() => {
					if (mounted.normalizeFrame !== null || !host.isConnected) return;
					mounted.normalizeFrame = window.requestAnimationFrame(() => {
						mounted.normalizeFrame = null;
						if (host.isConnected) row.normalizeHeight();
					});
				}),
				normalizeFrame: null,
			};
			mountedCards.set(element, mounted);
			mounted.resizeObserver.observe(host);
			root.render(runtimeRef.current.renderCard(item));
			updateExpander(row, true);
			queueMicrotask(() => row.normalizeHeight());
		};

		const toggleRow = (row: RowComponent) => {
			const data = readRow(row);
			if (!data) return;
			if (expandedIdsRef.current.has(data.id)) expandedIdsRef.current.delete(data.id);
			else expandedIdsRef.current.add(data.id);
			renderExpandedCard(row);
		};

		const expanderFormatter: Formatter = (cell: CellComponent) => {
			const data = cell.getRow().getData() as InboxTableRow;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "coleo-inbox-expand";
			const expanded = expandedIdsRef.current.has(data.id);
			button.setAttribute("aria-expanded", String(expanded));
			button.setAttribute(
				"aria-label",
				`${expanded ? "Collapse" : "Expand"} ${data.title} card`,
			);
			button.title = expanded ? "Collapse card" : "Expand card";
			const glyph = document.createElement("span");
			glyph.setAttribute("aria-hidden", "true");
			glyph.textContent = expanded ? "⌄" : "›";
			button.append(glyph);
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				toggleRow(cell.getRow());
			});
			return button;
		};

		const columns: ColumnDefinition[] = [
			{
				title: "",
				field: "__expand",
				width: 44,
				minWidth: 44,
				headerSort: false,
				resizable: false,
				hozAlign: "center",
				formatter: expanderFormatter,
			},
			{
				title: "State",
				field: "state",
				width: 96,
				minWidth: 88,
				responsive: 1,
				formatter: stateFormatter,
			},
			{
				title: "Source",
				field: "source",
				width: 190,
				minWidth: 130,
				responsive: 3,
			},
			{
				title: "Subject",
				field: "title",
				minWidth: 260,
				widthGrow: 4,
				responsive: 0,
				formatter: subjectFormatter,
			},
			{
				title: "Type",
				field: "kind",
				width: 100,
				minWidth: 82,
				responsive: 4,
				formatter: (cell) => String(cell.getValue()).replace(/\b\w/g, (value) => value.toUpperCase()),
			},
			{
				title: "Received",
				field: "timestampValue",
				width: 112,
				minWidth: 96,
				responsive: 2,
				sorter: "number",
				formatter: timeFormatter,
			},
		];

		queueMicrotask(() => {
			if (disposed) return;
			const instance = new Tabulator(container, {
				index: "id",
				data: [...runtimeRef.current.itemsById.values()].map(projectRow),
				columns,
				height: "100%",
				layout: "fitColumns",
				responsiveLayout: "hide",
				renderVertical: "virtual",
				renderVerticalBuffer: 420,
				initialSort: [{ column: "timestampValue", dir: "desc" }],
				selectableRows: false,
				columnDefaults: {
					headerSortTristate: true,
					vertAlign: "middle",
				},
				rowFormatter: (row) => {
					const data = readRow(row);
					if (!data) return;
					const element = row.getElement();
					const mounted = mountedCards.get(element);
					if (mounted && mounted.id !== data.id) unmountCard(element);
					element.dataset.inboxItemId = data.id;
					element.classList.toggle("coleo-inbox-row-unread", data.unread);
					element.classList.toggle("coleo-inbox-row-action", data.requiresAction);
					if (expandedIdsRef.current.has(data.id)) {
						queueMicrotask(() => {
							if (!disposed) renderExpandedCard(row);
						});
					}
				},
			});
			table = instance;
			tableRef.current = instance;
			instance.on("rowClick", (event, row) => {
				const target = event.target;
				if (target instanceof Element && target.closest("button, a, input, select, textarea")) return;
				toggleRow(row);
			});
			instance.on("rowDblClick", (_event, row) => {
				const data = readRow(row);
				const item = data ? runtimeRef.current.itemsById.get(data.id) : undefined;
				if (item) runtimeRef.current.onOpen(item);
			});
			resizeObserver = new ResizeObserver(() => {
				if (disposed || redrawFrame !== null) return;
				redrawFrame = window.requestAnimationFrame(() => {
					redrawFrame = null;
					if (!disposed) instance.redraw(true);
				});
			});
			resizeObserver.observe(container);
		});

		return () => {
			disposed = true;
			resizeObserver?.disconnect();
			if (redrawFrame !== null) window.cancelAnimationFrame(redrawFrame);
			for (const element of [...mountedCards.keys()]) unmountCard(element);
			if (tableRef.current === table) tableRef.current = null;
			table?.destroy();
		};
	}, []);

	useEffect(() => {
		const table = tableRef.current;
		if (!table) return;
		const mountedCards = mountedCardsRef.current;
		for (const mounted of mountedCards.values()) {
			disposeMountedCard(mounted);
		}
		mountedCards.clear();
		const itemIds = new Set(items.map((item) => item.id));
		for (const id of expandedIdsRef.current) {
			if (!itemIds.has(id)) expandedIdsRef.current.delete(id);
		}
		void table.replaceData(items.map(projectRow));
	}, [items]);

	return (
		<div
			ref={containerRef}
			className={cn("coleo-inbox-card-table h-full min-h-0 overflow-hidden", className)}
			role="region"
			aria-label="Inbox cards"
		/>
	);
}
