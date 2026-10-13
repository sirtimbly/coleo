// Development-only fixture capture. Python runtime never invokes this script.
// Run from repo root: bun clients/python/generate-fixtures.ts
import { getNamedResourceView } from "../../src/workbench/named-resource-views";
import { buildMailThreadDefinitions } from "../../src/workbench/mail-thread-model";
import { InboxApi } from "../../src/cli/inbox/api";
import { parseInboxOptions } from "../../src/cli/inbox/options";
import { loadInboxSnapshot } from "../../src/cli/inbox/snapshot";
import { normalizeMessagingQuery, messagingQueryIdentity } from "../../src/workbench/messaging-query";
import { messagingSourcesForQuery } from "../../src/workbench/messaging-collection";
import { MESSAGING_VIEW_REGISTRY } from "../../src/workbench/messaging-view-registry";
import inboxDefinition from "../../src/workbench/examples/inbox-triage.json";

const destination = new URL("./src/coleo_inbox/fixtures/", import.meta.url);
await Bun.write(new URL("registry.json", destination), JSON.stringify(MESSAGING_VIEW_REGISTRY, null, 2));
await Bun.write(new URL("definition.json", destination), JSON.stringify(inboxDefinition, null, 2));
for (const client of ["cli", "tui"] as const) {
  await Bun.write(new URL(`${client}-view.json`, destination), JSON.stringify(getNamedResourceView("inbox-triage", client), null, 2));
}
const messages: import("../../src/workbench/mail-thread-model").MailThreadMessageInput[] = [
  { id: "first", mailbox: "inbox" as const, from: "Tim", subject: "Unicode 日本語 🐙 and a deliberately long Inbox subject for narrow terminals", timestamp: "2026-10-09T12:00:00.000Z", body: "# Review\n\nFull **Markdown** content, not just the summary.", seen: false, headers: { "message-id": "<first@example.test>" } },
  { id: "reply", mailbox: "sent" as const, from: "Brain", subject: "Re: Unicode", timestamp: "2026-10-09T12:01:00.000Z", body: "Sent-only context must be skipped by read.", seen: true, headers: { "message-id": "<reply@example.test>", "in-reply-to": "<first@example.test>" } },
  { id: "branch", mailbox: "inbox" as const, from: "Arm", subject: "Re: Unicode", timestamp: "2026-10-09T12:02:00.000Z", body: "Branch reply body.", seen: false, headers: { "message-id": "<branch@example.test>", "in-reply-to": "<first@example.test>" } },
];
const thread = { ...buildMailThreadDefinitions(messages, "inbox")[0]!, revision: "fixture-revision-1" };
await Bun.write(new URL("thread.json", destination), JSON.stringify(thread, null, 2));
await Bun.write(new URL("detail.json", destination), JSON.stringify({ schemaVersion: 1, thread,
  messages: messages.map((m) => ({ id: m.id, from: m.from, to: "Tim", subject: m.subject, timestamp: m.timestamp, body: m.body })) }, null, 2));
const view = getNamedResourceView("inbox-triage", "cli")!;
const query = normalizeMessagingQuery(view.definition.query);
const page = { schemaVersion: 1, queryId: messagingQueryIdentity(query), query, cursor: null, nextCursor: "older",
  items: [{ id: `thread:${thread.id}`, revision: thread.revision, sourceId: "mail", kind: "brain", representation: "thread",
    title: thread.subject, summary: "Thread summary", timestamp: thread.lastMessageAt, source: "Mail", unread: true,
    requiresAction: false, severity: "info", detail: { kind: "thread", threadId: thread.id, mailbox: "inbox" }, thread }],
  sources: messagingSourcesForQuery(query).map((id) => ({ id, status: "fresh", revision: "1", asOf: "2026-10-09T12:00:00.000Z", complete: true })),
  summaries: { scope: "query", total: 2, unread: 2, requiresAction: 0, complete: true } };
await Bun.write(new URL("page.json", destination), JSON.stringify(page, null, 2));
const api = new InboxApi({ apiUrl: "http://fixture", headers: {} }, async () => Response.json(page));
for (const expansion of ["all", "roots", "collapsed"]) {
  const options = parseInboxOptions(["--expand", expansion, "--metadata", "overview"], view);
  const snapshot = await loadInboxSnapshot(api, view, options);
  await Bun.write(new URL(`expected-${expansion}.json`, destination), JSON.stringify(snapshot, null, 2));
}
