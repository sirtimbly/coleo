import { z } from "zod";

export const taskClassificationSchema = z.enum([
	"architect",
	"development",
	"qa",
	"documentation",
]);

export const acceptanceCriterionSchema = z.object({
	id: z.string().min(1),
	statement: z.string().min(1),
	measurable: z.boolean(),
	required: z.boolean(),
});

export const evidenceSchema = z.object({
	kind: z.enum(["test", "inspection", "runtime", "api", "human", "recommendation"]),
	summary: z.string().min(1),
	source: z.string().min(1),
	capturedAt: z.string().datetime(),
	authority: z.enum(["api", "repository", "test", "human", "agent"]),
});

export const provenanceSchema = z.object({
	sourceType: z.enum(["plan", "task", "repository", "api", "human", "derived"]),
	sourceRef: z.string().min(1),
	sourceRevision: z.string().min(1).nullable(),
	authoritative: z.boolean(),
});

export const discoverySchema = z.object({
	title: z.string().min(1),
	details: z.string().min(1),
	severity: z.enum(["info", "warning", "error"]),
	status: z.enum(["open", "resolved", "dismissed"]),
	provenance: provenanceSchema,
});

export const commonOutputSchema = z.object({
	schemaVersion: z.literal("1.0"),
	classification: taskClassificationSchema,
	acceptanceCriteria: z.array(acceptanceCriterionSchema),
	evidence: z.array(evidenceSchema),
	discoveries: z.array(discoverySchema),
	provenance: provenanceSchema,
});

const artifactSchema = z.object({
	path: z.string().min(1),
	description: z.string().min(1),
	generated: z.boolean(),
});

export const architectOutputSchema = commonOutputSchema.extend({
	classification: z.literal("architect"),
	requirements: z.array(z.string().min(1)),
	assumptions: z.array(z.string().min(1)),
	decisions: z.array(z.string().min(1)),
	plan: z.array(z.string().min(1)),
	tasks: z.array(z.string().min(1)),
});

export const developmentOutputSchema = commonOutputSchema.extend({
	classification: z.literal("development"),
	artifacts: z.array(artifactSchema),
	verification: z.array(evidenceSchema),
});

export const qaOutputSchema = commonOutputSchema.extend({
	classification: z.literal("qa"),
	tests: z.array(z.string().min(1)),
	results: z.array(evidenceSchema),
	defects: z.array(z.string().min(1)),
	documentationVerified: z.boolean(),
});

export const documentationOutputSchema = commonOutputSchema.extend({
	classification: z.literal("documentation"),
	artifacts: z.array(artifactSchema),
	featureDocs: z.array(z.string().min(1)),
	futureWork: z.array(z.string().min(1)),
});

export const classificationOutputSchema = z.discriminatedUnion("classification", [
	architectOutputSchema,
	developmentOutputSchema,
	qaOutputSchema,
	documentationOutputSchema,
]);

export type TaskClassification = z.infer<typeof taskClassificationSchema>;
export type ClassificationOutput = z.infer<typeof classificationOutputSchema>;
