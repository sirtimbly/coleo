import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile, access } from "node:fs/promises";
import { basename, join } from "node:path";
import { Maildir } from "./maildir";
import { loadMailThreadMailboxProjections } from "../api/mail-thread-projection";
import { catchupFactsFingerprint, readCatchupFacts } from "../brain/inbox-catchup-facts";
import type { MailMessage } from "./maildir";
import type { CatchupSource } from "../workbench/inbox-catchup";
import type { CatchupJob } from "../workbench/inbox-catchup";
export type { CatchupJob } from "../workbench/inbox-catchup";

export interface CatchupSnapshot extends CatchupSource {
  messageId: string; path: string; hash: string;
}
interface Move { from: string; to: string }
interface StoredJob {
  job: CatchupJob; sources: CatchupSnapshot[]; moves: Move[];
}

export const catchupDirectory = (root: string): string => join(root, "inbox-catchup");
const hash = (content: string): string => createHash("sha256").update(content).digest("hex");
const fingerprint = (message: MailMessage): string => hash(JSON.stringify({ from: message.from, to: message.to,
  subject: message.subject, date: message.date.toISOString(), body: message.body, headers: message.headers }));
const exists = async (path: string): Promise<boolean> => access(path).then(() => true, error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  throw error;
});

export async function writeCatchup(root: string, stored: StoredJob): Promise<void> {
  const path = join(catchupDirectory(root), `${stored.job.id}.json`);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  // Recovery needs paths/fingerprints, not a second persisted copy of mail bodies.
  // Interrupted analysis is restarted rather than resumed from lossy context.
  await writeFile(temp, JSON.stringify({ ...stored, sources: stored.sources.map(source => ({ ...source, body: "" })) }), { mode: 0o600 });
  await rename(temp, path);
  if (stored.job.status === "recovery_required") {
    await writeFile(join(catchupDirectory(root), "recovery.json"), JSON.stringify({ id: stored.job.id }), { mode: 0o600 });
  }
}
export async function readCatchup(root: string, id: string): Promise<StoredJob> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid catch-up ID");
  return JSON.parse(await readFile(join(catchupDirectory(root), `${id}.json`), "utf8")) as StoredJob;
}

/** On restart, roll back an interrupted apply before allowing another run. */
async function rollback(stored: StoredJob): Promise<void> {
  for (const move of [...stored.moves].reverse()) {
    const [fromExists, toExists] = await Promise.all([exists(move.from), exists(move.to)]);
    if (toExists && !fromExists) await rename(move.to, move.from);
    else if (toExists || !fromExists) throw new Error("Catch-up recovery needs attention: a message moved during rollback. No files were deleted.");
  }
  stored.moves = [];
}

/** Filesystem lock spans analysis/apply and other API processes sharing this runtime. */
export async function lockCatchup(root: string, id: string): Promise<() => Promise<void>> {
  const directory = catchupDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "active.lock");
  const acquire = () => open(path, "wx", 0o600);
  let lock;
  try { lock = await acquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Serialize stale-owner recovery too: two API processes must not roll back
    // the same journal or remove each other's newly acquired lock.
    const recoveryLockPath = join(directory, "recovering.lock");
    const recoveryLock = await open(recoveryLockPath, "wx", 0o600).catch(() => {
      throw new Error("Catch-up recovery is already in progress. If recovery was interrupted, inspect recovering.lock before retrying.");
    });
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as { pid: number; id: string };
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (alive) throw new Error(`Catch-up ${owner.id} is already running. Wait for it to finish.`);
      let interrupted: StoredJob | undefined;
      try { interrupted = await readCatchup(root, owner.id); }
      catch (failure) {
        // No persisted intent means there cannot have been mailbox moves.
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
      if (interrupted) {
        try {
          if (["applying", "recovery_required"].includes(interrupted.job.status)) await rollback(interrupted);
          if (interrupted.job.status !== "completed") {
            interrupted.job.status = "failed";
            interrupted.job.error = "The API restarted during catch-up. Originals were preserved; start a new review.";
          }
        } catch (failure) {
          interrupted.job.status = "recovery_required";
          interrupted.job.error = failure instanceof Error ? failure.message : "Catch-up recovery failed";
          await writeCatchup(root, interrupted);
          throw failure;
        }
        await writeCatchup(root, interrupted);
      }
      await unlink(path);
      lock = await acquire();
    } finally { await recoveryLock.close(); await unlink(recoveryLockPath); }
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, id }));
  const recoveryPath = join(directory, "recovery.json");
  try {
    if (await exists(recoveryPath)) {
      const recovery = JSON.parse(await readFile(recoveryPath, "utf8")) as { id: string };
      const stored = await readCatchup(root, recovery.id);
      await rollback(stored);
      stored.job.status = "failed";
      stored.job.error = "Interrupted changes were recovered. Start a new catch-up review.";
      await writeCatchup(root, stored);
      await unlink(recoveryPath);
    }
  } catch (error) { await lock.close(); await unlink(path); throw error; }
  return async () => { await lock.close(); await unlink(path); };
}

export async function recoverInterruptedCatchup(root: string, job: CatchupJob): Promise<CatchupJob> {
  if (!["analyzing", "applying", "recovery_required"].includes(job.status)) return job;
  try {
    const owner = JSON.parse(await readFile(join(catchupDirectory(root), "active.lock"), "utf8")) as { pid: number };
    try { process.kill(owner.pid, 0); return job; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return job; }
    const release = await lockCatchup(root, job.id);
    await release();
    return (await readCatchup(root, job.id)).job;
  } catch { return job; } // Keep a recovery-required job visible; never report false success.
}

export async function snapshotCatchup(root: string): Promise<CatchupSnapshot[]> {
  const inbox = new Maildir(join(root, "mail", "inbox"));
  const sent = new Maildir(join(root, "mail", "sent"));
  const [fresh, read, sentNew, sentRead, archived] = await Promise.all([
    inbox.list("new", { strict: true }), inbox.list("cur", { strict: true }),
    sent.list("new", { strict: true }), sent.list("cur", { strict: true }),
    inbox.list("archive", { strict: true }),
  ]);
  const unread = [...fresh, ...read].filter(message => !message.flags.seen && !message.flags.trashed);
  if (!unread.length) return [];
  const oldest = unread.reduce((min, message) => Math.min(min, message.date.getTime()), Infinity);
  const entries: Array<{ message: MailMessage; mailbox: "inbox" | "sent" | "archive"; unread: boolean }> = [
    ...[...fresh, ...read].filter(message => !message.flags.trashed && message.date.getTime() >= oldest)
      .map(message => ({ message, mailbox: "inbox" as const, unread: !message.flags.seen })),
    ...[...sentNew, ...sentRead].filter(message => !message.flags.trashed && message.date.getTime() >= oldest)
      .map(message => ({ message, mailbox: "sent" as const, unread: false })),
    ...archived.filter(message => !message.flags.trashed && message.date.getTime() >= oldest)
      .map(message => ({ message, mailbox: "archive" as const, unread: false })),
  ];
  entries.sort((a, b) => a.message.date.getTime() - b.message.date.getTime() || a.message.id.localeCompare(b.message.id));
  return entries.map(({ message, mailbox, unread }, index) => ({
    id: `source-${index}`, from: message.from, subject: message.subject, body: message.body,
    headers: Object.fromEntries(Object.entries(message.headers).filter(([key]) =>
      /^(message-id|in-reply-to|references|x-coleo-(task|arm|bug|request|thread)-id)$/i.test(key))),
    timestamp: message.date.toISOString(), mailbox, unread, messageId: message.id,
    path: message.filePath!, hash: fingerprint(message),
  }));
}

const plain = (text: string): string => text.replace(/[\r\n]/g, " ");
const markdownLabel = (text: string): string => plain(text).replace(/[\[\]\\]/g, "");

/** Optimistic snapshot check + durable rename journal; archives, never deletes. */
export async function applyCatchup(root: string, stored: StoredJob): Promise<void> {
  const { job, sources } = stored;
  if (job.status !== "review" || !job.plan) throw new Error("This catch-up is not ready to apply.");
  const unread = sources.filter(source => source.unread);
  const { archiveSourceIds, retainedSources } = job.plan;
  if (job.plan.applyPolicyVersion !== 2 || !Array.isArray(archiveSourceIds) || !Array.isArray(retainedSources)) {
    throw new Error("This older review lacks safe archive decisions. Start a fresh review; nothing was archived.");
  }
  const unreadIds = new Set(unread.map(source => source.id));
  const archiveIds = new Set(archiveSourceIds);
  const retainedIds = new Set(retainedSources.map(source => source.sourceId));
  if (archiveIds.size !== archiveSourceIds.length || retainedIds.size !== retainedSources.length
    || [...archiveIds].some(id => !unreadIds.has(id) || retainedIds.has(id))
    || [...retainedIds].some(id => !unreadIds.has(id)) || archiveIds.size + retainedIds.size !== unreadIds.size) {
    throw new Error("Invalid archive/retain decisions; nothing was archived.");
  }
  const represented = new Set([...job.plan.actions, ...job.plan.closedTopics ?? []].flatMap(topic => topic.sourceIds));
  if ([...archiveIds].some(id => !represented.has(id)) || job.plan.actions.some(action =>
    !action.sourceIds.length || action.sourceIds.some(id => !sources.some(source => source.id === id))
    || !action.sourceIds.some(id => archiveIds.has(id) || retainedIds.has(id)))) {
    throw new Error("Catch-up source coverage is invalid; nothing was archived.");
  }
  const originals = unread.filter(source => archiveIds.has(source.id));
  // A person reading/archiving/editing a source invalidates the entire plan.
  const inbox = new Maildir(join(root, "mail", "inbox"));
  const currentSources: CatchupSnapshot[] = [];
  for (const source of sources) {
    const message = await inbox.read(source.path);
    if (fingerprint(message) !== source.hash) throw new Error("Inbox changed during review. Start Catch me up again; nothing was archived.");
    currentSources.push({ ...source, body: message.body });
  }
  if (job.plan.factsFingerprint && catchupFactsFingerprint(readCatchupFacts(root, currentSources)) !== job.plan.factsFingerprint) {
    throw new Error("System state changed during review. Start Catch me up again; nothing was archived.");
  }
  const archive = join(root, "mail", "inbox", "archive", `catchup-${job.id}`);
  await mkdir(archive, { recursive: true });
  const staging = new Maildir(join(catchupDirectory(root), job.id));
  await staging.init();
  stored.moves = originals.map(source => ({ from: source.path, to: join(archive, basename(source.path)) }));
  if (new Set(stored.moves.map(move => move.to)).size !== stored.moves.length) {
    throw new Error("Duplicate inbox storage identities; no messages were archived.");
  }
  job.status = "applying"; job.detail = "Archiving originals and delivering focused action items";
  await writeCatchup(root, stored);
  try {
    for (const move of stored.moves) await rename(move.from, move.to);
    const threads = await loadMailThreadMailboxProjections(root);
    const sourceLink = (source: CatchupSnapshot): string => {
      const mailbox = archiveIds.has(source.id) ? "archive" : source.mailbox;
      const thread = threads.find(candidate => candidate.mailbox === mailbox && candidate.hierarchy.nodes.some(node =>
        node.data.locations.some(location => location.messageId === source.messageId && location.mailbox === mailbox)));
      if (!thread) throw new Error("Could not link an original message; consolidation was rolled back.");
      return `/messaging?facet=messages&mailbox=${mailbox}&thread=${encodeURIComponent(thread.id)}&message=${encodeURIComponent(source.messageId)}`;
    };
    for (const action of job.plan.actions) {
      const evidence = action.sourceIds.map(id => sources.find(source => source.id === id)!);
      const reports = evidence.filter(source => source.unread).length;
      const archivedReports = evidence.filter(source => archiveIds.has(source.id)).length;
      const retainedReports = evidence.filter(source => source.unread && retainedIds.has(source.id)).length;
      const body = ["## What needs your attention", action.action, "", "## Context", action.context, "",
        "## Why you are seeing this", `${reports} unread ${reports === 1 ? "message was" : "messages were"} reviewed for this action. It still needs human attention. ${archivedReports} originals were archived, never deleted; ${retainedReports} uncertain originals remain in your inbox.`,
        "", "## Original messages", ...evidence.map(source => `- [${markdownLabel(source.subject || "Untitled message")}](${sourceLink(source)}) — ${plain(source.from)}, ${source.timestamp}`),
        "", "_Prepared by the Brain from a snapshot of your inbox. New messages arriving during the review were left untouched._"].join("\n\n");
      const message = await staging.write({ from: "Coleo Brain <brain@coleo.local>", to: "Human <human@coleo.local>",
        subject: plain(`Action needed: ${action.title}`), date: new Date(), body,
        headers: { "X-Coleo-Catchup-ID": job.id, "X-Coleo-Requires-Action": "true" } });
      const move = { from: message.filePath!, to: join(root, "mail", "inbox", "new", basename(message.filePath!)) };
      stored.moves.push(move);
      await writeCatchup(root, stored); // Record intent before exposing each new message.
      await rename(move.from, move.to);
    }
    job.archivedCount = originals.length;
    job.status = "completed"; job.detail = "Inbox caught up";
    await writeCatchup(root, stored);
  } catch (error) {
    try { await rollback(stored); job.status = "failed"; }
    catch { job.status = "recovery_required"; }
    job.error = job.status === "recovery_required" ? "Some messages moved during rollback. Recovery is required before another catch-up; no files were deleted."
      : "Catch-up could not be applied. Original messages were restored. Start a new review.";
    await writeCatchup(root, stored);
    throw error;
  }
}
