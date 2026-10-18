import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

/** Metadata required before prepared work can enter the execution queue. */
export const taskPreparationSchema = z.object({
	subject: nonEmptyString.describe("Clear title for the task"),
	description: nonEmptyString.describe("Detailed requirements for the task"),
	priority: z.enum(["low", "normal", "high"]).default("normal"),
	sourceRef: nonEmptyString.describe("Plan reference authorizing this task"),
	acceptanceCriteria: z.array(nonEmptyString).min(1).describe("Conditions defining completion"),
	dependencies: z.array(nonEmptyString).describe("Existing prerequisite task IDs; use [] when none"),
	context: nonEmptyString.describe("Implementation context and constraints"),
	outputs: z.array(nonEmptyString).min(1).describe("Files, artifacts, or results this task must produce"),
	discussion_id: nonEmptyString.optional(),
	related_plan_id: nonEmptyString.optional(),
	estimated_effort: nonEmptyString.optional(),
});

export const preparedTaskRequestSchema = taskPreparationSchema.extend({
	preparedBy: nonEmptyString,
});

export type TaskPreparation = z.infer<typeof taskPreparationSchema>;
export type PreparedTaskRequest = z.infer<typeof preparedTaskRequestSchema>;

export interface PreparedTaskResponse {
	task: { id: string; subject: string; status: "draft"; priority: string };
	handoff: { id: string; taskId: string; status: "queued" };
}
