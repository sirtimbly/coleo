import { INBOX_TRIAGE_REGISTRY } from "../../../workbench/examples/inbox-triage-registry";
import { reconcileMessagingPage } from "../../../workbench/messaging-collection";
import { messagingQueryIdentity, normalizeMessagingQuery } from "../../../workbench/messaging-query";
import { parseResourceViewDefinition, resolveResourceViewFeatures } from "../../../workbench/resource-view-definition";
import { fixtureSnapshot } from "../snapshots";
import { escapeHtml as html, fingerprint, outageChart, pagingChart } from "./report-charts";
import { currentRenderer, detailPeek, metadataPanel, resourceContent, snapshotRows, sourceBar, toolbar } from "./report-renderers";

import type { MessagingCollectionPage, MessagingItem } from "../../../workbench/messaging-collection";
import type { ResourceViewDefinition } from "../../../workbench/resource-view-definition";
import type { DemoClient, DemoSourceMode, WorkbenchReportData } from "../types";
import type { PreviewContext } from "./report-renderers";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing report element: ${id}`);
	return node as T;
}

const data = JSON.parse(element("report-data").textContent ?? "{}") as WorkbenchReportData;
const original = parseResourceViewDefinition(data.blueprint, INBOX_TRIAGE_REGISTRY);
let definition: ResourceViewDefinition = original;
let query = normalizeMessagingQuery(definition.query);
let searchText = query.search;
let items: readonly MessagingItem[] = structuredClone(data.items);
let client: DemoClient = "web";
let sourceMode: DemoSourceMode = "healthy";
let presentation = definition.presentation.active;
let metadata = false;
let selectedId: string | null = null;
let showDetails = false;
let format: "text" | "json" = "text";
let latestContext: PreviewContext;
let animation: ReturnType<typeof setInterval> | undefined;
const cache = new Map<string, MessagingCollectionPage>();
const stage = element("resource-stage");
const editor = element<HTMLTextAreaElement>("definition-source");
const feedback = element("demo-feedback");
const scrubber = element<HTMLInputElement>("page-scrubber");

function message(text: string): void { feedback.textContent = text; }

function render(): void {
	const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const focusControl = focused?.dataset.control;
	const focusCommand = focused?.dataset.command;
	const terminalFocused = focused?.classList.contains("terminal");
	const selection = focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] as const : null;
	const view = parseResourceViewDefinition({
		...definition, query,
		presentation: { ...definition.presentation, active: presentation },
		...(definition.insights ? { insights: {
			...definition.insights, active: metadata ? definition.insights.panels[0]?.id ?? null : null,
		} } : {}),
	}, INBOX_TRIAGE_REGISTRY);
	const incoming = fixtureSnapshot(items, query, sourceMode);
	const page = reconcileMessagingPage(cache.get(incoming.queryId), incoming);
	cache.set(page.queryId, page);
	if (selectedId && !page.items.some((item) => item.id === selectedId)) selectedId = null;
	if (client === "tui" && !selectedId) selectedId = page.items[0]?.id ?? null;
	latestContext = { view, page, client, mode: sourceMode, selectedId, showDetails, metadata, format, searchText };
	const capabilities = new Set(client === "web" ? ["table", "adaptive-cards", "timeline", "charts", "text"] : ["table", "text"]);
	const features = resolveResourceViewFeatures(view, INBOX_TRIAGE_REGISTRY, capabilities);
	const renderer = features.presentation.find((feature) => feature.id === presentation);
	const incomplete = !page.summaries.complete;
	const retained = page.items.filter((item) => !incoming.items.some((received) => received.id === item.id)).length;
	stage.innerHTML = toolbar("primary", latestContext) + toolbar("secondary", latestContext) +
		(incomplete ? `<div class="view-warning">Mail is unavailable. ${retained ? `${retained} previously loaded resource${retained === 1 ? " is" : "s are"} retained in this query.` : "There is no previous mail snapshot for this query."} Counts are incomplete.</div>` : "") +
		metadataPanel(latestContext) + `<div class="view-content">${resourceContent(latestContext)}</div>` +
		sourceBar(latestContext) + detailPeek(latestContext);
	element("query-fingerprint").textContent = fingerprint(messagingQueryIdentity(query));
	const captions = {
		web: `Browser / ${currentRenderer(latestContext).label}. HTML demo adapter; Coleo's application uses Tabulator and AdaptiveCardCollection.`,
		cli: "CLI / a one-shot text or JSON snapshot of the same projected fields. Command syntax shown here is proposed, not installed.",
		tui: "TUI / an HTML terminal preview. Focus the list, then use j/k, Enter, m, or r. Native OpenTUI wiring is next.",
	};
	element("adapter-caption").innerHTML = `${html(captions[client])}${renderer?.diagnostic ? ` <strong>${html(renderer.diagnostic)}.</strong>` : ""}`;
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-client]")) {
		button.setAttribute("aria-pressed", String(button.dataset.client === client));
	}
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-source-mode]")) {
		button.setAttribute("aria-pressed", String(button.dataset.sourceMode === sourceMode));
	}
	const requestsMail = page.sources.some((source) => source.id === "mail");
	element("source-lab-note").textContent = !requestsMail && sourceMode !== "healthy"
		? "This active view does not request mail, so the mail scenario does not make its snapshot incomplete."
		: sourceMode === "unavailable"
			? `Unavailable source: ${incoming.items.length} resources received, ${retained} retained for this query. No outage is described as an empty mailbox.`
			: sourceMode === "empty"
				? "The mail source authoritatively returned an empty section. Cached mail rows were removed; the remaining snapshot is complete."
				: "Mail is healthy. Fixture snapshots are flowing through the real reconciliation contract.";
	element("contract-inspector").textContent = JSON.stringify({
		view: view.id, query, queryIdentity: page.queryId, resourceIds: page.items.map((item) => item.id),
		fields: currentRenderer(latestContext).fields, commands: view.commands, sourceStates: page.sources, features,
	}, null, 2);
	const restore = terminalFocused ? stage.querySelector<HTMLElement>(".terminal")
		: focusControl ? stage.querySelector<HTMLElement>(`[data-control="${CSS.escape(focusControl)}"]`)
			: focusCommand ? stage.querySelector<HTMLElement>(`[data-command="${CSS.escape(focusCommand)}"]`) : null;
	if (restore) {
		restore.focus({ preventScroll: true });
		if (restore instanceof HTMLInputElement && selection && selection[0] !== null && selection[1] !== null) {
			restore.setSelectionRange(selection[0], selection[1]);
		}
	}
}

function runCommand(command: string): void {
	if (!definition.commands.includes(command)) return message(`Command is not declared by this view: ${command}`);
	if (command === "inbox.refresh") {
		message("inbox.refresh / rebuilt this local fixture snapshot through the shared query and reconciliation modules.");
	} else if (command === "inbox.open") {
		if (!selectedId) return message("Select a resource to inspect its stable identity and semantic detail reference.");
		showDetails = true;
		message(`inbox.open / ${selectedId}. Showing fixture detail; no browser-only route is part of the contract.`);
	} else if (command === "inbox.mark-read") {
		const selected = latestContext.page.items.find((item) => item.id === selectedId);
		if (!selected) return message("Select a resource before marking it read.");
		if (!selected.unread) return message("This resource is already read in the demo fixture.");
		if (selected.sourceId === "mail" && sourceMode === "unavailable") {
			return message("Recover mail before updating this fixture resource. Unavailable sources do not report successful writes.");
		}
		items = items.map((item) => item.id === selectedId ? {
			...item, unread: false, requiresAction: item.sourceId === "mail" ? false : item.requiresAction,
			revision: `${item.revision}-read`,
		} : item);
		message(`inbox.mark-read / ${selectedId}. Updated only the demo fixture; live application mutations still belong to the API.`);
	}
	render();
}

stage.addEventListener("click", (event) => {
	const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button") : null;
	if (!target || target instanceof HTMLButtonElement && target.disabled) return;
	if (target.dataset.resource) {
		selectedId = target.dataset.resource;
		showDetails = true;
		message(`Selected ${selectedId}. Its identity survives every presentation and client switch.`);
		render();
	} else if (target.dataset.command) runCommand(target.dataset.command);
	else if (target.dataset.control === "metadata") { metadata = !metadata; render(); }
	else if (target.dataset.control === "close-details") { showDetails = false; render(); }
	else if (target.dataset.format === "text" || target.dataset.format === "json") { format = target.dataset.format; render(); }
});

stage.addEventListener("input", (event) => {
	if (!(event.target instanceof HTMLInputElement) || event.target.dataset.control !== "search") return;
	searchText = event.target.value;
	query = normalizeMessagingQuery({ ...query, search: searchText });
	render();
});

stage.addEventListener("change", (event) => {
	if (!(event.target instanceof HTMLSelectElement)) return;
	const { value } = event.target;
	if (event.target.dataset.control === "facet") query = normalizeMessagingQuery({ ...query, facet: value });
	else if (event.target.dataset.control === "sort") query = normalizeMessagingQuery({ ...query, sort: { field: "timestamp", direction: value } });
	else if (event.target.dataset.control === "presentation") presentation = value;
	render();
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-client]")) {
	button.addEventListener("click", () => {
		client = button.dataset.client as DemoClient;
		render();
		if (client === "tui") stage.querySelector<HTMLElement>(".terminal")?.focus({ preventScroll: true });
		message(`Same view, query ${fingerprint(messagingQueryIdentity(query))}. Only the ${client} adapter changed.`);
	});
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-source-mode]")) {
	button.addEventListener("click", () => { sourceMode = button.dataset.sourceMode as DemoSourceMode; render(); });
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-highlight]")) {
	button.addEventListener("click", () => {
		if (button.dataset.highlight === "metadata" && definition.insights?.panels.length) { metadata = true; render(); }
		stage.dataset.highlight = button.dataset.highlight;
		setTimeout(() => delete stage.dataset.highlight, 1800);
	});
}

stage.addEventListener("keydown", (event) => {
	if (client !== "tui" || !(event.target instanceof HTMLElement) || !event.target.classList.contains("terminal")) return;
	const index = latestContext.page.items.findIndex((item) => item.id === selectedId);
	if (["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
		event.preventDefault();
		const step = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
		selectedId = latestContext.page.items[Math.max(0, Math.min(latestContext.page.items.length - 1, index + step))]?.id ?? null;
		render();
	} else if (["Enter", "m", "r"].includes(event.key)) {
		event.preventDefault();
		runCommand(event.key === "Enter" ? "inbox.open" : event.key === "m" ? "inbox.mark-read" : "inbox.refresh");
	}
});

function validateDefinition(): void {
	try {
		const parsed = parseResourceViewDefinition(JSON.parse(editor.value), INBOX_TRIAGE_REGISTRY);
		definition = parsed;
		query = normalizeMessagingQuery(parsed.query);
		searchText = query.search;
		presentation = parsed.presentation.active;
		metadata = parsed.insights?.active !== null && parsed.insights?.active !== undefined;
		element("definition-status").classList.remove("invalid");
		element("definition-status").textContent = "Valid definition. Local preview updated; the source example and live Coleo state are untouched.";
		render();
	} catch (error) {
		element("definition-status").classList.add("invalid");
		element("definition-status").textContent = `${error instanceof Error ? error.message : String(error)} · Last valid definition remains active.`;
	}
}

let editTimer: ReturnType<typeof setTimeout>;
editor.value = JSON.stringify(data.blueprint, null, 2);
editor.addEventListener("input", () => { clearTimeout(editTimer); editTimer = setTimeout(validateDefinition, 300); });
element("break-binding").addEventListener("click", () => {
	const broken = structuredClone(original);
	const control = broken.slots["toolbar.primary.search"]?.[0];
	if (!control) return;
	editor.value = JSON.stringify({ ...broken, slots: { ...broken.slots,
		"toolbar.primary.search": [{ ...control, binding: "query.unknown" }],
	} }, null, 2);
	validateDefinition();
});
element("reset-definition").addEventListener("click", () => { editor.value = JSON.stringify(data.blueprint, null, 2); validateDefinition(); });

element("download-snapshot").addEventListener("click", () => {
	const payload = { view: latestContext.view, query: latestContext.page.query,
		sources: latestContext.page.sources, complete: latestContext.page.summaries.complete, items: snapshotRows(latestContext) };
	const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
	const link = document.createElement("a");
	link.href = url; link.download = `${definition.id.replace(/[^a-z0-9._-]/gi, "-")}.snapshot.json`; link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
});
element("print-report").addEventListener("click", () => window.print());

function updatePaging(page: number): void {
	scrubber.value = String(page);
	element("page-readout").textContent = String(page);
	element("paging-chart").innerHTML = pagingChart(data.paging, page);
}
scrubber.max = String(data.paging.after.length);
scrubber.addEventListener("input", () => { clearInterval(animation); updatePaging(Number(scrubber.value)); });
element("replay-paging").addEventListener("click", () => {
	clearInterval(animation);
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return updatePaging(data.paging.after.length);
	let page = 0;
	updatePaging(0);
	animation = setInterval(() => { updatePaging(++page); if (page >= data.paging.after.length) clearInterval(animation); }, 120);
});

element("before-total").textContent = String(data.paging.before.at(-1));
element("after-total").textContent = String(data.paging.after.at(-1));
element("duplicates").textContent = String(data.paging.duplicates);
element("page-size").textContent = String(data.paging.pageSize);
element("test-count").textContent = String(data.verification.passed);
element("assertion-count").textContent = String(data.verification.assertions);
element("report-provenance").textContent = `Generated ${data.generatedAt.replace("T", " ").slice(0, 19)} UTC\nWorking tree based on ${data.revision} · actual checks run during generation`;
element("outage-chart").innerHTML = outageChart(data.items);
updatePaging(data.paging.after.length);
render();
