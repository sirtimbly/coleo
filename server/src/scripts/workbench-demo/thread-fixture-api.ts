import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";

import { createMailRoutes } from "../../api/routes/mail";
import { formatErrorResponse } from "../../api/middleware/error";
import { Maildir } from "../../mail/maildir";
import { THREADED_MAIL_FIXTURE } from "../../workbench/examples/threaded-mail";

import type { MailThreadMessageInput, MailThreadProjection } from "../../workbench/mail-thread-model";

export async function writeThreadFixture(directory: string, messages: readonly MailThreadMessageInput[] = THREADED_MAIL_FIXTURE): Promise<void> {
	for (const mailbox of ["inbox", "sent"] as const) await new Maildir(join(directory, "mail", mailbox)).init();
	for (const message of messages) {
		const path = message.mailbox === "archive" ? join(directory, "mail", "inbox", "archive")
			: join(directory, "mail", message.mailbox, message.seen ? "cur" : "new");
		await mkdir(path, { recursive: true });
		const filename = `${message.id}${message.seen ? ":2,S" : ""}`;
		await writeFile(join(path, filename), [
			`From: ${message.from}`, "To: review@example.test", `Subject: ${message.subject}`,
			`Date: ${message.timestamp}`, ...Object.entries(message.headers).map(([key, value]) => `${key}: ${value}`),
			"", message.body,
		].join("\r\n"));
	}
}

export function createThreadFixtureApp(directory: string): Hono {
	const app = new Hono();
	app.onError((error, context) => formatErrorResponse(context, error));
	app.route("/mail", createMailRoutes({ coleoDir: directory }));
	return app;
}

export async function captureThreadFixture(directory: string): Promise<MailThreadProjection[]> {
	await writeThreadFixture(directory);
	const response = await createThreadFixtureApp(directory).request("/mail/threads?mailbox=inbox");
	if (!response.ok) throw new Error(`Thread API fixture failed: ${await response.text()}`);
	const body = await response.json() as { threads: MailThreadProjection[] };
	return body.threads;
}
