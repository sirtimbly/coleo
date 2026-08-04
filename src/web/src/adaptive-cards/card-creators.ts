import type { CardCreator } from "../../../types/adaptive-cards";

const ARM_PALETTES = [
	["#fb7185", "#7c3aed", "#1e1b4b"],
	["#22d3ee", "#2563eb", "#172554"],
	["#34d399", "#0d9488", "#042f2e"],
	["#fbbf24", "#ea580c", "#431407"],
	["#e879f9", "#9333ea", "#3b0764"],
] as const;
const avatarSourceCache = new Map<string, string>();

export const BRAIN_CARD_CREATOR: CardCreator = {
	kind: "brain",
	id: "coleo-brain",
	displayName: "Coleo Brain",
};

export const USER_CARD_CREATOR: CardCreator = {
	kind: "user",
	id: "local-user",
	displayName: "You",
};

export function createArmCardCreator(id: string, displayName?: string): CardCreator {
	return {
		kind: "arm",
		id,
		displayName: displayName?.trim() || id,
	};
}

export function inferMessageCreator(from: string, sent = false): CardCreator {
	if (sent) return USER_CARD_CREATOR;
	if (/\bbrain\b/i.test(from)) return BRAIN_CARD_CREATOR;
	if (/\barm\b/i.test(from)) return createArmCardCreator(from.toLowerCase(), from);
	return {
		kind: "user",
		id: from.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
		displayName: from,
	};
}

function hashIdentity(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function createArmAvatarSource(id: string): string {
	const cached = avatarSourceCache.get(id);
	if (cached) return cached;
	const hash = hashIdentity(id);
	const palette = ARM_PALETTES[hash % ARM_PALETTES.length]!;
	const cells = Array.from({ length: 15 }, (_, index) =>
		(hash & (1 << (index % 24))) !== 0,
	);
	const pixels: string[] = [];
	for (let y = 0; y < 5; y++) {
		for (let x = 0; x < 3; x++) {
			if (!cells[y * 3 + x]) continue;
			const color = palette[(x + y + (hash % 3)) % palette.length]!;
			pixels.push(`<rect x="${x + 1}" y="${y + 1}" width="1" height="1" fill="${color}"/>`);
			if (x < 2) {
				pixels.push(`<rect x="${5 - x}" y="${y + 1}" width="1" height="1" fill="${color}"/>`);
			}
		}
	}
	const svg = [
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" shape-rendering="crispEdges">',
		`<rect width="7" height="7" fill="${palette[2]}"/>`,
		...pixels,
		'<rect x="3" y="3" width="1" height="1" fill="#f8fafc"/>',
		"</svg>",
	].join("");
	const source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
	avatarSourceCache.set(id, source);
	return source;
}

export function getCardCreatorAvatarSource(creator: CardCreator): string {
	if (creator.kind === "brain") return "/brand/coleo-pet-v2.png";
	if (creator.kind === "user") return "/avatars/user-operator.png";
	return createArmAvatarSource(creator.id);
}
