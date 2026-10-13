import type { MailThreadProjection } from "./mail-thread-model";

export interface MailThreadMessageDetail {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly subject: string;
	readonly timestamp: string;
	readonly body: string;
}

export interface MailThreadDetail {
	readonly schemaVersion: 1;
	readonly thread: MailThreadProjection;
	readonly messages: readonly MailThreadMessageDetail[];
}
