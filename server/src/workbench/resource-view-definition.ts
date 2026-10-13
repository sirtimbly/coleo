/** Early collection-view wire contract. Registries and client implementations remain runtime-only. */
import { z } from "zod";

export const RESOURCE_VIEW_SLOTS = [
	"toolbar.primary.identity", "toolbar.primary.context", "toolbar.primary.search",
	"toolbar.primary.actions", "toolbar.primary.state", "toolbar.secondary.filters",
	"toolbar.secondary.sort", "toolbar.secondary.presentation", "toolbar.secondary.selection",
	"toolbar.secondary.insights",
] as const;

export type ResourceViewSlot = typeof RESOURCE_VIEW_SLOTS[number];
export type ViewJsonValue = string | number | boolean | null | readonly ViewJsonValue[] | { readonly [key: string]: ViewJsonValue };

export interface ResourceViewControl {
	readonly id: string;
	readonly widget: string;
	readonly label: string;
	readonly binding?: string;
	readonly command?: string;
}

export interface ResourceViewRenderer {
	readonly id: string;
	readonly renderer: string;
	readonly label: string;
	readonly fields: readonly string[];
}

export interface ResourceViewDefinition {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly panelKind: "collection";
	readonly resource: string;
	readonly query: { readonly [key: string]: ViewJsonValue };
	readonly commands: readonly string[];
	readonly slots: Readonly<Partial<Record<ResourceViewSlot, readonly ResourceViewControl[]>>>;
	readonly hierarchy?: {
		readonly initialExpansion: "collapsed" | "roots" | "all";
		readonly selectionScope: "loaded-descendants";
	};
	readonly insights?: {
		readonly active: string | null;
		readonly panels: readonly ResourceViewRenderer[];
	};
	readonly presentation: {
		readonly active: string;
		readonly renderers: readonly (ResourceViewRenderer & { readonly kind: "grid" | "cards" | "custom" })[];
	};
}

export interface ResourceViewRegistry {
	readonly resources: Readonly<Record<string, {
		readonly fields: readonly string[];
		readonly commands: readonly string[];
		readonly parseQuery: (query: unknown) => unknown;
	}>>;
	readonly widgets: Readonly<Record<string, {
		readonly slots: readonly ResourceViewSlot[];
		readonly bindings: readonly string[];
		readonly commands?: readonly string[];
		readonly capabilities: readonly string[];
		readonly fallback?: string;
	}>>;
	readonly renderers: Readonly<Record<string, {
		readonly kinds: readonly ("grid" | "cards" | "custom" | "insight")[];
		readonly capabilities: readonly string[];
		readonly fallback?: string;
	}>>;
}

const id = z.string().trim().min(1);
const rendererSchema = z.object({ id, renderer: id, label: id, fields: z.array(id) }).strict();
const definitionSchema = z.object({
	schemaVersion: z.literal(1), id, panelKind: z.literal("collection"), resource: id,
	query: z.record(z.string(), z.json()), commands: z.array(id),
	slots: z.partialRecord(z.enum(RESOURCE_VIEW_SLOTS), z.array(z.object({
		id, widget: id, label: id, binding: id.optional(), command: id.optional(),
	}).strict())),
	hierarchy: z.object({ initialExpansion: z.enum(["collapsed", "roots", "all"]),
		selectionScope: z.literal("loaded-descendants") }).strict().optional(),
	insights: z.object({ active: id.nullable(), panels: z.array(rendererSchema) }).strict().optional(),
	presentation: z.object({
		active: id,
		renderers: z.array(rendererSchema.extend({ kind: z.enum(["grid", "cards", "custom"]) })).min(1),
	}).strict(),
}).strict();

function requireUnique(values: readonly string[], path: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${path} contains duplicate IDs`);
}

export function parseResourceViewDefinition(value: unknown, registry: ResourceViewRegistry): ResourceViewDefinition {
	const view = definitionSchema.parse(value);
	const resource = registry.resources[view.resource];
	if (!resource) throw new Error(`resource: unknown resource "${view.resource}"`);
	const query = z.record(z.string(), z.json()).parse(resource.parseQuery(view.query));
	requireUnique(view.commands, "commands");
	for (const command of view.commands) {
		if (!resource.commands.includes(command)) throw new Error(`commands: unsupported command "${command}"`);
	}
	const controls = Object.entries(view.slots).flatMap(([slot, items]) => items.map((control) => ({ slot, control })));
	requireUnique(controls.map(({ control }) => control.id), "slots");
	for (const { slot, control } of controls) {
		const widget = registry.widgets[control.widget];
		if (!widget) throw new Error(`${slot}.${control.id}: unknown widget "${control.widget}"`);
		if (!widget.slots.includes(slot as ResourceViewSlot)) throw new Error(`${slot}.${control.id}: incompatible widget slot`);
		if (control.binding && !widget.bindings.includes(control.binding)) {
			throw new Error(`${slot}.${control.id}: invalid binding "${control.binding}"`);
		}
		if (control.command && !view.commands.includes(control.command)) {
			throw new Error(`${slot}.${control.id}: command must be declared in commands`);
		}
		if (control.command && !widget.commands?.includes(control.command)) {
			throw new Error(`${slot}.${control.id}: incompatible widget command "${control.command}"`);
		}
	}
	for (const [path, renderers, active] of [
		["presentation", view.presentation.renderers, view.presentation.active],
		["insights", view.insights?.panels ?? [], view.insights?.active ?? null],
	] as const) {
		requireUnique(renderers.map((renderer) => renderer.id), path);
		if (active !== null && !renderers.some((renderer) => renderer.id === active)) {
			throw new Error(`${path}.active: unknown renderer instance "${active}"`);
		}
		for (const renderer of renderers) {
			const descriptor = registry.renderers[renderer.renderer];
			const kind = "kind" in renderer ? renderer.kind : "insight";
			if (!descriptor?.kinds.includes(kind)) throw new Error(`${path}.${renderer.id}: unknown or incompatible renderer`);
			for (const field of renderer.fields) {
				if (!resource.fields.includes(field)) throw new Error(`${path}.${renderer.id}: unknown resource field "${field}"`);
			}
		}
	}
	return { ...view, query };
}

export interface ResolvedViewFeature {
	readonly id: string;
	readonly implementation: string | null;
	readonly diagnostic?: string;
}

/** A CLI flag/key/menu is an adapter for the same control purpose, not a serialized React widget. */
export function resolveResourceViewFeatures(
	view: ResourceViewDefinition,
	registry: ResourceViewRegistry,
	capabilities: ReadonlySet<string>,
): {
	slots: Readonly<Partial<Record<ResourceViewSlot, readonly ResolvedViewFeature[]>>>;
	insights: readonly ResolvedViewFeature[];
	presentation: readonly ResolvedViewFeature[];
} {
	const resolve = (featureId: string, registeredId: string, descriptors: ResourceViewRegistry["renderers"] |
		ResourceViewRegistry["widgets"]): ResolvedViewFeature => {
		const visited = new Set<string>();
		let current: string | undefined = registeredId;
		while (current) {
			if (visited.has(current)) return { id: featureId, implementation: null, diagnostic: `Fallback cycle: ${current}` };
			visited.add(current);
			const descriptor: { readonly capabilities: readonly string[]; readonly fallback?: string } | undefined = descriptors[current];
			if (!descriptor) return { id: featureId, implementation: null, diagnostic: `Unknown implementation: ${current}` };
			const missing = descriptor.capabilities.filter((capability) => !capabilities.has(capability));
			if (missing.length === 0) return {
				id: featureId, implementation: current,
				...(current !== registeredId ? { diagnostic: `Using ${current} instead of ${registeredId}` } : {}),
			};
			if (!descriptor.fallback) return {
				id: featureId, implementation: null, diagnostic: `Requires capabilities: ${missing.join(", ")}`,
			};
			current = descriptor.fallback;
		}
		return { id: featureId, implementation: null, diagnostic: `No implementation for ${registeredId}` };
	};
	return {
		slots: Object.fromEntries(Object.entries(view.slots).map(([slot, controls]) => [
			slot, controls.map((control) => resolve(control.id, control.widget, registry.widgets)),
		])),
		insights: (view.insights?.panels ?? []).map((panel) => resolve(panel.id, panel.renderer, registry.renderers)),
		presentation: view.presentation.renderers.map((renderer) => resolve(renderer.id, renderer.renderer, registry.renderers)),
	};
}
