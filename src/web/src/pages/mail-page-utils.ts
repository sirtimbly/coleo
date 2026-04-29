import type { MailMessage } from "@/lib/api";

export type MailboxTab = "inbox" | "sent" | "archive";

export interface ThreadMessage {
  message: MailMessage;
  isCollapsed: boolean;
}

export interface MailThread {
  id: string;
  subject: string;
  messages: ThreadMessage[];
  unreadCount: number;
  lastMessageDate: Date;
}

export interface BuildMailThreadsOptions {
  inboxMessages?: MailMessage[];
  sentMessages?: MailMessage[];
  archiveMessages?: MailMessage[];
  activeTab: MailboxTab;
  collapsedThreads: ReadonlySet<string>;
}

export function normalizeMailSubject(subject: string): string {
  return subject.replace(/^(Re:|Fwd:|RE:|FWD:)\s*/i, "").trim();
}

export function buildMailThreads({
  inboxMessages = [],
  sentMessages = [],
  archiveMessages = [],
  activeTab,
  collapsedThreads,
}: BuildMailThreadsOptions): MailThread[] {
  const allMessages = [...inboxMessages, ...sentMessages, ...archiveMessages];
  const threadMap = new Map<string, MailThread>();

  for (const msg of allMessages) {
    const normalizedSubject = normalizeMailSubject(msg.subject);
    const inReplyTo = msg.headers["in-reply-to"];
    const references = msg.headers.references;

    let threadId = normalizedSubject;

    if (inReplyTo || references) {
      for (const [existingId, thread] of threadMap) {
        if (
          thread.messages.some(
            (threadMessage) =>
              inReplyTo?.includes(threadMessage.message.headers["message-id"] || "") ||
              references?.includes(threadMessage.message.headers["message-id"] || ""),
          )
        ) {
          threadId = existingId;
          break;
        }
      }
    }

    if (!threadMap.has(threadId)) {
      threadMap.set(threadId, {
        id: threadId,
        subject: normalizedSubject,
        messages: [],
        unreadCount: 0,
        lastMessageDate: new Date(msg.date),
      });
    }

    const thread = threadMap.get(threadId)!;
    thread.messages.push({
      message: msg,
      isCollapsed: collapsedThreads.has(`${threadId}-${msg.id}`),
    });

    if (!msg.flags.seen) {
      thread.unreadCount += 1;
    }

    const messageDate = new Date(msg.date);
    if (messageDate > thread.lastMessageDate) {
      thread.lastMessageDate = messageDate;
    }
  }

  for (const thread of threadMap.values()) {
    thread.messages.sort(
      (a, b) =>
        new Date(a.message.date).getTime() - new Date(b.message.date).getTime(),
    );
  }

  const sortedThreads = Array.from(threadMap.values()).sort(
    (a, b) => b.lastMessageDate.getTime() - a.lastMessageDate.getTime(),
  );

  const visibleIds =
    activeTab === "inbox"
      ? new Set(inboxMessages.map((message) => message.id))
      : activeTab === "sent"
        ? new Set(sentMessages.map((message) => message.id))
        : new Set(archiveMessages.map((message) => message.id));

  return sortedThreads.filter((thread) =>
    thread.messages.some((threadMessage) => visibleIds.has(threadMessage.message.id)),
  );
}

export function getSelectedInboxUnreadMessageIds(
  selectedThread: MailThread | undefined,
  activeTab: MailboxTab,
  inboxMessages?: MailMessage[],
): string[] {
  if (!selectedThread || activeTab !== "inbox") {
    return [];
  }

  const inboxMessageIds = new Set((inboxMessages ?? []).map((message) => message.id));

  return selectedThread.messages
    .map((threadMessage) => threadMessage.message)
    .filter((message) => !message.flags.seen && inboxMessageIds.has(message.id))
    .map((message) => message.id);
}
