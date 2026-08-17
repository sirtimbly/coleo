import type { CardJsonObject } from "../../../types/adaptive-cards";

type TemplateContext = Record<string, unknown>;

function evaluate(expression: string, context: TemplateContext): unknown {
	const source = expression.trim();
	const countMatch = source.match(/^count\(([\w$]+)\)\s*>\s*0$/);
	if (countMatch?.[1]) {
		const value = context[countMatch[1]];
		return Array.isArray(value) && value.length > 0;
	}
	const notNullMatch = source.match(/^([\w$]+)\s*!=\s*null$/);
	if (notNullMatch?.[1]) return context[notNullMatch[1]] != null;
	const nullMatch = source.match(/^([\w$]+)\s*==\s*null$/);
	if (nullMatch?.[1]) return context[nullMatch[1]] == null;
	return context[source];
}

function expandString(value: string, context: TemplateContext): unknown {
	const exact = value.match(/^\$\{([^}]+)\}$/);
	if (exact?.[1]) return evaluate(exact[1], context);
	return value.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
		const resolved = evaluate(expression, context);
		return resolved == null ? "" : String(resolved);
	});
}

function expandNode(value: unknown, context: TemplateContext): unknown {
	if (typeof value === "string") return expandString(value, context);
	if (Array.isArray(value)) {
		return value.flatMap((item) => {
			const expanded = expandNode(item, context);
			return expanded === undefined
				? []
				: Array.isArray(expanded) && item && typeof item === "object" && "$data" in item
					? expanded
					: [expanded];
		});
	}
	if (!value || typeof value !== "object") return value;

	const input = value as Record<string, unknown>;
	if (typeof input.$when === "string" && !expandString(input.$when, context)) {
		return undefined;
	}
	if (typeof input.$data === "string") {
		const repeated = expandString(input.$data, context);
		if (!Array.isArray(repeated)) return [];
		const template = Object.fromEntries(
			Object.entries(input).filter(([key]) => key !== "$data" && key !== "$when"),
		);
		return repeated
			.map((item) => expandNode(
				template,
				item && typeof item === "object" && !Array.isArray(item)
					? { ...context, ...item as Record<string, unknown> }
					: { ...context, $data: item },
			))
			.filter((item) => item !== undefined);
	}

	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(input)) {
		if (key === "$when") continue;
		const expanded = expandNode(child, context);
		if (expanded !== undefined) output[key] = expanded;
	}
	return output;
}

/**
 * Expand the intentionally small expression subset used by Coleo's trusted
 * templates. This is not a general-purpose or user-extensible expression
 * runtime.
 */
export function expandCardTemplate(
	template: CardJsonObject,
	data: CardJsonObject,
): CardJsonObject {
	return expandNode(template, data) as CardJsonObject;
}
