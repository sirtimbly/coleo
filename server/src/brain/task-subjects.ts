export const VALIDATION_TASK_SUBJECT_PREFIX = "Validate completion:" as const;
export const VERIFICATION_TASK_SUBJECT_PREFIX = "Verify & Polish:" as const;
export const COMMIT_TASK_SUBJECT_PREFIX = "Commit changes for:" as const;
const COMMIT_TASK_SUBJECT_KEYWORD = /commit changes for/i;

function hasSubjectPrefix(subject: string | null | undefined, prefix: string): boolean {
	return typeof subject === "string" && subject.startsWith(prefix);
}

export function isValidationTaskSubject(subject: string | null | undefined): boolean {
	return hasSubjectPrefix(subject, VALIDATION_TASK_SUBJECT_PREFIX);
}

export function isVerificationTaskSubject(subject: string | null | undefined): boolean {
	return hasSubjectPrefix(subject, VERIFICATION_TASK_SUBJECT_PREFIX);
}

export function isCommitTaskSubject(subject: string | null | undefined): boolean {
	return hasSubjectPrefix(subject, COMMIT_TASK_SUBJECT_PREFIX);
}

export function containsCommitTaskKeyword(
	subject: string | null | undefined,
): boolean {
	return typeof subject === "string" && COMMIT_TASK_SUBJECT_KEYWORD.test(subject);
}

export function isFollowUpTaskSubject(subject: string | null | undefined): boolean {
	return (
		isValidationTaskSubject(subject) ||
		isVerificationTaskSubject(subject) ||
		isCommitTaskSubject(subject)
	);
}

export function buildValidationTaskSubject(subject: string): string {
	return `${VALIDATION_TASK_SUBJECT_PREFIX} ${subject}`;
}

export function buildVerificationTaskSubject(subject: string): string {
	return `${VERIFICATION_TASK_SUBJECT_PREFIX} ${subject}`;
}

export function buildCommitTaskSubject(subject: string): string {
	return `${COMMIT_TASK_SUBJECT_PREFIX} ${subject}`;
}
