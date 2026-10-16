/** Compatibility entry point; the recipe is shared with API and terminal consumers. */
export { BRAIN_ACTIVITY_CATEGORY_LABELS, formatBrainActivity, mergeBrainActivity, parseBrainActivityEntry }
	from "../../../../server/src/workbench/brain-activity";
export type { BrainActivityCategory, BrainActivityTone, BrainActivityItem } from "../../../../server/src/workbench/brain-activity";
