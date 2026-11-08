import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Maildir } from "../../mail/maildir";
import { createInboxCatchupRoutes } from "../routes/inbox-catchup";
import { planCatalogueCatchup } from "../../brain/inbox-catchup-catalogue";
import { formatErrorResponse } from "../middleware/error";
import { createAuthMiddleware } from "../middleware/auth";
import { loadMailThreadDetail, loadMailThreadMailboxProjections } from "../mail-thread-projection";
import { lockCatchup, readCatchup, snapshotCatchup, writeCatchup, catchupDirectory } from "../../mail/inbox-catchup-store";
import type { CatchupModel } from "../../brain/inbox-catchup-model";
import type { CatchupJob } from "../../workbench/inbox-catchup";

let root: string;
let inbox: Maildir;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "coleo-catchup-test-"));
  inbox = new Maildir(join(root, "mail", "inbox")); await inbox.init();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const model: CatchupModel = async task => {
  if (task.startsWith("Propose")) return { threads: [{ title: "Unblock task 1", kind: "stale_claim",
    taskIds: [], bugIds: [], armIds: [], files: ["src/app.ts"], includes: "Task 1 file claim",
    excludes: "Other claims", resolves: "Claim released", reopens: "Claim reacquired" }] };
  return { context: "The arm has repeatedly been blocked by the same file claim.",
    action: "Please release the claim on src/app.ts for task 1." };
};
function appWith(analyst = model, effect = "open") {
  const app = new Hono();
  app.route("/inbox", createInboxCatchupRoutes({ coleoDir: root, planner: async (sources, progress) =>
    (await planCatalogueCatchup(sources, analyst, { progress, query: async request => ({
      model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id,
        question.type === "noul" ? { type: "noul", noul: 0 } : { type: "choice", choice: effect, confidence: 1,
          probabilities: Object.fromEntries(["unrelated", "open", "resolved", "reopened", "informational", "uncertain"].map(key => [key, key === effect ? 1 : 0])) }])),
    }) })).plan }));
  app.onError((error, c) => formatErrorResponse(c, error));
  return app;
}
async function message(subject = "Task 1 blocked") {
  return inbox.write({ from: "arm@coleo.local", to: "human@coleo.local", subject, body: "Please release src/app.ts", date: new Date(), headers: {} });
}
async function review(app: Hono): Promise<CatchupJob> {
  const response = await app.request("/inbox/catch-up", { method: "POST" });
  expect(response.status).toBe(202);
  const { job } = await response.json() as { job: CatchupJob };
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = (await readCatchup(root, job.id)).job;
    if (current.status !== "analyzing") return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Test catch-up did not finish");
}

test("reviews first, then archives originals and delivers an unread action with working source links", async () => {
  const originals = [await message(), await message()];
  const app = appWith();
  const job = await review(app);
  expect(job.status).toBe("review");
  expect((await inbox.list("new")).length).toBe(2);
  expect(await inbox.list("archive")).toEqual([]);
  expect(job.plan?.actions).toHaveLength(1);
  expect(job.archiveSubjects).toEqual(originals.map((_, index) => ({ sourceId: `source-${index}`, subject: "Task 1 blocked" })));
  expect((await readCatchup(root, job.id)).sources.every(source => source.body === "")).toBe(true);
  const response = await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" });
  expect(response.status).toBe(200);
  const fresh = await inbox.list("new");
  expect(fresh).toHaveLength(1);
  expect(fresh[0]?.flags.seen).toBe(false);
  expect(fresh[0]?.body).toContain("## What needs your attention");
  expect(fresh[0]?.body).toContain("2 unread messages were reviewed");
  expect(fresh[0]?.body).toContain("mailbox=archive&thread=");
  const threads = await loadMailThreadMailboxProjections(root);
  const summaryThread = threads.find(thread => thread.mailbox === "inbox")!;
  expect((await loadMailThreadDetail(root, "inbox", summaryThread.id))?.messages[0]?.catchupId).toBe(job.id);
  expect((await inbox.list("archive")).map(mail => mail.id).sort()).toEqual(originals.map(mail => mail.id).sort());
  expect((await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" })).status).toBe(200);
  expect(await inbox.list("new")).toHaveLength(1); // Idempotent apply never duplicates summaries.
});
test("new arrivals are not archived by an older review", async () => {
  await message(); const app = appWith(); const job = await review(app);
  const later = await message("New issue");
  expect((await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" })).status).toBe(200);
  expect((await inbox.list("new")).some(mail => mail.id === later.id)).toBe(true);
});
test("Apply leaves uncertain originals byte-for-byte untouched and links retained evidence in inbox", async () => {
  await message("Confident source");
  const retained = await message("Uncertain source");
  const before = await readFile(retained.filePath!, "utf8");
  const app = appWith(); const job = await review(app);
  const stored = await readCatchup(root, job.id);
  const keep = stored.sources.find(source => source.messageId === retained.id)!;
  stored.job.plan!.archiveSourceIds = stored.job.plan!.archiveSourceIds!.filter(id => id !== keep.id);
  stored.job.plan!.retainedSources = [{ sourceId: keep.id, reason: "Uncertain assignment" }];
  await writeCatchup(root, stored);
  expect((await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" })).status).toBe(200);
  expect(await readFile(retained.filePath!, "utf8")).toBe(before);
  expect((await inbox.list("new")).find(mail => mail.id === retained.id)?.flags.seen).toBe(false);
  expect(await inbox.list("archive")).toHaveLength(1);
  const summary = (await inbox.list("new")).find(mail => mail.id !== retained.id)!;
  expect(summary.body).toContain("mailbox=inbox&thread=");
  expect(summary.body).toContain("mailbox=archive&thread=");
});
test("older reviews without explicit archive decisions cannot be applied", async () => {
  await message(); const app = appWith(); const job = await review(app);
  const stored = await readCatchup(root, job.id); delete stored.job.plan!.applyPolicyVersion;
  await writeCatchup(root, stored);
  expect((await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" })).status).toBe(409);
  expect(await inbox.list("archive")).toHaveLength(0);
});
test("a real action can be created while every uncertain original remains in inbox", async () => {
  const original = await message(); const before = await readFile(original.filePath!, "utf8");
  const app = appWith(); const job = await review(app);
  const stored = await readCatchup(root, job.id);
  stored.job.plan!.archiveSourceIds = [];
  stored.job.plan!.retainedSources = stored.sources.filter(source => source.unread).map(source => ({ sourceId: source.id, reason: "Retain original" }));
  await writeCatchup(root, stored);
  expect((await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" })).status).toBe(200);
  expect(await readFile(original.filePath!, "utf8")).toBe(before);
  expect(await inbox.list("new")).toHaveLength(2);
  expect(await inbox.list("archive")).toHaveLength(0);
});
test("reading a source after review invalidates apply without archiving anything", async () => {
  const original = await message(); const app = appWith(); const job = await review(app);
  await inbox.markSeen(original.id);
  expect((await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" })).status).toBe(409);
  expect(await inbox.list("archive")).toEqual([]);
  expect(await inbox.list("cur")).toHaveLength(1);
});
test("editing a message after review invalidates the entire archival", async () => {
  const original = await message(); const app = appWith(); const job = await review(app);
  await writeFile(original.filePath!, (await readFile(original.filePath!, "utf8")).replace("Please release", "Already released"));
  expect((await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" })).status).toBe(409);
  expect(await inbox.list("archive")).toEqual([]);
  expect(await inbox.list("new")).toHaveLength(1);
});
test("the catch-up endpoints respect API authentication", async () => {
  const app = new Hono();
  app.use("/inbox/*", createAuthMiddleware("test-key"));
  app.route("/inbox", createInboxCatchupRoutes({ coleoDir: root, model }));
  expect((await app.request("/inbox/catch-up", { method: "POST" })).status).toBe(401);
  expect((await app.request("/inbox/catch-up")).status).toBe(401);
  expect((await app.request("/inbox/catch-up", { headers: { "X-API-Key": "test-key" } })).status).toBe(200);
});
test("an empty inbox does not make any model calls", async () => {
  const app = appWith(async () => { throw new Error("Unexpected model call"); });
  const job = await review(app);
  expect(job.status).toBe("review");
  expect(job.unreadCount).toBe(0);
  const latest = await app.request("/inbox/catch-up");
  expect((await latest.json() as { job: CatchupJob }).job.id).toBe(job.id);
});
test("a provider failure leaves every source unread and untouched", async () => {
  await message();
  const job = await review(appWith(async () => { throw new Error("Provider unavailable"); }));
  expect(job.status).toBe("failed");
  expect(job.error).toContain("Provider unavailable");
  expect(await inbox.list("new")).toHaveLength(1);
  expect(await inbox.list("archive")).toEqual([]);
});
test("persistent schema errors identify the stage without archiving originals", async () => {
  await message();
  const job = await review(appWith(async () => ({ topics: [{ identity: "topic", title: "topic", events: [], extra: "metadata" }] })));
  expect(job.status).toBe("failed");
  expect(job.error).toContain("response failed validation");
  expect(await inbox.list("new")).toHaveLength(1);
  expect(await inbox.list("archive")).toEqual([]);
});
test("existing reviews gain archive subject lists without another analysis", async () => {
  await message("Original question");
  const app = appWith(); const job = await review(app);
  const stored = await readCatchup(root, job.id);
  delete stored.job.archiveSubjects;
  await writeCatchup(root, stored);
  const response = await app.request("/inbox/catch-up");
  const result = await response.json() as { job: CatchupJob };
  expect(result.job.status).toBe("review");
  expect(result.job.archiveSubjects).toEqual([{ sourceId: "source-0", subject: "Original question" }]);
});
test("resolved topics archive originals without manufacturing an action item", async () => {
  await message();
  const app = appWith(model, "resolved"); const job = await review(app);
  expect(job.plan?.resolvedTopics).toBe(1);
  expect((await app.request(`/inbox/catch-up/${job.id}/apply`, { method: "POST" })).status).toBe(200);
  expect(await inbox.list("new")).toEqual([]);
  expect(await inbox.list("archive")).toHaveLength(1);
});
test("a persisted mailbox lock prevents concurrent catch-ups", async () => {
  const id = crypto.randomUUID();
  const release = await lockCatchup(root, id);
  try { expect((await appWith().request("/inbox/catch-up", { method: "POST" })).status).toBe(409); }
  finally { await release(); }
});
test("an interrupted apply is rolled back from its journal before another catch-up starts", async () => {
  const original = await message();
  const sources = await snapshotCatchup(root);
  const id = crypto.randomUUID();
  const directory = catchupDirectory(root); await mkdir(directory, { recursive: true });
  const destination = join(root, "mail", "inbox", "archive", "interrupted", basename(original.filePath!));
  await mkdir(join(root, "mail", "inbox", "archive", "interrupted"), { recursive: true });
  await writeCatchup(root, { job: { id, status: "applying", detail: "Interrupted", startedAt: new Date().toISOString(), unreadCount: 1 },
    sources, moves: [{ from: original.filePath!, to: destination }] });
  await rename(original.filePath!, destination);
  await writeFile(join(directory, "active.lock"), JSON.stringify({ pid: 2147483647, id }));
  const release = await lockCatchup(root, crypto.randomUUID()); await release();
  expect(await readFile(original.filePath!, "utf8")).toContain("Please release");
  expect((await readCatchup(root, id)).job.status).toBe("failed");
  expect(await inbox.list("archive")).toEqual([]);
});
test("includes later read, archived, and sent evidence without marking those messages for archival", async () => {
  await message();
  const later = await message("Resolved"); await inbox.markSeen(later.id);
  const archived = await message("Already handled"); await inbox.archive(archived.id);
  const sent = new Maildir(join(root, "mail", "sent")); await sent.init();
  await sent.write({ from: "human@coleo.local", to: "arm@coleo.local", date: new Date(), subject: "I released it", body: "Released", headers: {} });
  const snapshot = await snapshotCatchup(root);
  expect(snapshot.filter(source => source.unread)).toHaveLength(1);
  expect(new Set(snapshot.map(source => source.mailbox))).toEqual(new Set(["inbox", "archive", "sent"]));
});
