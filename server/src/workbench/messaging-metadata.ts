import type { MessagingCollectionPage } from "./messaging-collection";

export interface MessagingMetadataValue {
	readonly field: string;
	readonly label: string;
	readonly value: number | string | null;
	readonly scope: "query" | "loaded-window";
}

/** The browser's metadata fallback and terminal summaries use the same scoped values. */
export function messagingMetadata(page: MessagingCollectionPage, fields: readonly string[]): readonly MessagingMetadataValue[] {
	const latest = page.items.reduce<string | null>((latest, item) => !latest || Date.parse(item.timestamp) > Date.parse(latest) ? item.timestamp : latest, null);
	const values: Readonly<Record<string, MessagingMetadataValue>> = {
		unread: { field: "unread", label: "Unread", value: page.summaries.unread, scope: "query" },
		requiresAction: { field: "requiresAction", label: "Needs action", value: page.summaries.requiresAction, scope: "query" },
		timestamp: { field: "timestamp", label: "Latest loaded item", value: latest, scope: "loaded-window" },
	};
	return fields.flatMap((field) => Object.hasOwn(values, field) ? [values[field]!] : []);
}
