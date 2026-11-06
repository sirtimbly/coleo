import { z } from "zod";

import { HttpError } from "../middleware";

export const WORKBENCH_VIEW_KINDS = [
	"sheet", "inbox", "timeline", "conversation", "process", "document", "dashboard", "inspector",
] as const;

const identifier = z.string().trim().min(1);
const object = z.record(z.string(), z.unknown());
const optionalText = z.string().trim().nullish();
const version = z.number().int().positive().default(1);
const importSchema = z.object({
	mode: z.enum(["copy", "replace"]).default("replace"),
	bundle: z.object({
		schemaVersion: z.literal(1),
		profile: z.object({
			id: identifier,
			name: identifier,
			email: optionalText,
			preferences: object,
		}),
		// Missing collections must not silently mean "delete all saved state".
		views: z.array(z.object({
			id: identifier,
			key: identifier.optional(),
			name: identifier,
			description: optionalText,
			kind: z.enum(WORKBENCH_VIEW_KINDS),
			resourceKind: optionalText,
			query: object,
			preferences: object,
			shared: z.boolean().default(false),
			version,
		})),
		layouts: z.array(z.object({
			id: identifier,
			name: identifier,
			description: optionalText,
			layout: object,
			isDefault: z.boolean().default(false),
			shared: z.boolean().default(false),
			version,
		})),
	}),
});

type WorkbenchImport = z.infer<typeof importSchema>;

/** Validate the complete portable bundle before any replacement writes occur. */
export function parseWorkbenchImport(input: unknown): WorkbenchImport {
	const result = importSchema.safeParse(input);
	if (!result.success) {
		throw HttpError.badRequest(`Invalid workbench import: ${result.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
	}
	const { views, layouts } = result.data.bundle;
	for (const [field, values] of [
		["view IDs", views.map((view) => view.id)],
		["view keys", views.map((view) => view.key ?? view.id)],
		["layout IDs", layouts.map((layout) => layout.id)],
	] as const) {
		if (new Set(values).size !== values.length) {
			throw HttpError.badRequest(`Invalid workbench import: duplicate ${field}`);
		}
	}
	return result.data;
}
