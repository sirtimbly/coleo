import { isValidResourceTag } from "../../types/tag-validation";
import { HttpError } from "../middleware";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataTags(metadata: unknown): { present: boolean; value?: unknown } {
	let parsed = metadata;
	if (typeof metadata === "string") {
		try {
			parsed = JSON.parse(metadata);
		} catch {
			return { present: false };
		}
	}
	if (!isRecord(parsed) || !isRecord(parsed.ui) || parsed.ui.tags === undefined) {
		return { present: false };
	}
	return { present: true, value: parsed.ui.tags };
}

function sameTagValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function assertValidResourceMetadataTags(
	metadata: unknown,
	existingMetadata?: unknown,
): void {
	const incoming = metadataTags(metadata);
	if (!incoming.present) return;

	if (
		Array.isArray(incoming.value) &&
		incoming.value.every(isValidResourceTag)
	) {
		return;
	}

	const existing = metadataTags(existingMetadata);
	if (existing.present && sameTagValue(incoming.value, existing.value)) {
		return;
	}

	throw HttpError.badRequest(
		"metadata.ui.tags must contain only non-empty ASCII alphanumeric strings",
	);
}
