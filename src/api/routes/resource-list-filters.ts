import { HttpError } from "../middleware";

const FILTER_OPERATORS = new Set([
	"equals",
	"notEquals",
	"contains",
	"in",
	"notIn",
	"before",
	"after",
	"exists",
]);

export interface ResourceListFilter {
	field: string;
	operator: string;
	value?: unknown;
}

export interface ResourceListFilterSql {
	conditions: string[];
	params: Array<string | number>;
}

export type ResourceListFilterReaders<T> = Readonly<
	Record<string, (resource: T) => unknown>
>;

export function parseResourceListFilters(value: string | undefined): ResourceListFilter[] {
	if (!value) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw HttpError.badRequest("viewFilters must be valid JSON");
	}
	if (!Array.isArray(parsed) || parsed.length > 20) {
		throw HttpError.badRequest("viewFilters must be an array with at most 20 filters");
	}
	return parsed.map((item) => {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof (item as ResourceListFilter).field !== "string" ||
			typeof (item as ResourceListFilter).operator !== "string" ||
			!FILTER_OPERATORS.has((item as ResourceListFilter).operator)
		) {
			throw HttpError.badRequest("viewFilters contains an invalid filter");
		}
		return item as ResourceListFilter;
	});
}

function comparableValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value).toLocaleLowerCase();
	return String(value).toLocaleLowerCase();
}

function expectedValues(value: unknown): string[] {
	return Array.isArray(value)
		? value.map(comparableValue)
		: comparableValue(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function hasNonAsciiValue(value: unknown): boolean {
	return /[^\x00-\x7f]/.test(
		typeof value === "object" && value !== null
			? JSON.stringify(value)
			: String(value ?? ""),
	);
}

/**
 * SQLite's built-in lower() only guarantees ASCII case folding. Keep the
 * indexed/common SQL path for ASCII input, but route filters containing
 * non-ASCII text through the equivalent JavaScript matcher.
 */
export function needsUnicodeResourceListFallback(
	search: string | undefined,
	filters: readonly ResourceListFilter[],
): boolean {
	return hasNonAsciiValue(search) || filters.some((filter) =>
		filter.operator !== "before" &&
		filter.operator !== "after" &&
		filter.operator !== "exists" &&
		hasNonAsciiValue(filter.value)
	);
}

export function matchesResourceSearch(
	search: string,
	values: readonly unknown[],
): boolean {
	const expected = comparableValue(search);
	return values.some((value) => comparableValue(value).includes(expected));
}

export function matchesResourceListFilters<T>(
	resource: T,
	filters: readonly ResourceListFilter[],
	readers: ResourceListFilterReaders<T>,
): boolean {
	return filters.every((filter) => {
		const read = readers[filter.field];
		if (!read) return true;
		const rawValue = read(resource);
		const actual = comparableValue(rawValue);
		const expected = comparableValue(filter.value);
		const values = expectedValues(filter.value);

		switch (filter.operator) {
			case "equals":
				return actual === expected;
			case "notEquals":
				return actual !== expected;
			case "contains":
				return actual.includes(expected);
			case "in":
				return values.includes(actual);
			case "notIn":
				return !values.includes(actual);
			case "before":
				return new Date(actual).getTime() < new Date(expected).getTime();
			case "after":
				return new Date(actual).getTime() > new Date(expected).getTime();
			case "exists":
				return rawValue !== null && rawValue !== undefined && actual.length > 0;
			default:
				return true;
		}
	});
}

export function compileResourceListFilters(
	filters: readonly ResourceListFilter[],
	fields: Readonly<Record<string, string>>,
): ResourceListFilterSql {
	const conditions: string[] = [];
	const params: Array<string | number> = [];
	for (const filter of filters) {
		const expression = fields[filter.field];
		if (!expression) continue;
		const comparableExpression = `lower(coalesce(cast(${expression} AS text), ''))`;
		switch (filter.operator) {
			case "equals":
				conditions.push(`${comparableExpression} = ?`);
				params.push(comparableValue(filter.value));
				break;
			case "notEquals":
				conditions.push(`${comparableExpression} != ?`);
				params.push(comparableValue(filter.value));
				break;
			case "contains":
				conditions.push(`instr(${comparableExpression}, ?) > 0`);
				params.push(comparableValue(filter.value));
				break;
			case "in":
			case "notIn": {
				const values = expectedValues(filter.value);
				if (values.length === 0) {
					conditions.push(filter.operator === "in" ? "0" : "1");
					break;
				}
				conditions.push(
					`${comparableExpression} ${filter.operator === "in" ? "IN" : "NOT IN"} (${values.map(() => "?").join(",")})`,
				);
				params.push(...values);
				break;
			}
			case "before":
			case "after":
				conditions.push(`julianday(${expression}) ${filter.operator === "before" ? "<" : ">"} julianday(?)`);
				params.push(comparableValue(filter.value));
				break;
			case "exists":
				conditions.push(`${expression} IS NOT NULL AND length(cast(${expression} AS text)) > 0`);
				break;
		}
	}
	return { conditions, params };
}
