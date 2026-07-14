import type { WorkspaceAccess, WorkspaceTextFile } from "../workspace";

export const CANONICAL_PLAN_PATH = ".project/plan.md";
export const DEFAULT_ARM_TEMPLATE = `arm:
  name: new-arm
  domain: general
  harness: opencode-api

context:
  budget: 100000

personality:
  traits: Thoughtful, practical, and curious.
`;
export const DEFAULT_PLAN_TEMPLATE = `# Project Plan

Describe what you want to build, who it is for, and the important constraints. You can write prose or a checklist; Coleo will turn it into a structured plan before creating tasks.

## Goals

-

## Requirements

-
`;

const PLAN_PATTERNS = [
	".project/**/*.md",
	".coleo/**/*.{md,markdown,txt}",
	".plans/**/*.{md,markdown,txt}",
	"plans/**/*.{md,markdown,txt}",
	"planning/**/*.{md,markdown,txt}",
	"docs/**/*.{md,markdown,txt}",
	"documentation/**/*.{md,markdown,txt}",
	"*{plan,Plan,PLAN,roadmap,Roadmap,ROADMAP,requirements,Requirements,REQUIREMENTS,spec,Spec,SPEC}*.{md,markdown,txt}",
];

const EDITABLE_PLAN_PATH = /^(?:\.project|\.coleo|\.plans|plans|planning|docs|documentation)\/(?:[^/]+\/)*[^/]+\.(?:md|markdown|txt)$/i;
const ROOT_PLAN_PATH = /^[^/]*(?:plan|roadmap|requirements|spec)[^/]*\.(?:md|markdown|txt)$/i;
const MAX_CANDIDATE_BYTES = 512 * 1024;

export interface ProjectPlanCandidate {
	path: string;
	content: string;
	contentHash: string;
	size: number;
	modifiedAt: string;
	score: number;
	reasons: string[];
}

export interface PlanFormatterResult {
	content: string;
	mode: "ai" | "structured";
}

export type PlanFormatter = (
	content: string,
	sourcePath: string,
) => Promise<PlanFormatterResult>;

export function hasStructuredPlanTasks(content: string): boolean {
	return /^##\s+Phase\s+\d/im.test(content)
		&& /^###\s+(?:Deliverables|Tasks)\s*$/im.test(content)
		&& /^-\s+\[[ xX]\]\s+\S+/m.test(content);
}

export function validateEditablePlanPath(path: string): string {
	const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
		throw new Error("Choose a plan file inside the project workspace");
	}
	if (!EDITABLE_PLAN_PATH.test(normalized) && !ROOT_PLAN_PATH.test(normalized)) {
		throw new Error("Plan files must be Markdown or text in .project, .coleo, .plans, plans, planning, docs, or documentation");
	}
	return normalized;
}

export function validateEditableTemplatePath(path: string): string {
	const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
		throw new Error("Choose a template file inside the Coleo configuration directory");
	}
	if (!/^\.coleo\/templates\/[^/]+\.ya?ml$/i.test(normalized)
		&& !/^\.coleo\/arms\/[^/]+\.toml$/i.test(normalized)
		&& !/^\.coleo\/src\/brain\/templates\/[^/]+\.jinja$/i.test(normalized)) {
		throw new Error("Templates must be Arm YAML in .coleo/templates, legacy TOML in .coleo/arms, or Brain Jinja prompts in .coleo/src/brain/templates");
	}
	return normalized;
}

function candidateScore(file: WorkspaceTextFile): { score: number; reasons: string[] } {
	const path = file.path.toLowerCase();
	const name = path.split("/").at(-1) || path;
	const sample = file.content.slice(0, 100_000);
	const reasons: string[] = [];
	let score = 0;

	if (file.path === CANONICAL_PLAN_PATH) {
		score += 100;
		reasons.push("Coleo project plan");
	}
	if (/plan|roadmap|requirements|spec|brief|proposal/.test(name)) {
		score += 35;
		reasons.push("plan-like filename");
	}
	if (/^(?:\.project|\.coleo|\.plans|plans|planning)\//.test(path)) {
		score += 20;
		reasons.push("planning directory");
	} else if (/^(?:docs|documentation)\//.test(path)) {
		score += 8;
		reasons.push("documentation directory");
	}
	if (/^#{1,3}\s+(?:project\s+)?(?:plan|roadmap|requirements|goals|milestones|implementation)/im.test(sample)) {
		score += 25;
		reasons.push("planning headings");
	}
	if (/^-\s+\[[ xX]\]\s+/m.test(sample)) {
		score += 20;
		reasons.push("task checklist");
	}
	if (/\b(?:milestone|deliverable|scope|objective|phase\s+\d|acceptance criteria)\b/i.test(sample)) {
		score += 12;
		reasons.push("planning language");
	}

	return { score, reasons };
}

export async function discoverProjectPlans(workspace: WorkspaceAccess): Promise<ProjectPlanCandidate[]> {
	const metadataByPath = new Map<string, Awaited<ReturnType<WorkspaceAccess["scan"]>>[number]>();
	const scanResults = await Promise.all(PLAN_PATTERNS.map(async (pattern) => {
		try {
			return await workspace.scan([pattern], {
				ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**", "**/vendor/**"],
				maxFiles: 500,
			});
		} catch {
			// One very broad directory should not hide candidates from the other
			// conventional locations. Oversized scans are skipped independently.
			return [];
		}
	}));
	for (const matches of scanResults) {
		for (const match of matches) metadataByPath.set(match.path, match);
	}
	const candidates: ProjectPlanCandidate[] = [];

	for (const entry of metadataByPath.values()) {
		if (entry.size > MAX_CANDIDATE_BYTES) continue;
		const file = await workspace.readText(entry.path);
		if (!file || !file.content.trim()) continue;
		const scored = candidateScore(file);
		if (scored.score < 20) continue;
		candidates.push({
			path: file.path,
			content: file.content,
			contentHash: file.contentHash,
			size: file.size,
			modifiedAt: file.modifiedAt,
			score: scored.score,
			reasons: scored.reasons,
		});
	}

	return candidates
		.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
		.slice(0, 20);
}

function cleanTaskText(value: string): string {
	return value
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^\[[ xX]\]\s+/, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 180);
}

export function formatPlanWithoutModel(content: string, sourcePath: string): string {
	if (hasStructuredPlanTasks(content)) {
		return content.trimEnd() + "\n";
	}

	const lines = content.split(/\r?\n/);
	const tasks: string[] = [];
	const sectionHeadings: string[] = [];
	for (const line of lines) {
		const heading = line.match(/^#{2,4}\s+(.+)/)?.[1]?.trim();
		if (heading && !/^(?:goals?|overview|background|context)$/i.test(heading)) {
			sectionHeadings.push(heading);
		}
		if (/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/.test(line)) {
			const task = cleanTaskText(line.trim());
			if (task && !tasks.includes(task)) tasks.push(task);
		}
	}

	if (tasks.length === 0) {
		for (const heading of sectionHeadings) {
			const task = cleanTaskText(heading);
			if (task && !tasks.includes(task)) tasks.push(task);
		}
	}

	if (tasks.length === 0) {
		const paragraphs = content
			.split(/\n\s*\n/)
			.map((paragraph) => cleanTaskText(paragraph.replace(/^#+\s*/, "")))
			.filter((paragraph) => paragraph.length >= 12);
		tasks.push(...paragraphs.slice(0, 12));
	}

	if (tasks.length === 0) {
		throw new Error("Add at least one goal, requirement, heading, or checklist item before creating tasks");
	}

	return `# Project Plan

> Prepared from \`${sourcePath}\` during Coleo project setup.

## Phase 1: Initial Project Work

### Deliverables

${tasks.slice(0, 50).map((task) => `- [ ] ${task}`).join("\n")}
`;
}

function stripMarkdownFence(value: string): string {
	return value.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim();
}

export async function formatPlanWithConfiguredModel(
	content: string,
	sourcePath: string,
): Promise<PlanFormatterResult> {
	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) {
		return { content: formatPlanWithoutModel(content, sourcePath), mode: "structured" };
	}

	const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
	const model = process.env.OPENAI_MODEL || "gpt-5-mini";
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{
						role: "system",
						content: "Convert the user's project notes into an actionable Markdown project plan. Preserve requirements and constraints. Use one or more '## Phase N: Name' sections, each with a '### Deliverables' subsection containing '- [ ] Task' checklist items. Return Markdown only. Do not add work that is not supported by the source.",
					},
					{
						role: "user",
						content: `Source file: ${sourcePath}\n\n${content}`,
					},
				],
				max_completion_tokens: 4_000,
			}),
		});
		if (!response.ok) throw new Error(`Plan formatter returned ${response.status}`);
		const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
		const formatted = stripMarkdownFence(body.choices?.[0]?.message?.content || "");
		if (!formatted) throw new Error("Plan formatter returned an empty plan");
		if (!hasStructuredPlanTasks(formatted)) {
			throw new Error("Plan formatter returned an unsupported plan structure");
		}
		return { content: formatted.trimEnd() + "\n", mode: "ai" };
	} catch {
		return { content: formatPlanWithoutModel(content, sourcePath), mode: "structured" };
	}
}
