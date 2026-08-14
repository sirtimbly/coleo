import type {
	ToolbarScreenId,
	WorkbenchToolbarTemplate,
} from "@/design-system/toolbar-template";

export const TOOLBAR_SCREEN_IDS = [
	"inbox",
	"plan-documents",
	"tasks",
	"bugs",
	"arms",
	"processes",
	"arm-viewer",
] as const satisfies readonly ToolbarScreenId[];

export const TOOLBAR_SCREEN_LABELS: Record<ToolbarScreenId, string> = {
	inbox: "Inbox",
	"plan-documents": "Plan & Documents",
	tasks: "Tasks",
	bugs: "Bugs",
	arms: "Arms",
	processes: "Processes",
	"arm-viewer": "Arm Viewer",
};

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
} satisfies Record<ToolbarScreenId, WorkbenchToolbarTemplate>;

function collectWidgetIds(template: WorkbenchToolbarTemplate): readonly string[] {
	return [...new Set(template.rows.flatMap((row) =>
		row.items.flatMap((item) => item.kind === "widget" ? [item.widget] : []),
	))];
}

export const TOOLBAR_WIDGET_IDS: Record<ToolbarScreenId, readonly string[]> = {
	inbox: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.inbox),
	"plan-documents": collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES["plan-documents"]),
	tasks: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.tasks),
	bugs: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.bugs),
	arms: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.arms),
	processes: collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES.processes),
	"arm-viewer": collectWidgetIds(DEFAULT_TOOLBAR_TEMPLATES["arm-viewer"]),
};
