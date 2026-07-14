import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	discoverProjectPlans,
	formatPlanWithoutModel,
	validateEditablePlanPath,
	validateEditableTemplatePath,
} from "../service";
import { LocalWorkspaceAccess } from "../../workspace";

describe("project setup service", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "coleo-project-setup-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("ranks likely plan files without treating ordinary docs as plans", async () => {
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(join(root, "docs", "roadmap.md"), "# Roadmap\n\n## Milestones\n- [ ] Ship authentication\n");
		await writeFile(join(root, "docs", "api.md"), "# API\n\nGET /health returns 200.\n");

		const candidates = await discoverProjectPlans(new LocalWorkspaceAccess(root));

		expect(candidates.map((candidate) => candidate.path)).toEqual(["docs/roadmap.md"]);
		expect(candidates[0]?.reasons).toContain("plan-like filename");
	});

	it("turns prose and bullets into the canonical task format without a model", () => {
		const plan = formatPlanWithoutModel(
			"# Product brief\n\n## Requirements\n- Support team accounts\n- Add an audit log\n",
			"docs/brief.md",
		);

		expect(plan).toContain("## Phase 1: Initial Project Work");
		expect(plan).toContain("### Deliverables");
		expect(plan).toContain("- [ ] Support team accounts");
		expect(plan).toContain("- [ ] Add an audit log");
	});

	it("only allows editable plan paths in the configured project directories", () => {
		expect(validateEditablePlanPath("docs/plan.md")).toBe("docs/plan.md");
		expect(() => validateEditablePlanPath("../secrets.txt")).toThrow();
		expect(() => validateEditablePlanPath("src/index.ts")).toThrow();
	});

	it("only allows YAML and legacy TOML Arm template paths", () => {
		expect(validateEditableTemplatePath(".coleo/templates/reviewer.yml")).toBe(".coleo/templates/reviewer.yml");
		expect(validateEditableTemplatePath(".coleo/arms/reviewer.toml")).toBe(".coleo/arms/reviewer.toml");
		expect(() => validateEditableTemplatePath(".coleo/templates/reviewer.md")).toThrow();
		expect(() => validateEditableTemplatePath("../templates/reviewer.yml")).toThrow();
	});
});
