import { describe, expect, it } from "bun:test";

import type { MailMessage } from "../src/lib/api";
import {
  buildMailThreads,
  getAdjacentThreadId,
  getConsecutiveReplyLevels,
  getInboxMessageIdsForThread,
  getMailMessageId,
  getMailThreadId,
  getSelectedInboxUnreadMessageIds,
  INITIAL_MAIL_LIST_STATE,
  normalizeMailSubject,
  reduceMailListState,
  type MailThread,
} from "../src/pages/mail-page-utils";

function createMailMessage(
  overrides: Partial<MailMessage> & Pick<MailMessage, "id" | "subject" | "date">,
): MailMessage {
  return {
    id: overrides.id,
    from: overrides.from ?? "from@example.test",
    to: overrides.to ?? "to@example.test",
    subject: overrides.subject,
    date: overrides.date,
    body: overrides.body ?? "",
    headers: overrides.headers ?? {},
    flags: overrides.flags ?? {
      seen: false,
      replied: false,
      flagged: false,
      draft: false,
      trashed: false,
    },
    filePath: overrides.filePath,
  };
}

describe("mail-page-utils", () => {
  it("normalizes reply and forward prefixes before threading", () => {
    expect(normalizeMailSubject("Re: Deploy status")).toBe("Deploy status");
    expect(normalizeMailSubject("FWD: Deploy status")).toBe("Deploy status");
  });

  it("builds threads across inbox, sent, and archive while preserving chronological order", () => {
    const rootMessage = createMailMessage({
      id: "inbox-1",
      subject: "Deploy status",
      date: "2026-04-20T09:00:00.000Z",
      headers: { "message-id": "<root@example.test>" },
    });
    const replyMessage = createMailMessage({
      id: "sent-1",
      subject: "Re: Deploy status",
      date: "2026-04-20T10:00:00.000Z",
      headers: { "in-reply-to": "<root@example.test>" },
      flags: {
        seen: true,
        replied: true,
        flagged: false,
        draft: false,
        trashed: false,
      },
    });
    const archivedMessage = createMailMessage({
      id: "archive-1",
      subject: "Another thread",
      date: "2026-04-19T09:00:00.000Z",
      flags: {
        seen: true,
        replied: false,
        flagged: false,
        draft: false,
        trashed: false,
      },
    });

    const threads = buildMailThreads({
      inboxMessages: [rootMessage],
      sentMessages: [replyMessage],
      archiveMessages: [archivedMessage],
      activeTab: "inbox",
      collapsedThreads: new Set(["Deploy status-sent-1"]),
    });

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe("Deploy status");
    expect(threads[0]?.subject).toBe("Deploy status");
    expect(threads[0]?.unreadCount).toBe(1);
    expect(threads[0]?.messages.map((message) => message.message.id)).toEqual([
      "inbox-1",
      "sent-1",
    ]);
    expect(threads[0]?.messages[1]?.isCollapsed).toBe(true);
  });

  it("uses Coleo thread headers before falling back to subject grouping", () => {
    const brainMessage = createMailMessage({
      id: "brain-1",
      subject: "[coleo] Task completed: Deploy status",
      date: "2026-04-20T09:00:00.000Z",
      headers: {
        "message-id": "<brain-1@example.test>",
        "x-coleo-thread-id": "task-123",
      },
    });
    const humanReply = createMailMessage({
      id: "sent-1",
      subject: "Re: Different visible subject",
      date: "2026-04-20T10:00:00.000Z",
      headers: {
        "message-id": "<sent-1@example.test>",
        "in-reply-to": "<brain-1@example.test>",
        "x-coleo-thread-id": "task-123",
      },
    });

    const threads = buildMailThreads({
      inboxMessages: [brainMessage],
      sentMessages: [humanReply],
      archiveMessages: [],
      activeTab: "inbox",
      collapsedThreads: new Set(),
    });

    expect(getMailMessageId(brainMessage)).toBe("<brain-1@example.test>");
    expect(getMailThreadId(humanReply)).toBe("task-123");
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe("task-123");
    expect(threads[0]?.messages.map((message) => message.message.id)).toEqual([
      "brain-1",
      "sent-1",
    ]);
  });

  it("filters threads to the active mailbox based on actual message membership", () => {
    const inboxThread = createMailMessage({
      id: "inbox-1",
      subject: "Inbox only",
      date: "2026-04-20T08:00:00.000Z",
    });
    const sentThread = createMailMessage({
      id: "sent-1",
      subject: "Sent only",
      date: "2026-04-20T09:00:00.000Z",
      flags: {
        seen: true,
        replied: false,
        flagged: false,
        draft: false,
        trashed: false,
      },
    });

    const inboxThreads = buildMailThreads({
      inboxMessages: [inboxThread],
      sentMessages: [sentThread],
      archiveMessages: [],
      activeTab: "inbox",
      collapsedThreads: new Set(),
    });
    const sentThreads = buildMailThreads({
      inboxMessages: [inboxThread],
      sentMessages: [sentThread],
      archiveMessages: [],
      activeTab: "sent",
      collapsedThreads: new Set(),
    });

    expect(inboxThreads.map((thread) => thread.id)).toEqual(["Inbox only"]);
    expect(sentThreads.map((thread) => thread.id)).toEqual(["Sent only"]);
  });

  it("returns only unread inbox message ids for the selected inbox thread", () => {
    const inboxUnread = createMailMessage({
      id: "inbox-unread",
      subject: "Deploy status",
      date: "2026-04-20T09:00:00.000Z",
    });
    const inboxRead = createMailMessage({
      id: "inbox-read",
      subject: "Re: Deploy status",
      date: "2026-04-20T10:00:00.000Z",
      flags: {
        seen: true,
        replied: false,
        flagged: false,
        draft: false,
        trashed: false,
      },
    });
    const archivedUnread = createMailMessage({
      id: "archive-unread",
      subject: "Re: Deploy status",
      date: "2026-04-20T11:00:00.000Z",
      flags: {
        seen: false,
        replied: false,
        flagged: false,
        draft: false,
        trashed: false,
      },
    });

    const [thread] = buildMailThreads({
      inboxMessages: [inboxUnread, inboxRead],
      sentMessages: [],
      archiveMessages: [archivedUnread],
      activeTab: "inbox",
      collapsedThreads: new Set(),
    });

    expect(
      getSelectedInboxUnreadMessageIds(thread, "inbox", [inboxUnread, inboxRead]),
    ).toEqual(["inbox-unread"]);
    expect(
      getSelectedInboxUnreadMessageIds(thread, "archive", [inboxUnread, inboxRead]),
    ).toEqual([]);
  });

  it("moves the keyboard cursor through threads without opening a detail view", () => {
    const threads = [
      { id: "first" },
      { id: "second" },
      { id: "third" },
    ] as MailThread[];

    expect(getAdjacentThreadId(threads, null, "next")).toBe("first");
    expect(getAdjacentThreadId(threads, "first", "next")).toBe("second");
    expect(getAdjacentThreadId(threads, "third", "next")).toBe("third");
    expect(getAdjacentThreadId(threads, null, "previous")).toBe("third");
    expect(getAdjacentThreadId(threads, "second", "previous")).toBe("first");
  });

  it("applies mail list transitions once and keeps sync idempotent", () => {
    const threadIds = ["first", "second", "third"];
    const synced = reduceMailListState(INITIAL_MAIL_LIST_STATE, {
      type: "sync",
      threadIds,
    });
    expect(synced.focusedThreadId).toBe("first");
    expect(reduceMailListState(synced, { type: "sync", threadIds })).toBe(synced);

    const moved = reduceMailListState(synced, {
      type: "move",
      threadIds,
      direction: "next",
    });
    expect(moved.focusedThreadId).toBe("second");

    const expanded = reduceMailListState(moved, {
      type: "toggle",
      threadId: "second",
    });
    expect(expanded.expandedThreadIds.has("second")).toBe(true);

    const archived = reduceMailListState(expanded, {
      type: "archive",
      threadId: "second",
      fallbackThreadId: "third",
    });
    expect(archived.focusedThreadId).toBe("third");
    expect(archived.expandedThreadIds.has("second")).toBe(false);
  });

  it("archives only inbox messages from a mixed-folder thread", () => {
    const inboxMessage = createMailMessage({
      id: "inbox-1",
      subject: "Deploy status",
      date: "2026-04-20T09:00:00.000Z",
    });
    const sentMessage = createMailMessage({
      id: "sent-1",
      subject: "Re: Deploy status",
      date: "2026-04-20T10:00:00.000Z",
    });
    const [thread] = buildMailThreads({
      inboxMessages: [inboxMessage],
      sentMessages: [sentMessage],
      archiveMessages: [],
      activeTab: "inbox",
      collapsedThreads: new Set(),
    });

    expect(getInboxMessageIdsForThread(thread!, [inboxMessage])).toEqual(["inbox-1"]);
  });

  it("indents only consecutive direct replies", () => {
    const root = createMailMessage({
      id: "root",
      subject: "Deploy status",
      date: "2026-04-20T09:00:00.000Z",
      headers: { "message-id": "<root@example.test>" },
    });
    const directReply = createMailMessage({
      id: "reply",
      subject: "Re: Deploy status",
      date: "2026-04-20T10:00:00.000Z",
      headers: {
        "message-id": "<reply@example.test>",
        "in-reply-to": "<root@example.test>",
      },
    });
    const nestedReply = createMailMessage({
      id: "nested",
      subject: "Re: Deploy status",
      date: "2026-04-20T11:00:00.000Z",
      headers: { "in-reply-to": "<reply@example.test>" },
    });
    const unrelated = createMailMessage({
      id: "unrelated",
      subject: "Deploy status",
      date: "2026-04-20T12:00:00.000Z",
    });
    const [thread] = buildMailThreads({
      inboxMessages: [root, directReply, nestedReply, unrelated],
      sentMessages: [],
      archiveMessages: [],
      activeTab: "inbox",
      collapsedThreads: new Set(),
    });

    expect(getConsecutiveReplyLevels(thread!, 4)).toEqual([0, 1, 2, 0]);
  });
});
