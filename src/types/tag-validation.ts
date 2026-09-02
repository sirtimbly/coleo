/**
 * User-created resource tags are deliberately conservative so they can be
 * passed through query strings, metadata, and spreadsheet editors without
 * ambiguous separators or Unicode normalization differences.
 */

const ASCII_ALPHANUMERIC_TAG = /^[A-Za-z0-9]+$/;

export function isValidResourceTag(value: unknown): value is string {
	return typeof value === "string" && ASCII_ALPHANUMERIC_TAG.test(value);
}
