/**
 * Shared tag value adapters for Tabulator-backed resource projections.
 *
 * The custom MultiSelect editor reads and writes arrays, while paste and
 * legacy callers can still supply comma-delimited text. These helpers keep
 * Tasks and Bugs on one normalization and option-ordering contract.
 */

export function normalizeTagValues(value: unknown): string[] {
	const values = Array.isArray(value)
		? value
		: String(value ?? "").split(",");

	return Array.from(new Set(
		values
			.filter((tag): tag is string => typeof tag === "string")
			.map((tag) => tag.trim())
			.filter(Boolean),
	));
}

export function collectTagOptions(rows: readonly string[][]): string[] {
	return Array.from(new Set(rows.flatMap((tags) => normalizeTagValues(tags))))
		.sort((left, right) => left.localeCompare(right));
}
