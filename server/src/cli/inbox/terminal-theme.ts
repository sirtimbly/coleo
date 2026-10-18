import chalk from "chalk";

export type InboxColorMode = "auto" | "always" | "never";
export interface InboxColorEnvironment { readonly isTTY?: boolean; readonly env?: NodeJS.ProcessEnv }

/** Resolve explicit color preferences and standard terminal environment overrides. */
export function inboxColorEnabled(mode: InboxColorMode = "auto", options: InboxColorEnvironment = {}): boolean {
	if (mode === "always") return true;
	if (mode === "never") return false;
	const env = options.env ?? process.env;
	if (env.NO_COLOR !== undefined) return false;
	if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
	return env.TERM !== "dumb" && !!(options.isTTY ?? process.stdout.isTTY);
}

export interface InboxInk {
	readonly title: (text: string) => string;
	readonly border: (text: string) => string;
	readonly muted: (text: string) => string;
	readonly reference: (text: string) => string;
	readonly point: (text: string, state: "action" | "unread" | "read") => string;
}

/** Create the semantic ANSI styles shared by Inbox text renderers. */
export function inboxInk(enabled: boolean): InboxInk {
	const paint = new chalk.Instance({ level: enabled ? 3 : 0 });
	return {
		title: paint.bold.rgb(236, 254, 255).bgRgb(22, 78, 99),
		border: paint.rgb(100, 116, 139),
		muted: paint.rgb(148, 163, 184),
		reference: paint.rgb(103, 232, 249),
		point: (text, state) => (state === "action" ? paint.bold.rgb(251, 191, 36) : state === "unread" ? paint.bold.rgb(103, 232, 249) : paint.rgb(148, 163, 184))(text),
	};
}
