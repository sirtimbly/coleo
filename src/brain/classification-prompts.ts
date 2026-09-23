/**
 * Task-scoped prompt contracts. Classification changes how the current task
 * is approached; it never assigns a permanent domain or specialization to an arm.
 */
export const CLASSIFICATION_PROMPT_VERSION = "1";

const COMMON = `
## Classification Contract (v${CLASSIFICATION_PROMPT_VERSION})
- This classification applies only to the current task; remain a general-purpose arm.
- Do not invent missing requirements or context. Record assumptions and unresolved questions as discoveries.
- Do not perform external side effects or broaden the change beyond the task without explicit authorization.
- Redact secrets from reports and include concrete verification evidence in the final status.`;

export const CLASSIFICATION_PROMPT_TEMPLATES: Readonly<Record<string, string>> = {
	architect: `${COMMON}

## Architect-Specific
- Translate requirements and discoveries into a dependency-ordered plan and actionable tasks.
- Identify affected files, decisions, risks, acceptance criteria, and prerequisites.
- Produce a plan/task proposal and explain unresolved decisions; do not implement product code unless explicitly requested.`,
	development: `${COMMON}

## Development-Specific
- Implement the requested behavior using the existing architecture and smallest safe change.
- Preserve public contracts, add or update focused tests, and report discoveries or follow-up work.
- Verify the implementation with relevant tests, type checks, and runtime checks where applicable.`,
	qa: `${COMMON}

## QA-Specific
- Verify the stated behavior against acceptance criteria and neighboring regression risks.
- Add maintainable tests for happy paths, boundaries, failure paths, and authorization where relevant.
- Report reproducible failures with expected versus actual behavior; do not silently change product behavior to make tests pass.`,
	documentation: `${COMMON}

## Documentation-Specific
- Update feature, API, and capability documentation to match the implementation.
- Do not update conceptual or architectural docs unless explicitly requested.
- Add a Future Work note for planned but unimplemented behavior and verify links/examples.`,
	verify: `${COMMON}

## Verification-Specific
- Review the existing implementation and artifacts against each acceptance criterion.
- Prefer evidence from focused tests, runtime checks, and source inspection; report gaps and blockers clearly.
- Do not certify unresolved lifecycle or security conflicts.`,
	bug_fix: `${COMMON}

## Bug-Fix-Specific
- Reproduce the reported failure, isolate its root cause, and make the narrowest corrective change.
- Add a regression test and verify that the fix does not weaken validation, authorization, or lifecycle gates.
- Track the bug through its investigation and verification statuses.`,
	default: `${COMMON}

## Task-Specific
- Follow the task description and acceptance criteria, inspect existing patterns, and verify the result.
- Surface missing context, assumptions, blockers, and useful follow-up work rather than guessing.`,
};

export function getClassificationPrompt(classification: string | null | undefined): string {
	const normalized = classification?.trim().toLowerCase() || "default";
	return CLASSIFICATION_PROMPT_TEMPLATES[normalized] || CLASSIFICATION_PROMPT_TEMPLATES.default!;
}
