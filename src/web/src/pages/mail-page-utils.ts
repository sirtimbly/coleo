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

export interface MailListState {
  focusedThreadId: string | null;
  expandedThreadIds: ReadonlySet<string>;
}

export type MailListAction =
  | { type: "sync"; threadIds: readonly string[] }
  | { type: "focus"; threadId: string }
  | { type: "move"; threadIds: readonly string[]; direction: "next" | "previous" }
  | { type: "toggle"; threadId: string }
  | { type: "archive"; threadId: string; fallbackThreadId: string | null }
  | { type: "reset" };

export const INITIAL_MAIL_LIST_STATE: MailListState = {
  focusedThreadId: null,
  expandedThreadIds: new Set(),
};

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

export function getMailHeader(message: MailMessage, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  const value = Object.entries(message.headers).find(
    ([header]) => header.toLowerCase() === normalizedName,
  )?.[1];

  return value?.trim() || undefined;
}

export function getMailMessageId(message: MailMessage): string {
  return getMailHeader(message, "message-id") ?? message.id;
}

export function getMailThreadId(message: MailMessage, fallback?: string): string {
  return (
    getMailHeader(message, "x-coleo-thread-id") ??
    getMailHeader(message, "x-coleo-task-id") ??
    getMailHeader(message, "x-coleo-bug-id") ??
    getMailHeader(message, "x-coleo-request-id") ??
    getMailHeader(message, "in-reply-to") ??
    fallback ??
    normalizeMailSubject(message.subject)
  );
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
    const explicitThreadId = getMailThreadId(msg);
    const inReplyTo = getMailHeader(msg, "in-reply-to");
    const references = getMailHeader(msg, "references");

    let threadId = explicitThreadId || normalizedSubject;

    if (inReplyTo || references) {
      for (const [existingId, thread] of threadMap) {
        if (
          thread.messages.some(
            (threadMessage) =>
              inReplyTo?.includes(getMailMessageId(threadMessage.message)) ||
              references?.includes(getMailMessageId(threadMessage.message)),
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

export function getAdjacentThreadId(
  threads: readonly MailThread[],
  focusedThreadId: string | null,
  direction: "next" | "previous",
): string | null {
  if (threads.length === 0) return null;

  const currentIndex = focusedThreadId
    ? threads.findIndex((thread) => thread.id === focusedThreadId)
    : -1;
  const nextIndex = direction === "next"
    ? currentIndex === -1
      ? 0
      : Math.min(currentIndex + 1, threads.length - 1)
    : currentIndex === -1
      ? threads.length - 1
      : Math.max(currentIndex - 1, 0);

  return threads[nextIndex]?.id ?? null;
}

export function reduceMailListState(
  state: MailListState,
  action: MailListAction,
): MailListState {
  switch (action.type) {
    case "sync": {
      const validThreadIds = new Set(action.threadIds);
      const focusedThreadId = state.focusedThreadId && validThreadIds.has(state.focusedThreadId)
        ? state.focusedThreadId
        : action.threadIds[0] ?? null;
      const expandedThreadIds = new Set(
        [...state.expandedThreadIds].filter((threadId) => validThreadIds.has(threadId)),
      );
      if (
        focusedThreadId === state.focusedThreadId &&
        expandedThreadIds.size === state.expandedThreadIds.size
      ) {
        return state;
      }
      return { focusedThreadId, expandedThreadIds };
    }
    case "focus":
      return action.threadId === state.focusedThreadId
        ? state
        : { ...state, focusedThreadId: action.threadId };
    case "move": {
      const currentIndex = state.focusedThreadId
        ? action.threadIds.indexOf(state.focusedThreadId)
        : -1;
      const nextIndex = action.direction === "next"
        ? currentIndex === -1
          ? 0
          : Math.min(currentIndex + 1, action.threadIds.length - 1)
        : currentIndex === -1
          ? action.threadIds.length - 1
          : Math.max(currentIndex - 1, 0);
      const focusedThreadId = action.threadIds[nextIndex] ?? null;
      return focusedThreadId === state.focusedThreadId
        ? state
        : { ...state, focusedThreadId };
    }
    case "toggle": {
      const expandedThreadIds = new Set(state.expandedThreadIds);
      if (expandedThreadIds.has(action.threadId)) expandedThreadIds.delete(action.threadId);
      else expandedThreadIds.add(action.threadId);
      return { ...state, focusedThreadId: action.threadId, expandedThreadIds };
    }
    case "archive": {
      const expandedThreadIds = new Set(state.expandedThreadIds);
      expandedThreadIds.delete(action.threadId);
      return {
        focusedThreadId: action.fallbackThreadId,
        expandedThreadIds,
      };
    }
    case "reset":
      return INITIAL_MAIL_LIST_STATE;
  }
}

export function getInboxMessageIdsForThread(
  thread: MailThread,
  inboxMessages?: readonly MailMessage[],
): string[] {
  const inboxMessageIds = new Set((inboxMessages ?? []).map((message) => message.id));
  return thread.messages
    .map((threadMessage) => threadMessage.message.id)
    .filter((messageId) => inboxMessageIds.has(messageId));
}

export function getConsecutiveReplyLevels(
  thread: MailThread,
  maxDepth: number,
): number[] {
  let previousDepth = 0;

  return thread.messages.map((threadMessage, index) => {
    const previousMessage = thread.messages[index - 1]?.message;
    const inReplyTo = getMailHeader(threadMessage.message, "in-reply-to");
    const repliesToPrevious = Boolean(
      previousMessage &&
      inReplyTo?.includes(getMailMessageId(previousMessage)),
    );
    const depth = repliesToPrevious
      ? Math.min(previousDepth + 1, maxDepth)
      : 0;
    previousDepth = depth;
    return depth;
  });
}
