import { INBOX_TRIAGE_REGISTRY } from "../../../workbench/examples/inbox-triage-registry";
import { reconcileMessagingPage } from "../../../workbench/messaging-collection";
import { indexMessagingHierarchy, markHierarchyMessagesRead, matchingMessageHierarchyIds } from "../../../workbench/message-hierarchy";
import { hierarchySelectionSummaries, hierarchySubtreeIds, toggleHierarchySelection, visibleHierarchyRows } from "../../../workbench/resource-hierarchy";
import { messagingQueryIdentity, normalizeMessagingQuery } from "../../../workbench/messaging-query";
import { parseResourceViewDefinition, resolveResourceViewFeatures } from "../../../workbench/resource-view-definition";
import { fixtureSnapshot } from "../snapshots";
import { addReviewReply } from "../thread-arrival";
import { escapeHtml as html, fingerprint, outageChart, pagingChart } from "./report-charts";
import { currentRenderer, detailPeek, metadataPanel, resourceContent, snapshotRows, sourceBar, toolbar } from "./report-renderers";
import { hierarchySnapshot } from "./report-tree";

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
let targetId: string | null = null;
let selectedIds: ReadonlySet<string> = new Set();
let expandedIds = new Set<string>();
const initializedRoots = new Set<string>();
let arrival = 0;
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
	const focusToggle = focused?.dataset.treeToggle;
	const focusBranch = focused?.dataset.selectBranch;
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
	const index = indexMessagingHierarchy(page.items);
	for (const root of index.hierarchy.rootIds) {
		if (initializedRoots.has(root)) continue;
		initializedRoots.add(root);
		if (view.hierarchy?.initialExpansion === "all") {
			for (const id of hierarchySubtreeIds(index, root)) if (index.children.get(id)!.length) expandedIds.add(id);
		} else if (view.hierarchy?.initialExpansion === "roots") expandedIds.add(root);
	}
	selectedIds = new Set([...selectedIds].filter((id) => index.byId.get(id)?.selectable));
	const rows = visibleHierarchyRows(index, expandedIds, matchingMessageHierarchyIds(index, query.search));
	const visibleIds = new Set(rows.map((row) => row.node.id));
	while (selectedId && !visibleIds.has(selectedId)) selectedId = index.byId.get(selectedId)?.parentId ?? null;
	if (client === "tui" && !selectedId) selectedId = rows[0]?.node.id ?? null;
	if (!targetId || !index.children.get(targetId)?.length) targetId = index.preorder.find((id) => index.children.get(id)!.length) ?? null;
	const tree = { index, rows, expandedIds, selectedIds, summaries: hierarchySelectionSummaries(index, selectedIds) };
	latestContext = { view, page, client, mode: sourceMode, selectedId, showDetails, metadata, format, searchText, tree, targetId };
	const capabilities = new Set(client === "web" ? ["table", "adaptive-cards", "timeline", "charts", "text"] : ["table", "text"]);
	const features = resolveResourceViewFeatures(view, INBOX_TRIAGE_REGISTRY, capabilities);
	const renderer = features.presentation.find((feature) => feature.id === presentation);
	const incomplete = !page.summaries.complete;
	const retained = page.items.filter((item) => !incoming.items.some((received) => received.id === item.id)).length;
	stage.innerHTML = toolbar("primary", latestContext) + toolbar("secondary", latestContext) +
		(incomplete ? `<div class="view-warning">Mail is unavailable. ${retained ? `${retained} previously loaded resource${retained === 1 ? " is" : "s are"} retained in this query.` : "There is no previous mail snapshot for this query."} Counts are incomplete.</div>` : "") +
		metadataPanel(latestContext) + `<div class="view-content">${resourceContent(latestContext)}</div>` +
		sourceBar(latestContext) + detailPeek(latestContext);
	for (const checkbox of stage.querySelectorAll<HTMLInputElement>("[data-select-branch]")) {
		checkbox.indeterminate = checkbox.dataset.state === "mixed";
	}
	element("query-fingerprint").textContent = fingerprint(messagingQueryIdentity(query));
	const captions = {
		web: `Browser / ${currentRenderer(latestContext).label}. HTML demo adapter; Coleo's application uses Tabulator and AdaptiveCardCollection.`,
		cli: "CLI / a one-shot text or JSON snapshot of the same projected fields. Command syntax shown here is proposed, not installed.",
		tui: "TUI / HTML keyboard preview. j/k moves focus; left/right folds branches; Space selects a loaded branch; Shift+Space selects one message. Native OpenTUI wiring is next.",
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
		hierarchy: hierarchySnapshot(tree, currentRenderer(latestContext).fields), focusId: selectedId,
	}, null, 2);
	const restore = terminalFocused ? stage.querySelector<HTMLElement>(".terminal")
		: focusToggle ? stage.querySelector<HTMLElement>(`[data-tree-toggle="${CSS.escape(focusToggle)}"]`)
			: focusBranch ? stage.querySelector<HTMLElement>(`[data-select-branch="${CSS.escape(focusBranch)}"]`)
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
		const targets = selectedIds.size ? [...selectedIds] : selectedId ? [selectedId] : [];
		const selected = targets.map((id) => latestContext.tree.index.byId.get(id)).filter((node) => node?.selectable);
		if (selected.some((node) => node!.data.sourceId === "mail") && sourceMode === "unavailable") {
			return message("Recover mail before updating this fixture resource. Unavailable sources do not report successful writes.");
		}
		const eligible = selected.filter((node) => node!.data.unread && (node!.data.sourceId !== "mail" ||
			node!.data.locations?.some((location) => location.mailbox === "inbox" && !location.seen)));
		if (!eligible.length) return message("Select an unread message or a loaded branch with unread Inbox messages.");
		items = markHierarchyMessagesRead(items, new Set(eligible.map((node) => node!.id)));
		message(`inbox.mark-read / ${eligible.length} eligible loaded resources updated in the local fixture. Sent-only context is read-only.`);
	}
	render();
}

function selectBranch(id: string, scope: "node" | "subtree" = "subtree"): void {
	selectedIds = toggleHierarchySelection(latestContext.tree.index, selectedIds, id, scope);
	selectedId = id;
	message(`${selectedIds.size} explicit loaded members selected. Collapsing does not clear them; incoming replies are not auto-selected.`);
	render();
}

function setQuery(value: unknown): void {
	const next = normalizeMessagingQuery(value);
	const scope = (candidate: typeof query) => JSON.stringify({ ...candidate, sort: null, limit: null });
	if (scope(next) !== scope(query)) { selectedIds = new Set(); selectedId = null; }
	query = next;
}

stage.addEventListener("click", (event) => {
	const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button") : null;
	if (!target || target instanceof HTMLButtonElement && target.disabled) return;
	if (target.dataset.resource) {
		selectedId = target.dataset.resource;
		showDetails = true;
		message(`Selected ${selectedId}. Its identity survives every presentation and client switch.`);
		render();
	} else if (target.dataset.treeToggle) {
		const id = target.dataset.treeToggle;
		if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
		render();
	} else if (target.dataset.command) runCommand(target.dataset.command);
	else if (target.dataset.control === "metadata") { metadata = !metadata; render(); }
	else if (target.dataset.control === "close-details") { showDetails = false; render(); }
	else if (target.dataset.control === "clear-selection") { selectedIds = new Set(); render(); }
	else if (target.dataset.control === "expand-all") {
		for (const id of latestContext.tree.index.preorder) if (latestContext.tree.index.children.get(id)!.length) expandedIds.add(id);
		render();
	}
	else if (target.dataset.control === "collapse-all") { expandedIds.clear(); render(); }
	else if (target.dataset.control === "select-focused" && selectedId) selectBranch(selectedId);
	else if (target.dataset.control === "select-node" && selectedId) selectBranch(selectedId, "node");
	else if (target.dataset.control === "select-target" && targetId) selectBranch(targetId);
	else if (target.dataset.control === "toggle-target" && targetId) {
		if (expandedIds.has(targetId)) expandedIds.delete(targetId); else expandedIds.add(targetId);
		render();
	}
	else if (target.dataset.control === "add-reply") {
		items = addReviewReply(items, ++arrival);
		message("A reply arrived in the API branch. Its new ID is unselected; an earlier whole-branch selection becomes mixed.");
		render();
	}
	else if (target.dataset.format === "text" || target.dataset.format === "json") { format = target.dataset.format; render(); }
});

stage.addEventListener("input", (event) => {
	if (!(event.target instanceof HTMLInputElement) || event.target.dataset.control !== "search") return;
	searchText = event.target.value;
	setQuery({ ...query, search: searchText });
	render();
});

stage.addEventListener("change", (event) => {
	if (event.target instanceof HTMLInputElement && event.target.dataset.selectBranch) {
		selectBranch(event.target.dataset.selectBranch); return;
	}
	if (!(event.target instanceof HTMLSelectElement)) return;
	const { value } = event.target;
	if (event.target.dataset.control === "facet") setQuery({ ...query, facet: value });
	else if (event.target.dataset.control === "sort") setQuery({ ...query, sort: { field: "timestamp", direction: value } });
	else if (event.target.dataset.control === "presentation") presentation = value;
	else if (event.target.dataset.control === "group-target") targetId = value;
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
	const index = latestContext.tree.rows.findIndex((row) => row.node.id === selectedId);
	if (["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
		event.preventDefault();
		const step = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
		selectedId = latestContext.tree.rows[Math.max(0, Math.min(latestContext.tree.rows.length - 1, index + step))]?.node.id ?? null;
		render();
	} else if (event.key === " " && selectedId) {
		event.preventDefault(); selectBranch(selectedId, event.shiftKey ? "node" : "subtree");
	} else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && selectedId) {
		event.preventDefault();
		const children = latestContext.tree.index.children.get(selectedId)!;
		if (event.key === "ArrowRight") {
			if (expandedIds.has(selectedId) && children.length) selectedId = children[0]!;
			else expandedIds.add(selectedId);
		} else if (expandedIds.has(selectedId) && children.length) expandedIds.delete(selectedId);
		else selectedId = latestContext.tree.index.byId.get(selectedId)?.parentId ?? selectedId;
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
		setQuery(parsed.query);
		initializedRoots.clear(); expandedIds.clear(); selectedIds = new Set();
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
		sources: latestContext.page.sources, complete: latestContext.page.summaries.complete, items: snapshotRows(latestContext),
		hierarchy: hierarchySnapshot(latestContext.tree, currentRenderer(latestContext).fields) };
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
if (data.threading) element("thread-api-proof").textContent =
	`Real API fixture: ${data.threading.threads} conversations, ${data.threading.messages} messages. ` +
	`POST /api/mail/threads/review/selection resolved exactly ${data.threading.apiBranchMemberIds.length} API-branch members with a revision guard.`;
updatePaging(data.paging.after.length);
render();
