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
