/** Serializable interaction intent. Client handlers, DOM events, and CLI parsers stay in adapters. */
import { z } from "zod";

export const INTERACTION_CLIENTS = ["web", "cli", "tui", "native"] as const;
export type InteractionClient = typeof INTERACTION_CLIENTS[number];
export type InteractionScope = "collection" | "item" | "tree" | "help";
export type KeyModifier = "control" | "meta" | "alt" | "shift" | "primary";

const id = z.string().trim().min(1);
const keyName = z.string().refine((value) => value.length === 1 && !/[A-Z]/.test(value) ||
	["Space", "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete"].includes(value) ||
	/^F([1-9]|1[0-2])$/.test(value), "Use a lowercase printable key or a recognized key name");
export const keyboardBindingSchema = z.object({
	key: keyName,
	modifiers: z.array(z.enum(["control", "meta", "alt", "shift", "primary"])).default([]),
	scope: z.enum(["collection", "item", "tree", "help"]).default("collection"),
}).strict();
export const interactionBindingSchema = z.object({
	id, operation: id,
	disabled: z.boolean().optional(),
	keyboard: z.object({
		shared: z.array(keyboardBindingSchema).default([]),
		web: z.array(keyboardBindingSchema).optional(),
		tui: z.array(keyboardBindingSchema).optional(),
		native: z.array(keyboardBindingSchema).optional(),
	}).strict().optional(),
	cli: z.union([
		z.object({ flag: z.string().regex(/^--[a-z][a-z0-9-]*$/), alias: z.string().regex(/^-[a-zA-Z]$/).optional() }).strict(),
		z.object({ subcommand: z.string().regex(/^[a-z][a-z0-9-]*$/) }).strict(),
	]).optional(),
}).strict();
const profileSchema = z.object({ schemaVersion: z.literal(1), id, bindings: z.array(interactionBindingSchema) }).strict();

export type KeyboardBinding = z.infer<typeof keyboardBindingSchema>;
export type InteractionBinding = z.infer<typeof interactionBindingSchema>;
export type InteractionProfile = z.infer<typeof profileSchema>;

export interface InteractionValue {
	readonly type: "string" | "string-list" | "integer";
	readonly choices?: readonly string[];
	readonly minimum?: number;
	readonly maximum?: number;
}
export interface InteractionOperation {
	readonly label: string;
	readonly kind: "navigation" | "query" | "presentation" | "command";
	readonly binding?: string;
	readonly command?: string;
	readonly target?: "focused-item" | "selected-items" | "loaded-descendants";
	readonly value?: InteractionValue;
}
export interface InteractionRegistry {
	readonly operations: Readonly<Record<string, InteractionOperation>>;
	readonly profiles: Readonly<Record<string, unknown>>;
}
export interface InteractionDefinition {
	readonly interactionProfile?: string;
	readonly interactions?: readonly InteractionBinding[];
	readonly commands: readonly string[];
}
export interface ResolvedInteraction extends InteractionOperation {
	readonly id: string;
	readonly operation: string;
	readonly keyboard: readonly KeyboardBinding[];
	readonly cli?: InteractionBinding["cli"];
	readonly available: boolean;
	readonly diagnostic?: string;
}
export interface ResolvedInteractions {
	readonly schemaVersion: 1;
	readonly profileId: string | null;
	readonly client: InteractionClient;
	readonly bindings: readonly ResolvedInteraction[];
}

/** Reject duplicate binding IDs within one profile or override list. */
function uniqueIds(bindings: readonly InteractionBinding[], path: string): void {
	const ids = new Set<string>();
	for (const binding of bindings) {
		if (ids.has(binding.id)) throw new Error(`${path}: duplicate interaction ID "${binding.id}"`);
		ids.add(binding.id);
	}
}

/** Normalize equivalent printable keys and the named Space key for conflict/match checks. */
function canonicalKey(key: string): string {
	return key === "Space" ? " " : key.length === 1 ? key.toLowerCase() : key;
}

/** Expand platform-primary and printable-symbol shift variants into comparable signatures. */
function keySignatures(binding: KeyboardBinding): string[] {
	const modifiers = [...new Set(binding.modifiers)];
	const concrete = modifiers.filter((modifier) => modifier !== "primary");
	const variants = modifiers.includes("primary") ? ["control", "meta"] as const : [null];
	return variants.flatMap((modifier) => {
		const resolved = [...new Set(modifier ? [...concrete, modifier] : concrete)];
		const printableSymbol = binding.key.length === 1 && !/[a-z]/i.test(binding.key);
		const shiftVariants = printableSymbol && !resolved.includes("shift") ? [resolved, [...resolved, "shift"]] : [resolved];
		return shiftVariants.map((modifiers) => JSON.stringify([canonicalKey(binding.key), [...modifiers].sort()]));
	});
}

/** Determine whether two key scopes can be active together and therefore conflict. */
function overlappingScopes(left: InteractionScope, right: InteractionScope): boolean {
	return left === right || left !== "help" && right !== "help" && (left === "collection" || right === "collection");
}

/** Reject duplicate or host-reserved shortcuts for one client's effective bindings. */
function validateKeys(bindings: readonly InteractionBinding[], client: "web" | "tui", reserved: readonly KeyboardBinding[]): void {
	const seen: { id: string; key: KeyboardBinding; signatures: string[] }[] = reserved.map((key) => ({
		id: "host-reserved", key, signatures: keySignatures(key),
	}));
	for (const binding of bindings) {
		if (binding.disabled) continue;
		for (const key of binding.keyboard?.[client] ?? binding.keyboard?.shared ?? []) {
			if (new Set(key.modifiers).size !== key.modifiers.length) throw new Error(`${binding.id}: duplicate key modifiers`);
			if (key.modifiers.includes("primary") && (key.modifiers.includes("meta") || key.modifiers.includes("control"))) {
				throw new Error(`${binding.id}: primary cannot be combined with control or meta`);
			}
			const signatures = keySignatures(key);
			const conflict = seen.find((entry) => (entry.id === "host-reserved" || overlappingScopes(key.scope, entry.key.scope)) &&
				entry.signatures.some((signature) => signatures.includes(signature)));
			if (conflict) throw new Error(`${client}: shortcut ${formatKeyboardBinding(key)} conflicts between ${conflict.id} and ${binding.id}`);
			seen.push({ id: binding.id, key, signatures });
		}
	}
}

/** Overrides replace a whole binding by ID; no implicit merging of flags or shortcuts. */
export function validateInteractionDefinition(
	view: InteractionDefinition,
	registry: InteractionRegistry,
	reserved: Partial<Record<"web" | "tui", readonly KeyboardBinding[]>> = {},
): readonly InteractionBinding[] {
	let inherited: InteractionBinding[] = [];
	if (view.interactionProfile) {
		const source = Object.hasOwn(registry.profiles, view.interactionProfile) ? registry.profiles[view.interactionProfile] : undefined;
		if (!source) throw new Error(`Unknown interaction profile "${view.interactionProfile}"`);
		const profile = profileSchema.parse(source);
		if (profile.id !== view.interactionProfile) throw new Error("Interaction profile ID does not match its registration");
		inherited = profile.bindings;
		uniqueIds(inherited, profile.id);
	}
	const overrides = (view.interactions ?? []).map((binding) => interactionBindingSchema.parse(binding));
	uniqueIds(overrides, "interactions");
	const merged = new Map(inherited.map((binding) => [binding.id, binding]));
	for (const binding of overrides) merged.set(binding.id, binding);
	const bindings = [...merged.values()];
	const flags = new Set<string>();
	const commands = new Set<string>();
	for (const binding of bindings) {
		const operation = Object.hasOwn(registry.operations, binding.operation) ? registry.operations[binding.operation] : undefined;
		if (!operation) throw new Error(`${binding.id}: unknown operation "${binding.operation}"`);
		if (operation.command && !view.commands.includes(operation.command)) {
			throw new Error(`${binding.id}: command "${operation.command}" must be declared by the view`);
		}
		if (binding.disabled || !binding.cli) continue;
		const names = "flag" in binding.cli ? [binding.cli.flag, ...binding.cli.alias ? [binding.cli.alias] : []] : [];
		for (const name of names) {
			if (flags.has(name)) throw new Error(`Duplicate CLI flag/alias "${name}"`);
			flags.add(name);
		}
		if ("subcommand" in binding.cli) {
			if (commands.has(binding.cli.subcommand)) throw new Error(`Duplicate CLI subcommand "${binding.cli.subcommand}"`);
			commands.add(binding.cli.subcommand);
		}
	}
	validateKeys(bindings, "web", reserved.web ?? []);
	validateKeys(bindings, "tui", reserved.tui ?? []);
	return bindings;
}

/** Resolve inherited and overridden bindings into client-specific adapter availability and diagnostics. */
export function resolveInteractions(
	view: InteractionDefinition,
	registry: InteractionRegistry,
	client: InteractionClient,
	supportedOperations: ReadonlySet<string>,
	reserved: Partial<Record<"web" | "tui", readonly KeyboardBinding[]>> = {},
): ResolvedInteractions {
	const bindings = validateInteractionDefinition(view, registry, reserved);
	return { schemaVersion: 1, profileId: view.interactionProfile ?? null, client,
		bindings: bindings.filter((binding) => !binding.disabled).map((binding) => {
			const operation = registry.operations[binding.operation]!;
			const specific = client === "web" || client === "tui" || client === "native" ? binding.keyboard?.[client] : undefined;
			const keyboard = client === "cli" ? [] : specific ?? binding.keyboard?.shared ?? [];
			const mapped = client === "cli" ? !!binding.cli : keyboard.length > 0;
			const available = mapped && supportedOperations.has(binding.operation);
			return { ...operation, id: binding.id, operation: binding.operation, keyboard, cli: binding.cli, available,
				...available ? {} : { diagnostic: mapped ? `No ${client} adapter for ${binding.operation}` : `No ${client} ${client === "cli" ? "CLI" : "keyboard"} binding for ${binding.operation}` } };
		}),
	};
}

/** Format one normalized shortcut for help and validation diagnostics. */
export function formatKeyboardBinding(binding: KeyboardBinding): string {
	return [...binding.modifiers, binding.key === " " ? "Space" : binding.key].join("+");
}

export interface InteractionKeyInput {
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
}

/** Adapters handle focus/editing/IME guards before calling this dependency-free matcher. */
export function matchInteractionKey(
	bindings: readonly ResolvedInteraction[], input: InteractionKeyInput, scope: InteractionScope,
	platform: "mac" | "other",
): ResolvedInteraction | undefined {
	return bindings.find((binding) => binding.available && binding.keyboard.some((key) => {
		if (key.scope !== scope && !(key.scope === "collection" && scope !== "help")) return false;
		if (canonicalKey(input.key) !== canonicalKey(key.key)) return false;
		const modifiers = new Set(key.modifiers.map((modifier) => modifier === "primary"
			? platform === "mac" ? "meta" : "control" : modifier));
		// Printable symbols carry their own shift state (e.g. '?' on a US layout).
		const checkShift = /^[a-z]$/i.test(key.key) || key.key.length > 1 || modifiers.has("shift");
		return input.ctrlKey === modifiers.has("control") && input.metaKey === modifiers.has("meta") &&
			input.altKey === modifiers.has("alt") && (!checkShift || input.shiftKey === modifiers.has("shift"));
	}));
}

export interface InteractionInvocation {
	readonly operation: string;
	readonly binding?: string;
	readonly command?: string;
	readonly target?: InteractionOperation["target"];
	readonly value?: string | readonly string[] | number;
}

/** The future CLI and interactive controls validate values through the same operation descriptor. */
export function createInteractionInvocation(binding: ResolvedInteraction, value?: unknown): InteractionInvocation {
	if (!binding.available) throw new Error(binding.diagnostic ?? `Unavailable operation ${binding.operation}`);
	let parsed: string | readonly string[] | number | undefined;
	if (!binding.value) {
		if (value !== undefined) throw new Error(`${binding.id}: does not accept a value`);
	} else if (binding.value.type === "string") {
		parsed = z.string().parse(value);
		if (binding.value.choices && !binding.value.choices.includes(parsed)) throw new Error(`${binding.id}: expected ${binding.value.choices.join(", ")}`);
	} else if (binding.value.type === "string-list") {
		parsed = z.array(z.string().trim().min(1)).min(1).parse(value);
	} else {
		// A terminal parser can pass a numeric token; reject empty, fractional, and malformed values.
		const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
		parsed = z.number().int().parse(number);
		if (binding.value.minimum !== undefined && parsed < binding.value.minimum ||
			binding.value.maximum !== undefined && parsed > binding.value.maximum) throw new Error(`${binding.id}: value out of range`);
	}
	return { operation: binding.operation, binding: binding.binding, command: binding.command, target: binding.target, value: parsed };
}
