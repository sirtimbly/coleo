import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { initDatabase } from "../../db";
import { writeThreadFixture } from "../../scripts/workbench-demo/thread-fixture-api";
import { loadMessagingCollection } from "../../api/messaging-collection";
import { formatErrorResponse } from "../../api/middleware/error";
import { createWorkbenchInboxRoutes } from "../../api/routes/workbench-inbox";
import { createWorkbenchNamedViewRoutes } from "../../api/routes/workbench-named-views";
import { createMailThreadRoutes } from "../../api/routes/mail-threads";
import { createWorkbenchAttentionRoutes } from "../../api/routes/workbench-attention";
import { createTestEventStore } from "../../nats/in-memory-event-store";
import { getNamedResourceView, resolveNamedResourceView } from "../../workbench/named-resource-views";
import { normalizeMessagingQuery, messagingQueryIdentity } from "../../workbench/messaging-query";
import { runInboxCommand } from "../commands/inbox";
import { InboxApi } from "../inbox/api";
import { inboxHelp, parseInboxOptions } from "../inbox/options";
import { terminalText } from "../inbox/snapshot";
import { inboxReference } from "../inbox/references";

import type { Database } from "bun:sqlite";
import type { InboxSnapshot } from "../inbox/snapshot";
import type { InboxFetch } from "../inbox/api";

const builtin = getNamedResourceView("inbox-triage", "cli")!;

describe("definition-driven Inbox flags", () => {
	it("normalizes browser-equivalent queries and applies mailbox/category scope transitions independent of flag order", () => {
		const options = parseInboxOptions(["--sort", "asc", "-s", "  ReView  ", "--mailbox", "archive", "--limit", "3"], builtin);
		expect(options.query).toEqual(normalizeMessagingQuery({ ...builtin.definition.query, facet: "messages", mailbox: "archive", search: "review", sort: { field: "timestamp", direction: "asc" }, limit: 3 }));
		expect(parseInboxOptions(["--brain-category", "operations"], builtin).query).toMatchObject({ facet: "brain", brainCategory: "operations" });
		for (const args of [["--facet", "brain", "--mailbox", "archive"], ["--mailbox", "archive", "--facet", "brain"]]) expect(() => parseInboxOptions(args, builtin)).toThrow("messages facet");
	});
	it("uses resolved aliases, inherited filters, fields, and command names instead of a second hard-coded flag table", () => {
		const view = resolveNamedResourceView({ ...builtin.definition, query: { ...builtin.definition.query, filters: [{ field: "unread", operator: "equals", value: true }] },
			interactions: [{ id: "search", operation: "collection.search", cli: { flag: "--find", alias: "-f" } },
				{ id: "open", operation: "collection.open", cli: { subcommand: "inspect" } }] }, "cli");
		const options = parseInboxOptions(["inspect", "thread:inbox:review", "-f", "API"], view);
		expect(options.query.filters).toEqual([{ field: "unread", operator: "equals", value: true }]);
		expect(options.query.search).toBe("api");
		expect(options.command?.operation).toBe("collection.open");
		expect(inboxHelp(view)).toContain("--find, -f");
		expect(() => parseInboxOptions(["--search", "API"], view)).toThrow("Unknown Inbox option");
	});
	it("rejects invalid values, duplicated aliases, unknown flags, and flags reserved by the host", () => {
		for (const args of [["--limit", "0"], ["--limit", "201"], ["--limit", "3oops"], ["--sort", "newest"], ["--search"],
			["--search", "one", "-s", "two"], ["--pages", "101"], ["--json=true"], ["--unknown"], ["show"], ["mark-read"]]) {
			expect(() => parseInboxOptions(args, builtin)).toThrow();
		}
		const view = resolveNamedResourceView({ ...builtin.definition, interactions: [{ id: "search", operation: "collection.search", cli: { flag: "--json" } }] }, "cli");
		expect(() => parseInboxOptions([], view)).toThrow("reserved Inbox option");
	});
});

describe("Inbox CLI through the actual API routes", () => {
	let directory: string, db: Database, app: Hono<{ Variables: { db: Database; coleoDir: string } }>;
	let requests: Request[];
	let intercept: InboxFetch | undefined;
	let api: InboxApi;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "coleo-cli-inbox-"));
		db = await initDatabase(":memory:");
		await writeThreadFixture(directory);
		const service = new Hono<{ Variables: { db: Database; coleoDir: string } }>();
		service.use("*", async (c, next) => { c.set("db", db); c.set("coleoDir", directory); await next(); });
		service.onError((error, c) => formatErrorResponse(c, error));
		service.route("/api/workbench/named-views", createWorkbenchNamedViewRoutes());
		service.route("/api/workbench/inbox", createWorkbenchInboxRoutes({ coleoDir: directory, referenceDependencies: { store: createTestEventStore() } }));
		service.route("/api/workbench/attention", createWorkbenchAttentionRoutes());
		service.route("/api/mail/threads", createMailThreadRoutes());
		app = service;
		requests = []; intercept = undefined;
		api = new InboxApi({ apiUrl: "http://fixture", headers: { "X-API-Key": "test-key", "Content-Type": "application/json" } }, async (url, init) => {
			requests.push(new Request(url, init));
			return intercept ? intercept(url, init) : app.request(new Request(url, init));
		});
	});
	afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
	async function run(args: string[]): Promise<{ code: number; output: string; errors: string }> {
		const output: string[] = [], errors: string[] = [];
		const code = await runInboxCommand(args, api, { stdout: (text) => output.push(text), stderr: (text) => errors.push(text) });
		return { code, output: output.join("\n"), errors: errors.join("\n") };
	}
	it("prints JSON with the same query/items as the API and pages roots while retaining reply ancestry", async () => {
		const result = await run(["--facet", "messages", "--limit", "1", "--pages", "2", "--tree", "--json"]);
		expect(result.code).toBe(0);
		const snapshot = JSON.parse(result.output) as InboxSnapshot;
		expect(snapshot.items.map((item) => item.id)).toEqual(["thread:inbox:review", "thread:inbox:handoff"]);
		expect(snapshot.traversal).toMatchObject({ loadedPages: 2, requestedPages: 2, exhausted: true, nextCursor: null });
		expect(snapshot.rows.find((row) => row.id === "message:<review-api-check@example.test>")?.parentId).toBe("message:<review-api@example.test>");
		expect(snapshot.rows[0]?.values).toMatchObject({ title: "Can we review the delivery blueprint?", source: "Inbox · 5 messages" });
		const direct = await loadMessagingCollection(db, directory, snapshot.query, undefined, { store: createTestEventStore() });
		expect(snapshot.pages[0]?.items).toEqual(direct.items);
		expect(snapshot.pages[0]?.queryId).toBe(messagingQueryIdentity(snapshot.query));
		expect(requests.every((request) => request.headers.get("X-API-Key") === "test-key")).toBe(true);
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/api/workbench/named-views/inbox-triage", "/api/workbench/inbox", "/api/workbench/inbox"]);
		expect(result.output).not.toContain("test-key");
	});
	it("prints text scope/freshness, declared field order, renderer fallback, and an opaque continuation", async () => {
		const result = await run(["--mailbox", "inbox", "--limit", "1", "--presentation", "timeline"]);
		expect(result.code).toBe(0);
		expect(result.output).toContain("Messages / inbox");
		expect(result.output).toContain("Sources: mail: fresh");
		expect(result.output).toContain("Using collection.list instead of messaging.timeline");
		expect(result.output).not.toMatch(/Ref\s+Subject\s+Preview\s+When/);
		expect(result.output).toContain("Collapsing a branch");
		expect(result.output).not.toContain("thread:inbox:review");
		expect(result.output).toContain("next cursor");
	});
	it("supports folded tree snapshots and the same optional metadata summary without changing query identity", async () => {
		const result = await run(["--facet", "messages", "--expand", "collapsed", "--metadata", "overview", "--json"]);
		expect(result.code).toBe(0);
		const snapshot = JSON.parse(result.output) as InboxSnapshot;
		expect(snapshot.rows).toHaveLength(2);
		expect(snapshot.metadata.find((value) => value.field === "unread")?.scope).toBe("query");
		expect(snapshot.metadata.find((value) => value.field === "timestamp")?.scope).toBe("loaded-window");
		expect(snapshot.query).toEqual(normalizeMessagingQuery({ ...builtin.definition.query, facet: "messages" }));
	});
	it("forces ANSI for styled text without contaminating JSON", async () => {
		const styled = await run(["--facet", "messages", "--limit", "1", "--presentation", "cards", "--color", "always"]);
		expect(styled.code).toBe(0);
		expect(styled.output).toContain("\x1b[");
		const json = await run(["--facet", "messages", "--limit", "1", "--presentation", "cards", "--color", "always", "--json"]);
		expect(json.code).toBe(0);
		expect(json.output).not.toContain("\x1b[");
		expect(JSON.parse(json.output).presentation.id).toBe("cards");
	});
	it("labels an unavailable source as partial, exits 2, and stops traversal instead of printing an empty Inbox", async () => {
		intercept = async (url, init) => {
			if (!new URL(url).pathname.endsWith("/inbox")) return app.request(new Request(url, init));
			const query = normalizeMessagingQuery(JSON.parse(new URL(url).searchParams.get("query")!));
			const page = await loadMessagingCollection(db, directory, query, undefined, { loadMail: async () => { throw new Error("offline"); } });
			return Response.json(page);
		};
		const result = await run(["--facet", "messages", "--pages", "3"]);
		expect(result.code).toBe(2);
		expect(result.output).toContain("INCOMPLETE SOURCES");
		expect(result.output).toContain("not an empty Inbox");
		expect(result.output).not.toContain("Nothing in this view");
		expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/inbox"))).toHaveLength(1);
	});
	it("rejects legacy envelopes, wrong-query pages, bad cursors, and unknown views as errors with machine-readable output", async () => {
		for (const value of [{ items: [], nextCursor: null }, { schemaVersion: 1, queryId: "wrong" }]) {
			intercept = async (url, init) => new URL(url).pathname.endsWith("/inbox") ? Response.json(value) : app.request(new Request(url, init));
			const result = await run(["--facet", "messages", "--json"]);
			expect(result.code).toBe(1);
			expect(JSON.parse(result.output).kind).toBe("inbox.error");
		}
		intercept = undefined;
		expect((await run(["--facet", "messages", "--cursor", "invalid", "--json"])).code).toBe(1);
		expect((await run(["--view", "missing", "--json"])).code).toBe(1);
	});
	it("inspects full thread detail without marking messages read", async () => {
		const result = await run(["show", "thread:inbox:review", "--facet", "messages", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.output).detail.thread.messageCount).toBe(5);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});
	it("resolves stable compact references for inspection and read actions within the loaded window", async () => {
		const detail = await run(["show", inboxReference("thread:inbox:review"), "--facet", "messages", "--json"]);
		expect(detail.code).toBe(0);
		expect(JSON.parse(detail.output).detail.thread.id).toBe("review");
		expect(JSON.parse(detail.output).id).toBe("thread:inbox:review");
		const action = await run(["mark-read", inboxReference("message:<review-api@example.test>"), "--facet", "messages", "--json"]);
		expect(action.code).toBe(0);
		expect(JSON.parse(action.output).result.selectedMemberIds).toEqual(["message:<review-api@example.test>"]);
	});
	it("show resolves a read conversation outside the default attention page without repeating filters", async () => {
		const result = await run(["show", inboxReference("thread:inbox:handoff"), "--limit", "1", "--search", "does-not-match", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.output).id).toBe("thread:inbox:handoff");
		expect(JSON.parse(result.output).detail.thread.subject).toBe("Handoff notes for the terminal rewrite");
		expect(requests.some((request) => new URL(request.url).pathname === "/api/workbench/inbox")).toBe(false);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});
	it("show resolves sent-mail and nested-message references independently of the selected mailbox", async () => {
		const sent = await run(["show", inboxReference("thread:sent:handoff"), "--json"]);
		expect(sent.code).toBe(0);
		expect(JSON.parse(sent.output).detail.thread.mailbox).toBe("sent");
		const member = await run(["show", inboxReference("message:<handoff-cli@example.test>"), "--json"]);
		expect(member.code).toBe(0);
		expect(JSON.parse(member.output).detail.message.subject).toBe("CLI handoff: export the tree");
	});
	it("broader read-only reference resolution does not widen mark-read selections", async () => {
		const result = await run(["mark-read", inboxReference("thread:inbox:handoff"), "--facet", "messages", "--search", "does-not-match", "--limit", "1", "--json"]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.output).error).toContain("Read selection is not loaded");
		expect(requests.some((request) => request.method === "POST")).toBe(false);
	});
	it("marks exactly one selected nested member, leaves its sibling unread, and refreshes once after the write", async () => {
		const result = await run(["mark-read", "message:<review-api@example.test>", "--facet", "messages", "--json"]);
		expect(result.code).toBe(0);
		const output = JSON.parse(result.output);
		expect(output.result.completedMessageIds).toEqual(["review-api"]);
		const write = requests.find((request) => request.method === "POST")!;
		expect(await write.clone().json()).toMatchObject({ memberIds: ["message:<review-api@example.test>"], action: "read" });
		expect(output.refreshed.items[0].thread.hierarchy.nodes.find((node: { id: string }) => node.id === "message:<review-api@example.test>").data.unread).toBe(false);
		expect(output.refreshed.items[0].thread.hierarchy.nodes.find((node: { id: string }) => node.id === "message:<review-api-check@example.test>").data.unread).toBe(true);
		expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/inbox"))).toHaveLength(2);
	});
	it("prevalidates foreign IDs before writes and preserves a stale-revision failure without retrying", async () => {
		expect((await run(["mark-read", "message:<review-api@example.test>", "foreign", "--facet", "messages", "--json"])).code).toBe(1);
		expect(requests.some((request) => request.method === "POST")).toBe(false);
		requests = [];
		intercept = async (url, init) => init.method === "POST" ? Response.json({ error: "Thread changed; reload before acting" }, { status: 409 }) : app.request(new Request(url, init));
		const result = await run(["mark-read", "message:<review-api@example.test>", "--facet", "messages", "--json"]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.output).result.error).toContain("Thread changed");
		expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
	});
	it("a loaded-branch action selects exactly its descendants and never its sibling branch", async () => {
		const result = await run(["mark-read", "message:<review-api@example.test>", "--branch", "--facet", "messages", "--json"]);
		expect(result.code).toBe(0);
		const write = requests.find((request) => request.method === "POST")!;
		expect((await write.clone().json()).memberIds).toEqual(["message:<review-api@example.test>", "message:<review-api-check@example.test>"]);
		expect(JSON.parse(result.output).result.completedMessageIds).toEqual(["review-api", "review-api-check"]);
		expect(JSON.parse(result.output).result.selectedMemberIds).toEqual(["message:<review-api@example.test>", "message:<review-api-check@example.test>"]);
	});
	it("reports successful writes separately when the post-action refresh fails", async () => {
		let reads = 0;
		intercept = async (url, init) => {
			if (new URL(url).pathname.endsWith("/inbox") && ++reads > 1) return Response.json({ error: "refresh offline" }, { status: 503 });
			return app.request(new Request(url, init));
		};
		const result = await run(["mark-read", "message:<review-api@example.test>", "--facet", "messages", "--json"]);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.output).result.completedMessageIds).toEqual(["review-api"]);
		expect(JSON.parse(result.output).refreshError).toBe("refresh offline");
		expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
	});
	it("validates a local JSON view without contacting the API", async () => {
		const path = join(directory, "view.json");
		await Bun.write(path, JSON.stringify(builtin.definition));
		const result = await run(["validate", path, "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.output).definition.id).toBe("inbox-triage");
		expect(requests).toHaveLength(0);
	});
	it("the retired CLI entrypoint names the client without HTTP reads or local database initialization", async () => {
		const paths: string[] = [];
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
			paths.push(new URL(request.url).pathname); return app.fetch(request);
		} });
		const process = Bun.spawn(["bun", "run", new URL("../index.ts", import.meta.url).pathname, "inbox", "--facet", "messages", "--limit", "1", "--json"], {
			cwd: directory, env: { ...globalThis.process.env, COLEO_DIR: directory, COLEO_API_URL: server.url.href.replace(/\/$/, ""), COLEO_API_KEY: "test-key" }, stdout: "pipe", stderr: "pipe",
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const output = new Response(process.stdout).text();
			const errors = new Response(process.stderr).text();
			const exit = await Promise.race([process.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Snapshot CLI did not exit")), 10_000); })]);
			expect(exit).toBe(1);
			expect(await output).toBe("");
			const diagnostic = await errors;
			expect(diagnostic).not.toContain("test-key");
			expect(diagnostic).toContain("coleo-client inbox");
			expect(paths).toEqual([]);
			expect(await Bun.file(join(directory, "coleo.db")).exists()).toBe(false);
		} finally { clearTimeout(timer); process.kill(); server.stop(true); }
	});
	it("generates help from the API and provides explicit bundled help when the API is offline", async () => {
		const help = await run(["--help"]);
		expect(help.code).toBe(0);
		expect(help.output).toContain("--brain-category");
		expect(requests).toHaveLength(1);
		intercept = async () => { throw new Error("offline"); };
		const offline = await run(["--help"]);
		expect(offline.code).toBe(0);
		expect(offline.errors).toContain("bundled");
		expect((await run(["--json"])).code).toBe(1);
	});
});

it("sanitizes terminal control sequences without changing JSON source data", () => {
	expect(terminalText("\x1b[31mred\x1b[0m\nline")).toBe("red line");
});
