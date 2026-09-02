import { isValidResourceTag } from "../../types/tag-validation";
import { HttpError } from "../middleware";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertValidResourceMetadataTags(metadata: unknown): void {
	if (!isRecord(metadata) || !isRecord(metadata.ui) || metadata.ui.tags === undefined) {
		return;
	}

	if (
		!Array.isArray(metadata.ui.tags) ||
		!metadata.ui.tags.every(isValidResourceTag)
	) {
		throw HttpError.badRequest(
			"metadata.ui.tags must contain only non-empty ASCII alphanumeric strings",
		);
	}
}
