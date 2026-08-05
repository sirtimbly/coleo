import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	discoverProjectPlans,
	collectPlanWorkspaceContext,
	formatPlanWithConfiguredModel,
	formatPlanWithoutModel,
	listProjectPlanDocuments,
	preservesPlanContext,
	renderPlanEvaluationPrompt,
	validateEditablePlanPath,
	validateEditableTemplatePath,
} from "../service";
import { LocalWorkspaceAccess } from "../../workspace";
import { BrainTemplateManager } from "../../brain/template-manager";
import type { WorkspaceAccess } from "../../workspace";

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

	it("includes the provider error detail when model formatting falls back", async () => {
		const templateDir = join(root, "src", "brain", "templates");
		await mkdir(templateDir, { recursive: true });
		await writeFile(join(templateDir, "plan-evaluation-system-prompt.jinja"), "Format the plan");
		await writeFile(join(templateDir, "plan-evaluation-user-prompt.jinja"), "{{ project_plan }}");
		const originalFetch = globalThis.fetch;
		const originalApiKey = process.env.COLEO_BRAIN_API_KEY;
		const originalBaseUrl = process.env.OPENAI_BASE_URL;
		process.env.COLEO_BRAIN_API_KEY = "test-key";
		process.env.OPENAI_BASE_URL = "https://formatter.test/v1";
		globalThis.fetch = (async () => new Response(
			JSON.stringify({ error: { message: "Model capacity exhausted for this request" } }),
			{ status: 500, statusText: "Internal Server Error" },
		)) as unknown as typeof fetch;

		try {
			const result = await formatPlanWithConfiguredModel(
				"# Product brief\n\nShip team accounts.\n",
				".project/plan.md",
				undefined,
				{ gitStatus: "", files: [] },
				new BrainTemplateManager(root, () => {}),
			);

			expect(result.mode).toBe("structured");
			expect(result.formatterError).toBe(
				"Plan formatter returned 500 Internal Server Error: Model capacity exhausted for this request",
			);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalApiKey === undefined) delete process.env.COLEO_BRAIN_API_KEY;
			else process.env.COLEO_BRAIN_API_KEY = originalApiKey;
			if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
			else process.env.OPENAI_BASE_URL = originalBaseUrl;
		}
	});

	it("builds bounded planning context from git metadata without reading file contents", async () => {
		let readCount = 0;
		const workspace = {
			root,
			readText: async () => {
				readCount += 1;
				return null;
			},
			writeText: async () => {
				throw new Error("not used");
			},
			scan: async () => {
				throw new Error("not used");
			},
			gitStatus: async () => " M src/app.ts\n?? package.json\n?? node_modules/cache.bin\n?? a/b/c/d/e/f/g.ts\n",
			gitFiles: async () => ["src/index.ts", "dist/output.js"],
		} satisfies WorkspaceAccess;

		const context = await collectPlanWorkspaceContext(workspace);

		expect(context.gitStatus).toContain("?? package.json");
		expect(context.files).toEqual(["package.json", "src/app.ts", "src/index.ts"]);
		expect(readCount).toBe(0);
	});

	it("renders plan evaluation messages from user-customizable Jinja templates", async () => {
		const templateDir = join(root, "src", "brain", "templates");
		await mkdir(templateDir, { recursive: true });
		await writeFile(
			join(templateDir, "plan-evaluation-system-prompt.jinja"),
			"Custom planning policy",
		);
		await writeFile(
			join(templateDir, "plan-evaluation-user-prompt.jinja"),
			"{{ source_path }}|{{ git_status }}|{{ project_files }}|{{ project_plan }}",
		);

		const prompt = await renderPlanEvaluationPrompt(
			new BrainTemplateManager(root, () => {}),
			"# Complete plan",
			".project/plan.md",
			undefined,
			{ gitStatus: " M src/app.ts", files: ["package.json", "src/app.ts"] },
		);

		expect(prompt.system).toBe("Custom planning policy");
		expect(prompt.user).toBe(
			".project/plan.md| M src/app.ts|package.json\nsrc/app.ts|# Complete plan",
		);
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
