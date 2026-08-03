declare module "adaptivecards/dist/adaptivecards.js" {
	export interface Action {
		getJsonTypeName(): string;
		data?: object;
		verb?: string;
	}

	export class HostConfig {
		constructor(input?: unknown);
	}

	export class AdaptiveCard {
		hostConfig: HostConfig;
		onExecuteAction?: (action: Action) => void;
		parse(payload: unknown): void;
		render(): HTMLElement | undefined;
	}
}

declare module "adaptivecards-templating/dist/adaptivecards-templating.js" {
	export class Template {
		constructor(payload: unknown);
		expand(context: { $root: unknown }): unknown;
	}
}
