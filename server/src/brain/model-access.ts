export const OPENAI_BILLING_URL =
	"https://platform.openai.com/settings/organization/billing/";

export type BrainModelAccessIssueCode = "insufficient_credits";

export interface BrainModelAccessIssue {
	code: BrainModelAccessIssueCode;
	provider: string;
	message: string;
	actionLabel: string;
	actionUrl: string;
}

const INSUFFICIENT_CREDITS_PATTERNS = [
	/\bno credits remaining\b/i,
	/\binsufficient[_\s-]*(?:credits|quota)\b/i,
	/\b(?:add|purchase) credits\b/i,
	/\bbilling quota\b/i,
];

export function detectBrainModelAccessIssue(
	status: number,
	responseBody: string,
	provider: string,
): BrainModelAccessIssue | null {
	if (status !== 429 || !INSUFFICIENT_CREDITS_PATTERNS.some((pattern) => pattern.test(responseBody))) {
		return null;
	}

	return {
		code: "insufficient_credits",
		provider,
		message:
			"The Brain model account is out of API credits. Plan evaluation and other AI planning are blocked until credits are added.",
		actionLabel: provider === "openai" ? "Add OpenAI API credits" : "Add API credits",
		actionUrl: provider === "openai" ? OPENAI_BILLING_URL : "",
	};
}

export class BrainModelAccessError extends Error {
	readonly issue: BrainModelAccessIssue;

	constructor(issue: BrainModelAccessIssue) {
		const action = issue.actionUrl ? ` ${issue.actionLabel}: ${issue.actionUrl}` : "";
		super(`${issue.message}${action}`);
		this.name = "BrainModelAccessError";
		this.issue = issue;
	}
}

export function getBrainModelAccessIssue(error: unknown): BrainModelAccessIssue | null {
	return error instanceof BrainModelAccessError ? error.issue : null;
}

export function serializeBrainModelAccessIssue(
	issue: BrainModelAccessIssue,
): string {
	return JSON.stringify(issue);
}

export function parseBrainModelAccessIssue(
	value: string | null | undefined,
): BrainModelAccessIssue | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Partial<BrainModelAccessIssue>;
		if (
			parsed.code !== "insufficient_credits"
			|| typeof parsed.provider !== "string"
			|| typeof parsed.message !== "string"
			|| typeof parsed.actionLabel !== "string"
			|| typeof parsed.actionUrl !== "string"
		) {
			return null;
		}
		return parsed as BrainModelAccessIssue;
	} catch {
		return null;
	}
}
