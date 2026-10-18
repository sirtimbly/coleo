export const TOOLBAR_SCREEN_IDS = [
	"inbox",
	"mail",
	"plan-documents",
	"tasks",
	"bugs",
	"arms",
	"processes",
	"arm-viewer",
] as const;

export type ToolbarScreenId = typeof TOOLBAR_SCREEN_IDS[number];
export type ToolbarRowSize = "small" | "large";

interface ToolbarItemBase {
	readonly id: string;
	readonly hidden?: boolean;
}

export interface ToolbarWidgetItem extends ToolbarItemBase {
	readonly kind: "widget";
	readonly widget: string;
	readonly label?: string;
}

export interface ToolbarLabelItem extends ToolbarItemBase {
	readonly kind: "label";
	readonly text: string;
}

export interface ToolbarDividerItem extends ToolbarItemBase {
	readonly kind: "divider";
}

export interface ToolbarSpacerItem extends ToolbarItemBase {
	readonly kind: "spacer";
}

export type ToolbarTemplateItem =
	| ToolbarWidgetItem
	| ToolbarLabelItem
	| ToolbarDividerItem
	| ToolbarSpacerItem;

export interface ToolbarRowTemplate {
	readonly id: string;
	readonly label: string;
	readonly size: ToolbarRowSize;
	readonly items: readonly ToolbarTemplateItem[];
}

export interface WorkbenchToolbarTemplate {
	readonly id: ToolbarScreenId;
	readonly rows: readonly [ToolbarRowTemplate, ToolbarRowTemplate];
}

export type ToolbarTemplateMap = Record<ToolbarScreenId, WorkbenchToolbarTemplate>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value;
}

function parseToolbarItem(
	value: unknown,
	path: string,
	allowedWidgets: ReadonlySet<string>,
): ToolbarTemplateItem {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const id = readString(value.id, `${path}.id`);
	const kind = readString(value.kind, `${path}.kind`);
	const hidden = value.hidden;
	if (hidden !== undefined && typeof hidden !== "boolean") {
		throw new Error(`${path}.hidden must be a boolean`);
	}
	const base = hidden === undefined ? { id } : { id, hidden };

	if (kind === "widget") {
		const widget = readString(value.widget, `${path}.widget`);
		if (!allowedWidgets.has(widget)) {
			throw new Error(`${path}.widget references unknown widget "${widget}"`);
		}
		if (value.label !== undefined && typeof value.label !== "string") {
			throw new Error(`${path}.label must be a string`);
		}
		return value.label === undefined
			? { ...base, kind, widget }
			: { ...base, kind, widget, label: value.label };
	}

	if (kind === "label") {
		return { ...base, kind, text: readString(value.text, `${path}.text`) };
	}

	if (kind === "divider" || kind === "spacer") {
		return { ...base, kind };
	}

	throw new Error(`${path}.kind must be widget, label, divider, or spacer`);
}

export function parseToolbarTemplate(
	value: unknown,
	screenId: ToolbarScreenId,
	allowedWidgetIds: readonly string[],
): WorkbenchToolbarTemplate {
	if (!isRecord(value)) throw new Error("Toolbar configuration must be an object");
	if (value.id !== screenId) throw new Error(`Toolbar id must be "${screenId}"`);
	if (!Array.isArray(value.rows) || value.rows.length !== 2) {
		throw new Error("Toolbar configuration must contain exactly two rows");
	}

	const allowedWidgets = new Set(allowedWidgetIds);
	const rowIds = new Set<string>();
	const rows = value.rows.map((rowValue, rowIndex): ToolbarRowTemplate => {
		const path = `rows[${rowIndex}]`;
		if (!isRecord(rowValue)) throw new Error(`${path} must be an object`);
		const id = readString(rowValue.id, `${path}.id`);
		if (rowIds.has(id)) throw new Error(`${path}.id must be unique`);
		rowIds.add(id);
		const label = readString(rowValue.label, `${path}.label`);
		if (rowValue.size !== "small" && rowValue.size !== "large") {
			throw new Error(`${path}.size must be "small" or "large"`);
		}
		if (!Array.isArray(rowValue.items)) throw new Error(`${path}.items must be an array`);

		const itemIds = new Set<string>();
		const items = rowValue.items.map((itemValue, itemIndex) => {
			const item = parseToolbarItem(itemValue, `${path}.items[${itemIndex}]`, allowedWidgets);
			if (itemIds.has(item.id)) {
				throw new Error(`${path}.items[${itemIndex}].id must be unique within its row`);
			}
			itemIds.add(item.id);
			return item;
		});

		return { id, label, size: rowValue.size, items };
	});

	return { id: screenId, rows: [rows[0]!, rows[1]!] };
}

export function parseToolbarTemplateJson(
	source: string,
	screenId: ToolbarScreenId,
	allowedWidgetIds: readonly string[],
): WorkbenchToolbarTemplate {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new Error(error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON");
	}
	return parseToolbarTemplate(value, screenId, allowedWidgetIds);
}

export const DEFAULT_TOOLBAR_TEMPLATES = {
	inbox: {
		id: "inbox",
		rows: [
			{
				id: "primary",
				label: "Inbox controls",
				size: "large",
				items: [
					{ id: "identity", kind: "widget", widget: "inbox.identity" },
					{ id: "identity-divider", kind: "divider" },
					{ id: "facet", kind: "widget", widget: "inbox.facet" },
					{ id: "messages-context", kind: "widget", widget: "inbox.context.messages" },
					{ id: "brain-context", kind: "widget", widget: "inbox.context.brain" },
					{ id: "primary-spacer", kind: "spacer" },
					{ id: "search", kind: "widget", widget: "inbox.search" },
					{ id: "mark-read", kind: "widget", widget: "inbox.mark-read" },
					{ id: "refresh", kind: "widget", widget: "inbox.refresh" },
				],
			},
			{
				id: "display",
				label: "Inbox display controls",
				size: "small",
				items: [
					{ id: "display-label", kind: "label", text: "Display" },
					{ id: "view-mode", kind: "widget", widget: "collection.view-mode" },
					{ id: "grid-density", kind: "widget", widget: "collection.grid-density" },
					{ id: "card-presentation", kind: "widget", widget: "collection.card-presentation" },
					{ id: "card-columns", kind: "widget", widget: "collection.card-columns" },
				],
			},
		],
	},
	mail: {
		id: "mail",
		rows: [
			{
				id: "primary",
				label: "Mail controls",
				size: "large",
				items: [
					{ id: "identity", kind: "widget", widget: "mail.identity" },
					{ id: "identity-divider", kind: "divider" },
					{ id: "mailbox-actions", kind: "widget", widget: "mail.mailbox-actions" },
					{ id: "primary-spacer", kind: "spacer" },
					{ id: "search", kind: "widget", widget: "mail.search" },
					{ id: "mark-read", kind: "widget", widget: "mail.mark-read" },
					{ id: "refresh", kind: "widget", widget: "mail.refresh" },
				],
			},
			{
				id: "display",
				label: "Mail display controls",
				size: "small",
				items: [
					{ id: "display-label", kind: "label", text: "Display" },
					{ id: "view-mode", kind: "widget", widget: "collection.view-mode" },
					{ id: "grid-density", kind: "widget", widget: "collection.grid-density" },
					{ id: "card-presentation", kind: "widget", widget: "collection.card-presentation" },
					{ id: "card-columns", kind: "widget", widget: "collection.card-columns" },
				],
			},
		],
	},
	"plan-documents": {
		id: "plan-documents",
		rows: [
			{
				id: "primary",
				label: "Plan and document controls",
				size: "large",
				items: [
					{ id: "file-count", kind: "widget", widget: "plan-documents.file-count" },
					{ id: "primary-spacer", kind: "spacer" },
					{ id: "regenerate", kind: "widget", widget: "plan-documents.regenerate-tasks" },
					{ id: "help", kind: "widget", widget: "plan-documents.help" },
					{ id: "save", kind: "widget", widget: "plan-documents.save" },
					{ id: "prepare", kind: "widget", widget: "plan-documents.prepare-tasks" },
				],
			},
			{
				id: "display",
				label: "Plan and document display controls",
				size: "small",
				items: [
					{ id: "show-label", kind: "label", text: "Show" },
					{ id: "scope", kind: "widget", widget: "plan-documents.scope" },
					{ id: "preview", kind: "widget", widget: "plan-documents.preview" },
					{ id: "display-spacer", kind: "spacer" },
					{ id: "document-status", kind: "widget", widget: "plan-documents.document-status" },
				],
			},
		],
	},
	tasks: {
		id: "tasks",
		rows: [
			{
				id: "primary",
				label: "Task controls",
				size: "large",
				items: [
					{ id: "search", kind: "widget", widget: "sheet.search" },
					{ id: "result-count", kind: "widget", widget: "sheet.result-count" },
					{ id: "insights-divider", kind: "divider" },
					{ id: "insights", kind: "widget", widget: "sheet.insights" },
					{ id: "drafts", kind: "widget", widget: "tasks.drafts-only" },
					{ id: "primary-spacer", kind: "spacer" },
					{ id: "help", kind: "widget", widget: "tasks.workflow-help" },
					{ id: "refresh", kind: "widget", widget: "sheet.refresh" },
					{ id: "create", kind: "widget", widget: "sheet.create" },
				],
			},
			{
				id: "display",
				label: "Task display controls",
				size: "small",
				items: [
					{ id: "view-label", kind: "label", text: "View" },
					{ id: "view-mode", kind: "widget", widget: "collection.view-mode" },
					{ id: "grid-density", kind: "widget", widget: "collection.grid-density" },
					{ id: "card-presentation", kind: "widget", widget: "collection.card-presentation" },
					{ id: "card-columns", kind: "widget", widget: "collection.card-columns" },
					{ id: "row-formatting", kind: "widget", widget: "tasks.row-formatting" },
					{ id: "display-spacer", kind: "spacer" },
					{ id: "configure", kind: "widget", widget: "collection.configure" },
				],
			},
		],
	},
	bugs: {
		id: "bugs",
		rows: [
			{
				id: "primary",
				label: "Bug controls",
				size: "large",
				items: [
					{ id: "search", kind: "widget", widget: "sheet.search" },
					{ id: "result-count", kind: "widget", widget: "sheet.result-count" },
					{ id: "insights-divider", kind: "divider" },
					{ id: "insights", kind: "widget", widget: "sheet.insights" },
					{ id: "tag-filters", kind: "widget", widget: "bugs.tag-filters" },
					{ id: "primary-spacer", kind: "spacer" },
					{ id: "refresh", kind: "widget", widget: "sheet.refresh" },
					{ id: "create", kind: "widget", widget: "sheet.create" },
				],
			},
			{
				id: "display",
				label: "Bug display controls",
				size: "small",
				items: [
					{ id: "view-label", kind: "label", text: "View" },
					{ id: "view-mode", kind: "widget", widget: "collection.view-mode" },
					{ id: "grid-density", kind: "widget", widget: "collection.grid-density" },
					{ id: "card-presentation", kind: "widget", widget: "collection.card-presentation" },
					{ id: "card-columns", kind: "widget", widget: "collection.card-columns" },
					{ id: "row-formatting", kind: "widget", widget: "bugs.row-formatting" },
					{ id: "display-spacer", kind: "spacer" },
					{ id: "configure", kind: "widget", widget: "collection.configure" },
				],
			},
		],
	},
	arms: {
		id: "arms",
		rows: [
			{
				id: "primary",
				label: "Arm fleet controls",
				size: "large",
				items: [
					{ id: "search", kind: "widget", widget: "arms.search" },
					{ id: "primary-spacer", kind: "spacer" },
					{ id: "telemetry", kind: "widget", widget: "arms.telemetry" },
					{ id: "actions-divider", kind: "divider" },
					{ id: "refresh", kind: "widget", widget: "arms.refresh" },
					{ id: "spawn", kind: "widget", widget: "arms.spawn" },
				],
			},
			{
				id: "display",
				label: "Arm display controls",
				size: "small",
				items: [
					{ id: "display-mode", kind: "widget", widget: "arms.display" },
					{ id: "display-spacer", kind: "spacer" },
					{ id: "result-count", kind: "widget", widget: "arms.result-count" },
					{ id: "scope", kind: "widget", widget: "arms.scope" },
				],
			},
		],
	},
	processes: {
		id: "processes",
		rows: [
			{
				id: "primary",
				label: "Process controls",
				size: "large",
				items: [
					{ id: "identity", kind: "widget", widget: "processes.identity" },
					{ id: "identity-divider", kind: "divider" },
					{ id: "status-filter", kind: "widget", widget: "processes.status-filter" },
					{ id: "primary-spacer", kind: "spacer" },
					{ id: "status-summary", kind: "widget", widget: "processes.status-summary" },
					{ id: "refresh", kind: "widget", widget: "processes.refresh" },
				],
			},
			{
				id: "display",
				label: "Process display controls",
				size: "small",
				items: [
					{ id: "display-label", kind: "label", text: "Display" },
					{ id: "view-mode", kind: "widget", widget: "collection.view-mode" },
					{ id: "grid-density", kind: "widget", widget: "collection.grid-density" },
					{ id: "card-presentation", kind: "widget", widget: "collection.card-presentation" },
					{ id: "card-columns", kind: "widget", widget: "collection.card-columns" },
				],
			},
		],
	},
	"arm-viewer": {
		id: "arm-viewer",
		rows: [
			{
				id: "primary",
				label: "Arm Viewer controls",
				size: "large",
				items: [
					{ id: "identity", kind: "widget", widget: "arm-viewer.identity" },
					{ id: "primary-spacer", kind: "spacer" },
					{ id: "overview", kind: "widget", widget: "arm-viewer.overview" },
					{ id: "mark-stuck", kind: "widget", widget: "arm-viewer.mark-stuck" },
					{ id: "help", kind: "widget", widget: "arm-viewer.help" },
					{ id: "refresh", kind: "widget", widget: "arm-viewer.refresh" },
					{ id: "actions", kind: "widget", widget: "arm-viewer.actions" },
				],
			},
			{
				id: "stream",
				label: "Arm activity stream controls",
				size: "small",
				items: [
					{ id: "stream-mode", kind: "widget", widget: "arm-viewer.stream-mode" },
					{ id: "stream-spacer", kind: "spacer" },
					{ id: "stream-preferences", kind: "widget", widget: "arm-viewer.stream-preferences" },
				],
			},
		],
	},
} satisfies ToolbarTemplateMap;

function collectWidgetIds(template: WorkbenchToolbarTemplate): readonly string[] {
	return [...new Set(template.rows.flatMap((row) =>
		row.items.flatMap((item) => item.kind === "widget" ? [item.widget] : []),
	))];
}

export const TOOLBAR_WIDGET_IDS: Record<ToolbarScreenId, readonly string[]> = {
	inbox: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.inbox),
	mail: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.mail),
	"plan-documents": collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES["plan-documents"]),
	tasks: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.tasks),
	bugs: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.bugs),
	arms: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.arms),
	processes: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.processes),
	"arm-viewer": collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES["arm-viewer"]),
};

export function resolveToolbarTemplates(rawOverrides: unknown): ToolbarTemplateMap {
	const templates: ToolbarTemplateMap = { ...DEFAULT_TOOLBAR_TEMPLATES };
	if (!isRecord(rawOverrides)) return templates;

	for (const screenId of TOOLBAR_SCREEN_IDS) {
		const candidate = rawOverrides[screenId];
		if (candidate === undefined) continue;
		try {
			templates[screenId] = parseToolbarTemplate(candidate, screenId, TOOLBAR_WIDGET_IDS[screenId]);
		} catch {
			// One malformed screen should not hide valid profile overrides for the others.
		}
	}
	return templates;
}
