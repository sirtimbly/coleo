import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	discoverProjectPlans,
	formatPlanWithoutModel,
	listProjectPlanDocuments,
	preservesPlanContext,
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

	it("lists all bounded .project documents with recent-change metadata", async () => {
		await mkdir(join(root, ".project", "decisions"), { recursive: true });
		await writeFile(join(root, ".project", "README.md"), "# Project\n");
		await writeFile(join(root, ".project", "decisions", "001-use-bun.md"), "# Decision\n");
		await utimes(join(root, ".project", "README.md"), new Date("2020-01-01"), new Date("2020-01-01"));
		await writeFile(join(root, ".project", "notes.json"), "{}");

		const documents = await listProjectPlanDocuments(new LocalWorkspaceAccess(root));

		expect(documents.map((document) => document.path)).toEqual([
			".project/decisions/001-use-bun.md",
			".project/README.md",
		]);
		expect(documents.find((document) => document.path === ".project/decisions/001-use-bun.md")?.recentlyChanged).toBe(true);
		expect(documents.find((document) => document.path === ".project/README.md")?.recentlyChanged).toBe(false);
	});

	it("preserves prose and adds checklist items without a model", () => {
		const source = "# Product brief\n\nThis context must remain in the plan.\n\n## Requirements\n- Support team accounts\n- Add an audit log\n";
		const plan = formatPlanWithoutModel(
			source,
			"docs/brief.md",
		);

		expect(plan).toContain("This context must remain in the plan.");
		expect(plan).toContain("## Phase 1: Initial Project Work");
		expect(plan).toContain("### Deliverables");
		expect(plan).toContain("- [ ] Support team accounts");
		expect(plan).toContain("- [ ] Add an audit log");
	});

	it("detects formatter output that drops substantial project context", () => {
		const source = "The billing workflow must retain audit history, support regional taxes, and explain migration constraints.";
		expect(preservesPlanContext(source, `${source}\n\n- [ ] Implement billing`)).toBe(true);
		expect(preservesPlanContext(source, "- [ ] Implement billing")).toBe(false);
	});

	it("only allows editable plan paths in the configured project directories", () => {
		expect(validateEditablePlanPath("docs/plan.md")).toBe("docs/plan.md");
		expect(() => validateEditablePlanPath("../secrets.txt")).toThrow();
		expect(() => validateEditablePlanPath("src/index.ts")).toThrow();
	});

	it("only allows Arm templates and Brain prompt template paths", () => {
		expect(validateEditableTemplatePath(".coleo/templates/reviewer.yml")).toBe(".coleo/templates/reviewer.yml");
		expect(validateEditableTemplatePath(".coleo/arms/reviewer.toml")).toBe(".coleo/arms/reviewer.toml");
		expect(validateEditableTemplatePath(".coleo/src/brain/templates/initial-arm-prompt.jinja"))
			.toBe(".coleo/src/brain/templates/initial-arm-prompt.jinja");
		expect(() => validateEditableTemplatePath(".coleo/templates/reviewer.md")).toThrow();
		expect(() => validateEditableTemplatePath("../templates/reviewer.yml")).toThrow();
	});
});
