import type { CardEnvelope } from "../../../types/adaptive-cards";

const MAX_CARD_ROUTE_LENGTH = 48_000;

export function createCardRoute(envelope: CardEnvelope): {
	pathname: string;
	search: string;
	title: string;
} {
	const params = new URLSearchParams({ envelope: JSON.stringify(envelope) });
	const search = `?${params.toString()}`;
	if (search.length > MAX_CARD_ROUTE_LENGTH) {
		throw new Error("This card is too large to open as a persistent panel.");
	}
	return {
		pathname: "/card",
		search,
		title: envelope.presentation.title ?? "Card",
	};
}

export function parseCardRoute(searchParams: URLSearchParams): CardEnvelope | null {
	const raw = searchParams.get("envelope");
	if (!raw || raw.length > MAX_CARD_ROUTE_LENGTH) return null;
	try {
		const value = JSON.parse(raw) as Partial<CardEnvelope>;
		if (
			typeof value.id !== "string" ||
			value.schemaVersion !== "1.5" ||
			!value.template ||
			typeof value.template.id !== "string" ||
			typeof value.template.version !== "number" ||
			!value.presentation ||
			typeof value.presentation.surface !== "string" ||
			!value.data ||
			typeof value.data !== "object" ||
			Array.isArray(value.data)
		) {
			return null;
		}
		return value as CardEnvelope;
	} catch {
		return null;
	}
}
