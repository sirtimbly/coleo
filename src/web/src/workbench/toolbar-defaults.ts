import type { ToolbarScreenId } from "@/design-system/toolbar-template";

export {
	DEFAULT_TOOLBAR_TEMPLATES,
	TOOLBAR_SCREEN_IDS,
	TOOLBAR_WIDGET_IDS,
} from "../../../workbench/toolbar-templates";

export const TOOLBAR_SCREEN_LABELS: Record<ToolbarScreenId, string> = {
	inbox: "Inbox",
	mail: "Mail",
	"plan-documents": "Plan & Documents",
	tasks: "Tasks",
	bugs: "Bugs",
	arms: "Arms",
	processes: "Processes",
	"arm-viewer": "Arm Viewer",
};
