import { describe, expect, it } from "bun:test";
import {
	classificationOutputSchema,
	developmentOutputSchema,
	qaOutputSchema,
} from "../classification-schemas";

const provenance = {
	sourceType: "task" as const,
	sourceRef: "task-1",
	sourceRevision: null,
	authoritative: false,
};
const evidence = {
	kind: "test" as const,
	summary: "Unit tests passed",
	source: "bun test",
	capturedAt: "2026-09-23T00:00:00.000Z",
	authority: "test" as const,
};
const common = {
	schemaVersion: "1.0" as const,
	acceptanceCriteria: [{ id: "a1", statement: "Works", measurable: true, required: true }],
	evidence: [evidence],
	discoveries: [],
	provenance,
};

describe("classification output schemas", () => {
	it("requires development artifacts and verification", () => {
		expect(developmentOutputSchema.safeParse({ ...common, classification: "development", artifacts: [], verification: [evidence] }).success).toBe(true);
		expect(developmentOutputSchema.safeParse({ ...common, classification: "development", artifacts: [] }).success).toBe(false);
	});

	it("requires QA results and documentation verification", () => {
		const result = qaOutputSchema.safeParse({
			...common,
			classification: "qa",
			tests: ["unit"],
			results: [evidence],
			defects: [],
			documentationVerified: true,
		});
		expect(result.success).toBe(true);
	});

	it("rejects a mismatched discriminated classification", () => {
		const result = classificationOutputSchema.safeParse({
			...common,
			classification: "development",
			requirements: [],
			assumptions: [],
			decisions: [],
			plan: [],
			tasks: [],
		});
		expect(result.success).toBe(false);
	});
});
