import { Hono } from "hono";
import { z } from "zod";

import { MESSAGING_MAILBOXES } from "../../workbench/messaging-query";
import { hierarchySubtreeIds, indexResourceHierarchy } from "../../workbench/resource-hierarchy";
import { loadMailThreadProjections, readThreadMessage } from "../mail-thread-projection";
import { HttpError } from "../middleware/error";

import type { MailThreadProjection } from "../../workbench/mail-thread-model";

interface MailThreadContext { Variables: { coleoDir: string } }

const querySchema = z.object({
	mailbox: z.enum(MESSAGING_MAILBOXES).default("inbox"), search: z.string().default(""),
	limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
}).strict();

function parseQuery(value: unknown): z.infer<typeof querySchema> {
	const parsed = querySchema.safeParse(value);
	if (!parsed.success) throw HttpError.badRequest(`Invalid thread query: ${parsed.error.message}`);
	return parsed.data;
}

async function loadThreads(coleoDir: string, mailbox: "inbox" | "sent" | "archive"): Promise<MailThreadProjection[]> {
	try { return await loadMailThreadProjections(coleoDir, mailbox); }
	catch { throw new HttpError(503, "Mail thread source is unavailable; the result is not an empty mailbox"); }
}

export function createMailThreadRoutes(): Hono<MailThreadContext> {
	const app = new Hono<MailThreadContext>();
	app.get("/", async (c) => {
		const query = parseQuery(c.req.query());
		const all = await loadThreads(c.get("coleoDir"), query.mailbox);
		const search = query.search.trim().toLowerCase();
		const threads = all.filter((thread) => !search || thread.hierarchy.nodes.some((node) =>
			`${node.data.title} ${node.data.summary} ${node.data.source}`.toLowerCase().includes(search)));
		return c.json({ schemaVersion: 1, scope: { mailbox: query.mailbox, search },
			threads: threads.slice(query.offset, query.offset + query.limit),
			pagination: { limit: query.limit, offset: query.offset, total: threads.length,
				hasMore: query.offset + query.limit < threads.length },
			counts: { scope: "query", threads: threads.length, contextMessages: threads.reduce((sum, thread) => sum + thread.messageCount, 0),
				mailboxMessages: threads.reduce((sum, thread) => sum + thread.mailboxMessageCount, 0), complete: true },
		});
	});
	app.get("/:id", async (c) => {
		const query = parseQuery(c.req.query());
		const threads = await loadThreads(c.get("coleoDir"), query.mailbox);
		const thread = threads.find((candidate) => candidate.id === c.req.param("id"));
		if (!thread) throw HttpError.notFound("Mail thread not found in the requested mailbox");
		return c.json({ schemaVersion: 1, thread });
	});
	app.get("/:id/messages/:messageId", async (c) => {
		const query = parseQuery(c.req.query());
		const thread = (await loadThreads(c.get("coleoDir"), query.mailbox)).find((candidate) => candidate.id === c.req.param("id"));
		if (!thread) throw HttpError.notFound("Mail thread not found in the requested mailbox");
		let message;
		try { message = await readThreadMessage(c.get("coleoDir"), thread, c.req.param("messageId")); }
		catch { throw new HttpError(503, "Mail message source is unavailable"); }
		if (!message) throw HttpError.notFound("Message not found in this thread");
		return c.json({ schemaVersion: 1, threadId: thread.id, message });
	});
	app.post("/:id/selection", async (c) => {
		const input = await c.req.json().catch(() => { throw HttpError.badRequest("Branch selection must be valid JSON"); });
		const body = z.object({
			mailbox: z.enum(MESSAGING_MAILBOXES).default("inbox"), revision: z.string().min(1),
			branchIds: z.array(z.string().min(1)).min(1).max(200),
		}).strict().safeParse(input);
		if (!body.success) throw HttpError.badRequest(`Invalid branch selection: ${body.error.message}`);
		const thread = (await loadThreads(c.get("coleoDir"), body.data.mailbox)).find((candidate) => candidate.id === c.req.param("id"));
		if (!thread) throw HttpError.notFound("Mail thread not found in the requested mailbox");
		if (thread.revision !== body.data.revision) throw new HttpError(409, "Thread changed; reload before resolving this selection");
		const index = indexResourceHierarchy(thread.hierarchy);
		const ids = new Set<string>();
		for (const branchId of body.data.branchIds) {
			if (!index.byId.has(branchId)) throw HttpError.badRequest(`Branch is not part of this thread: ${branchId}`);
			for (const id of hierarchySubtreeIds(index, branchId)) if (index.byId.get(id)!.selectable) ids.add(id);
		}
		return c.json({ schemaVersion: 1, threadId: thread.id, revision: thread.revision, scope: "loaded-descendants",
			memberIds: index.preorder.filter((id) => ids.has(id)), complete: thread.hierarchy.complete,
			inboxMessageIds: [...new Set([...ids].flatMap((id) => index.byId.get(id)!.data.locations
				.filter((location) => location.mailbox === "inbox").map((location) => location.messageId)))],
		});
	});
	return app;
}
