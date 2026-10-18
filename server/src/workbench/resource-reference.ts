import { createHash } from "node:crypto";

import type { MessagingItem } from "./messaging-collection";

export interface MessagingReferenceTarget {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly detail: MessagingItem["detail"];
	readonly complete: boolean;
	readonly diagnostics: readonly string[];
}

/** Display aliases are identity-derived, never row numbers or partial-ID matches. */
export function resourceReference(id: string): string {
	return `@${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

export function resolveResourceReference(ids: Iterable<string>, reference: string): string {
	const candidates = [...new Set(ids)];
	if (candidates.includes(reference)) return reference;
	if (!/^@[a-f0-9]{8}$/.test(reference)) return reference;
	const matches = candidates.filter((id) => resourceReference(id) === reference);
	if (matches.length > 1) throw new Error(`Ambiguous reference ${reference}; use the full ID from --json`);
	return matches[0] ?? reference;
}
