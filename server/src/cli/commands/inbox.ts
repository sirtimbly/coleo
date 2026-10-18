import { Command } from "commander";
import { InboxApi } from "../inbox/api";
import { inboxHelp, parseInboxOptions, requestedInboxView } from "../inbox/options";
import { formatInboxSnapshot, loadInboxSnapshot, terminalText } from "../inbox/snapshot";
import { inspectInboxReference, markInboxSelectionRead } from "../inbox/actions";
import { getNamedResourceView, resolveNamedResourceView } from "../../workbench/named-resource-views";
import { inboxColorEnabled } from "../inbox/ink";
import { formatInboxDetail } from "../inbox/detail";

import type { ResolvedNamedResourceView } from "../../workbench/named-resource-views";
import type { InboxSnapshot } from "../inbox/snapshot";

export interface InboxCommandIO {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly columns?: number;
}
const DEFAULT_IO: InboxCommandIO = { stdout: (text) => console.log(text), stderr: (text) => console.error(text) };

const jsonOutput = (value: unknown): string => JSON.stringify(value, null, 2);
const isHelpRequest = (args: readonly string[]): boolean => args.some((arg) => arg === "--help" || arg === "-h");
const errorMessage = (error: unknown, fallback: string): string => error instanceof Error ? error.message : fallback;

async function runViews(args: readonly string[], api: InboxApi, io: InboxCommandIO): Promise<number> {
	if (args.some((arg) => arg !== "--json")) throw new Error("Usage: coleo inbox views [--json]");
	const views = await api.views();
	io.stdout(args.includes("--json") ? jsonOutput({ schemaVersion: 1, views }) : views.map(terminalText).join("\n"));
	return 0;
}

async function runValidate(args: readonly string[], io: InboxCommandIO): Promise<number> {
	if (!args[0] || args.length > 2 || (args[1] && args[1] !== "--json")) {
		throw new Error("Usage: coleo inbox validate <JSON path> [--json]");
	}
	const view = resolveNamedResourceView(await Bun.file(args[0]).json(), "cli");
	parseInboxOptions([], view);
	io.stdout(args.includes("--json") ? jsonOutput(view) : `Valid named Messaging view: ${terminalText(view.definition.id)}`);
	return 0;
}

async function resolveView(args: readonly string[], api: InboxApi, io: InboxCommandIO): Promise<ResolvedNamedResourceView> {
	const viewId = requestedInboxView(args);
	try {
		return await api.view(viewId);
	} catch (error) {
		// Help remains usable without a server, but fallback never serves snapshot data.
		const fallback = getNamedResourceView(viewId, "cli");
		if (!fallback || !isHelpRequest(args)) throw error;
		io.stderr(`Notice: API view resolution unavailable; help uses the bundled ${viewId} definition.`);
		return fallback;
	}
}

const formatOptions = (options: ReturnType<typeof parseInboxOptions>, io: InboxCommandIO) => ({
	columns: options.width ?? io.columns,
	color: inboxColorEnabled(options.color),
});

async function runOpen(api: InboxApi, options: ReturnType<typeof parseInboxOptions>, io: InboxCommandIO, viewId: string): Promise<number> {
	const target = await api.reference(options.ids[0]!, options.query.profileId);
	const detail = await inspectInboxReference(api, target, options.query.profileId);
	const output = { schemaVersion: 1, kind: "inbox.detail", viewId, query: options.query, id: target.id, detail, complete: target.complete, diagnostics: target.diagnostics };
	io.stdout(options.json ? jsonOutput(output) : formatInboxDetail(output, formatOptions(options, io)));
	return target.complete ? 0 : 2;
}

async function runMarkRead(api: InboxApi, view: ResolvedNamedResourceView, options: ReturnType<typeof parseInboxOptions>, io: InboxCommandIO): Promise<number> {
	const result = await markInboxSelectionRead(api, await loadInboxSnapshot(api, view, options), options.ids, options.branch);
	let refreshed: InboxSnapshot | undefined;
	let refreshError: string | undefined;
	if (!result.error) {
		try {
			refreshed = await loadInboxSnapshot(api, view, options);
		} catch (error) {
			refreshError = errorMessage(error, "Post-action refresh failed");
		}
	}

	const payload = { schemaVersion: 1, kind: "inbox.action", command: options.command!.command, result, refreshed, refreshError };
	const message = `Read: ${result.completedItemIds.length} items / ${result.completedMessageIds.length} mail messages; ${result.skippedMemberIds.length} context members skipped`;
	io.stdout(options.json
		? jsonOutput(payload)
		: `${message}${result.error ? `. Error: ${terminalText(result.error)}` : ""}\n${refreshed ? formatInboxSnapshot(refreshed, formatOptions(options, io)) : refreshError ? `Refresh unavailable: ${terminalText(refreshError)}. Writes succeeded; reload before retrying an action.` : ""}`);
	return result.error ? 1 : refreshError || refreshed && !refreshed.complete ? 2 : 0;
}

/** HTTP snapshots only. No DB, Maildir, JetStream, or live transport is opened by this command. */
export async function runInboxCommand(args: readonly string[], api = new InboxApi(), io = DEFAULT_IO): Promise<number> {
	try {
		const [subcommand, ...subcommandArgs] = args;
		if (subcommand === "views") return await runViews(subcommandArgs, api, io);
		if (subcommand === "validate") return await runValidate(subcommandArgs, io);

		const viewId = requestedInboxView(args);
		const view = await resolveView(args, api, io);
		const options = parseInboxOptions(args, view);
		if (options.help) { io.stdout(inboxHelp(view)); return 0; }
		if (options.command?.operation === "collection.open") return await runOpen(api, options, io, viewId);
		if (options.command?.operation === "inbox.mark-read") return await runMarkRead(api, view, options, io);

		const snapshot = await loadInboxSnapshot(api, view, options);
		if (options.command) throw new Error(`No CLI command adapter for ${options.command.operation}`);
		io.stdout(options.json ? jsonOutput(snapshot) : formatInboxSnapshot(snapshot, formatOptions(options, io)));
		return snapshot.complete ? 0 : 2;
	} catch (error) {
		const message = errorMessage(error, "Inbox command failed");
		if (args.includes("--json")) io.stdout(jsonOutput({ schemaVersion: 1, kind: "inbox.error", error: message }));
		else io.stderr(`Inbox: ${terminalText(message)}`);
		return 1;
	}
}

export function registerInboxCommands(program: Command): void {
	program.command("inbox").description("Named workbench Inbox snapshots, details, and explicit read actions")
		.helpOption(false).allowUnknownOption().allowExcessArguments()
		.action(async (_options: unknown, command: Command) => { process.exitCode = await runInboxCommand(command.args); });
}
