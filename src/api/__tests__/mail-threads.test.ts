import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createThreadFixtureApp, writeThreadFixture } from "../../scripts/workbench-demo/thread-fixture-api";
import { THREADED_MAIL_FIXTURE } from "../../workbench/examples/threaded-mail";

import type { MailThreadProjection } from "../../workbench/mail-thread-model";

describe("mail thread API", () => {
	let directory: string;
	beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "coleo-thread-api-")); await writeThreadFixture(directory); });
	afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

	it("returns complete nested thread context across inbox/sent, paging roots rather than messages", async () => {
		const app = createThreadFixtureApp(directory);
		const response = await app.request("/mail/threads?mailbox=inbox&limit=1");
		expect(response.status).toBe(200);
		const body = await response.json() as { threads: MailThreadProjection[]; pagination: { total: number; hasMore: boolean } };
		expect(body.pagination).toMatchObject({ total: 2, hasMore: true });
		expect(body.threads[0]?.id).toBe("review");
		expect(body.threads[0]?.hierarchy.nodes).toHaveLength(6);
		const detail = await app.request("/mail/threads/review?mailbox=sent");
		expect((await detail.json() as { thread: MailThreadProjection }).thread.messageCount).toBe(5);
		const searched = await app.request("/mail/threads?search=continuation");
		expect(searched.status).toBe(200);
		expect((await searched.json() as { threads: MailThreadProjection[] }).threads.map((thread) => thread.id)).toEqual(["review"]);
		const message = await app.request(`/mail/threads/review/messages/${encodeURIComponent("<review-api@example.test>")}`);
		expect((await message.json() as { message: { subject: string } }).message.subject).toBe("API branch: scoped paging");
		const sent = await app.request(`/mail/threads/review/messages/${encodeURIComponent("<review-terminal@example.test>")}`);
		expect((await sent.json() as { message: { subject: string } }).message.subject).toBe("Terminal branch: one named view");
	});

	it("resolves explicit nested groups against a revision without mutating mail or selecting siblings", async () => {
		const app = createThreadFixtureApp(directory);
		const thread = (await (await app.request("/mail/threads/review")).json() as { thread: MailThreadProjection }).thread;
		const response = await app.request("/mail/threads/review/selection", { method: "POST",
			headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: thread.revision,
				branchIds: ["message:<review-api@example.test>", "message:<review-api-check@example.test>"] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ scope: "loaded-descendants", complete: true,
			memberIds: ["message:<review-api@example.test>", "message:<review-api-check@example.test>"],
			inboxMessageIds: ["review-api", "review-api-check"],
		});
		expect((await (await app.request("/mail/threads/review")).json() as { thread: MailThreadProjection }).thread.revision)
			.toBe(thread.revision);
		for (const [branchIds, revision, status] of [[ ["unknown"], thread.revision, 400 ],
			[["thread:inbox:review"], "stale", 409]] as const) {
			expect((await app.request("/mail/threads/review/selection", { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ revision, branchIds }) })).status).toBe(status);
		}
	});

	it("rejects invalid scopes and surfaces storage failures instead of returning an empty thread collection", async () => {
		const app = createThreadFixtureApp(directory);
		expect((await app.request("/mail/threads?mailbox=unknown")).status).toBe(400);
		expect((await app.request("/mail/threads?limit=0")).status).toBe(400);
		expect((await app.request("/mail/threads/missing")).status).toBe(404);
		expect((await app.request("/mail/threads/review/selection", { method: "POST",
			headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
		await rm(join(directory, "mail", "sent", "new"), { recursive: true });
		await writeFile(join(directory, "mail", "sent", "new"), "not a directory");
		expect((await app.request("/mail/threads")).status).toBe(503);
	});

	it("rejects a selected-group revision after a reply arrives, and resolves new membership only on an explicit reload", async () => {
		const app = createThreadFixtureApp(directory);
		const previous = (await (await app.request("/mail/threads/review")).json() as { thread: MailThreadProjection }).thread;
		await writeThreadFixture(directory, [...THREADED_MAIL_FIXTURE, {
			...THREADED_MAIL_FIXTURE[1]!, id: "new-api", timestamp: "2026-10-01T13:00:00.000Z",
			headers: { "Message-ID": "<new-api@example.test>", "X-Coleo-Thread-Id": "review",
				"In-Reply-To": "<review-api@example.test>", References: "<review-root@example.test> <review-api@example.test>" },
		}]);
		const request = (revision: string) => app.request("/mail/threads/review/selection", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ revision, branchIds: ["message:<review-api@example.test>"] }),
		});
		expect((await request(previous.revision)).status).toBe(409);
		const current = (await (await app.request("/mail/threads/review")).json() as { thread: MailThreadProjection }).thread;
		const selection = await (await request(current.revision)).json() as { memberIds: string[] };
		expect(selection.memberIds).toHaveLength(3);
		expect(selection.memberIds).toContain("message:<new-api@example.test>");
	});
});
