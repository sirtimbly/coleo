import { z } from "zod";
import { createInteractionInvocation } from "../../workbench/interaction-definition";
import { normalizeMessagingQuery } from "../../workbench/messaging-query";

import type { ResolvedInteraction } from "../../workbench/interaction-definition";
import type { MessagingQuery } from "../../workbench/messaging-query";
import type { ResolvedNamedResourceView } from "../../workbench/named-resource-views";

export const INBOX_HOST_FLAGS = new Map([
	["--view", true], ["--json", false], ["--cursor", true], ["--pages", true], ["--profile", true], ["--tree", false],
	["--expand", true], ["--branch", false], ["--metadata", true],
	["--help", false], ["-h", false],
	["--width", true],
	["--color", true],
]);
export interface InboxOptions {
	readonly viewId: string;
	readonly json: boolean;
	readonly help: boolean;
	readonly cursor?: string;
	readonly pages: number;
	readonly profileId?: string;
	readonly tree: boolean;
	readonly expansion: "collapsed" | "roots" | "all";
	readonly branch: boolean;
	readonly metadataId: string | null;
	readonly width?: number;
	readonly color: "auto" | "always" | "never";
	readonly query: MessagingQuery;
	readonly presentationId: string;
	readonly command?: ResolvedInteraction;
	readonly ids: readonly string[];
}

/** Split `--option=value` without interpreting the option's value. */
function flagParts(token: string): { name: string; inline?: string } {
	const separator = token.indexOf("=");
	return separator < 0 ? { name: token } : { name: token.slice(0, separator), inline: token.slice(separator + 1) };
}

/** Find the selected definition before parsing its dynamic flags; dash-prefixed values need `--view=value`. */
export function requestedInboxView(args: readonly string[]): string {
	let id = "inbox-triage";
	for (let index = 0; index < args.length; index++) {
		const part = flagParts(args[index]!);
		if (part.name !== "--view") continue;
		const value = part.inline ?? args[++index];
		if (!value || value.startsWith("-")) throw new Error("--view requires a named view ID");
		id = value;
	}
	return id;
}

/** Validate host and view-defined arguments, then normalize them into a query and command selection. */
export function parseInboxOptions(args: readonly string[], view: ResolvedNamedResourceView): InboxOptions {
	const flags = new Map<string, ResolvedInteraction>();
	const subcommands = new Map<string, ResolvedInteraction>();
	for (const binding of view.interactions.bindings) {
		if (!binding.available || !binding.cli) continue;
		if ("flag" in binding.cli) {
			for (const name of [binding.cli.flag, ...binding.cli.alias ? [binding.cli.alias] : []]) {
				if (INBOX_HOST_FLAGS.has(name) && !(binding.operation === "collection.help" && (name === "--help" || name === "-h"))) throw new Error(`View binding conflicts with reserved Inbox option ${name}`);
				if (flags.has(name)) throw new Error(`Duplicate resolved CLI flag ${name}`);
				flags.set(name, binding);
			}
		} else {
			if (["views", "validate"].includes(binding.cli.subcommand)) throw new Error(`View binding conflicts with reserved Inbox command ${binding.cli.subcommand}`);
			subcommands.set(binding.cli.subcommand, binding);
		}
	}
	const supplied = new Map<string, string | boolean>();
	const bound = new Map<string, { binding: ResolvedInteraction; value?: string }>();
	const positionals: string[] = [];
	let help = false;
	for (let index = 0; index < args.length; index++) {
		const token = args[index]!;
		if (!token.startsWith("-")) { positionals.push(token); continue; }
		const { name, inline } = flagParts(token);
		const binding = flags.get(name);
		const host = INBOX_HOST_FLAGS.get(name);
		if (!binding && host === undefined) throw new Error(`Unknown Inbox option ${name}. Use --help for this view's flags.`);
		const takesValue = binding ? !!binding.value : host;
		let value: string | undefined;
		if (takesValue) {
			value = inline ?? args[++index];
			if (value === undefined || value === "" || inline === undefined && value.startsWith("-")) throw new Error(`${name} requires a value`);
		} else if (inline !== undefined) throw new Error(`${name} does not accept a value`);
		if (binding) {
			if (bound.has(binding.id)) throw new Error(`Repeated option for ${binding.label}`);
			createInteractionInvocation(binding, value);
			bound.set(binding.id, { binding, value });
			if (binding.operation === "collection.help") help = true;
		} else {
			if (supplied.has(name)) throw new Error(`Repeated option ${name}`);
			supplied.set(name, value ?? true);
			if (name === "--help" || name === "-h") help = true;
		}
	}
	const base = normalizeMessagingQuery(view.definition.query);
	const query: Record<string, unknown> = { ...base };
	let presentationId = view.definition.presentation.active;
	const changes = new Map<string, unknown>();
	for (const { binding, value } of bound.values()) {
		if (binding.operation === "collection.help") continue;
		const invocation = createInteractionInvocation(binding, value);
		if (!invocation.binding) throw new Error(`No snapshot flag adapter for ${binding.operation}`);
		changes.set(invocation.binding, invocation.value);
	}
	for (const [binding, value] of changes) {
		if (["query.search", "query.facet", "query.mailbox", "query.brainCategory", "query.limit"].includes(binding)) query[binding.slice(6)] = value;
		else if (binding === "query.sort.direction") query.sort = { field: "timestamp", direction: value };
		else if (binding === "presentation.active" && typeof value === "string") presentationId = value;
		else throw new Error(`Unsupported snapshot binding ${binding}`);
	}
	// Mailbox/category controls have the same scope transitions as their browser counterparts.
	if (changes.has("query.mailbox")) {
		if (changes.has("query.facet") && query.facet !== "messages") throw new Error("--mailbox requires the messages facet");
		query.facet = "messages";
	}
	if (changes.has("query.brainCategory")) {
		if (changes.has("query.mailbox") || changes.has("query.facet") && query.facet !== "brain") throw new Error("--brain-category requires the brain facet");
		query.facet = "brain";
	}
	const profileId = supplied.get("--profile");
	if (typeof profileId === "string") query.profileId = z.string().trim().min(1).parse(profileId);
	const pagesValue = supplied.get("--pages") ?? "1";
	if (typeof pagesValue !== "string" || !/^\d+$/.test(pagesValue)) throw new Error("--pages must be an integer from 1 to 100");
	const pages = z.number().int().min(1).max(100).parse(Number(pagesValue));
	if (!view.definition.presentation.renderers.some((renderer) => renderer.id === presentationId)) throw new Error(`Unknown presentation ${presentationId}`);
	const expansion = z.enum(["collapsed", "roots", "all"]).parse(supplied.get("--expand") ?? view.definition.hierarchy?.initialExpansion ?? "all");
	const widthValue = supplied.get("--width");
	if (widthValue !== undefined && (typeof widthValue !== "string" || !/^\d+$/.test(widthValue))) throw new Error("--width must be an integer from 20 to 300");
	const width = widthValue === undefined ? undefined : z.number().int().min(20).max(300).parse(Number(widthValue));
	const color = z.enum(["auto", "always", "never"]).parse(supplied.get("--color") ?? "auto");
	const metadataValue = supplied.get("--metadata");
	const metadataId = typeof metadataValue === "string" ? metadataValue === "none" ? null : metadataValue : view.definition.insights?.active ?? null;
	if (metadataId && !view.definition.insights?.panels.some((panel) => panel.id === metadataId)) throw new Error(`Unknown metadata panel ${metadataId}`);
	const name = positionals.shift();
	const command = name ? subcommands.get(name) : undefined;
	if (name && !command) throw new Error(`Unknown Inbox command ${name}`);
	if (supplied.has("--branch") && command?.operation !== "inbox.mark-read") throw new Error("--branch applies to an explicit mark-read selection");
	let ids: readonly string[] = positionals;
	if (command && !help) {
		const invocation = createInteractionInvocation(command, command.value?.type === "string-list" ? positionals : positionals.length === 1 ? positionals[0] : undefined);
		ids = Array.isArray(invocation.value) ? invocation.value : typeof invocation.value === "string" ? [z.string().trim().min(1).parse(invocation.value)] : [];
	}
	return { viewId: view.definition.id, json: supplied.has("--json"), help, cursor: supplied.get("--cursor") as string | undefined,
		pages, profileId: typeof profileId === "string" ? profileId : undefined, tree: supplied.has("--tree") || supplied.has("--expand"), expansion,
		branch: supplied.has("--branch"), metadataId, width, color,
		query: normalizeMessagingQuery(query), presentationId, command, ids };
}

/** Generate help from the resolved view so its flags and commands stay in sync with the API definition. */
export function inboxHelp(view: ResolvedNamedResourceView): string {
	const lines = [`Usage: coleo inbox [command] [options]`, `Named view: ${view.definition.id}`, "", "View options (from the resolved interaction definition):"];
	for (const binding of view.interactions.bindings) {
		if (!binding.cli || !("flag" in binding.cli)) continue;
		const names = [binding.cli.flag, ...binding.cli.alias ? [binding.cli.alias] : []].join(", ");
		const argument = binding.value ? ` <${binding.value.choices?.join("|") ?? binding.value.type}>` : "";
		lines.push(`  ${names}${argument}  ${binding.label}${binding.available ? "" : ` [${binding.diagnostic}]`}`);
	}
	lines.push("", "Commands:", "  views  List API-published named views", "  validate <path>  Validate a JSON view locally without the API");
	for (const binding of view.interactions.bindings) if (binding.cli && "subcommand" in binding.cli) {
		lines.push(`  ${binding.cli.subcommand} <${binding.target ?? "id"}${binding.value?.type === "string-list" ? "..." : ""}>  ${binding.label}${binding.available ? "" : ` [${binding.diagnostic}]`}`);
	}
	lines.push("", "Snapshot options:", "  --view <id>       Named view (default: inbox-triage)", "  --json            Versioned JSON; diagnostics stay in the envelope",
		"  --cursor <value>  Continue the same query's opaque cursor", "  --pages <n>       Fetch 1–100 pages (default: 1)", "  --profile <id>    Attention profile (default: named view's profile)",
		"  --tree            Include loaded reply ancestry in text output", "  --expand <mode>   collapsed, roots, or all; implies --tree",
		"  --branch          mark-read selects loaded descendants of message IDs", "  --metadata <id>   Show a declared metadata panel (or none)",
		"  --width <n>       Text table width (20–300; default: terminal width)",
		"  --color <mode>    auto, always, or never; honors NO_COLOR in auto mode",
		"", "Exit codes: 0 complete requested window/help; 2 incomplete sources; 1 command/transport error.");
	return lines.join("\n");
}
