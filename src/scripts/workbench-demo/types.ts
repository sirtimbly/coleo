import type { MessagingItem } from "../../workbench/messaging-collection";

export interface PagingEvidence {
	readonly fixtureTotal: number;
	readonly pageSize: number;
	readonly before: readonly number[];
	readonly after: readonly number[];
	readonly duplicates: number;
	readonly tasks: number;
	readonly reports: number;
}

export interface VerificationEvidence {
	readonly passed: number;
	readonly failed: number;
	readonly assertions: number;
	readonly typecheck: boolean;
}

export interface WorkbenchReportData {
	readonly generatedAt: string;
	readonly revision: string;
	readonly blueprint: unknown;
	readonly items: readonly MessagingItem[];
	readonly paging: PagingEvidence;
	readonly verification: VerificationEvidence;
}

export type DemoClient = "web" | "cli" | "tui";
export type DemoSourceMode = "healthy" | "unavailable" | "empty";
