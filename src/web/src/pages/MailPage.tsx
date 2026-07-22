import { useEffect, useState, useCallback, useRef, useMemo, useReducer } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, Chip } from "@heroui/react";
import {
	Mail,
	Send,
	Inbox,
	RefreshCw,
	Eye,
	Archive,
	ChevronDown,
	ChevronUp,
	Bot,
	MessageCircle,
	Reply,
	UserRound,
} from "lucide-react";
import { api, type MailMessage, useMessage } from "@/lib";
import { Card, CardHeader, CardTitle, CardContent } from "@/components";
import { WorkspacePageShell } from "@/components/WorkspacePageShell";
import { usePageTitle } from '@/hooks/usePageTitle';
import { useWebSocket } from "@/hooks/useWebSocket";
import {
	buildMailThreads,
	getConsecutiveReplyLevels,
	getInboxMessageIdsForThread,
	getMailMessageId,
	getMailThreadId,
	getSelectedInboxUnreadMessageIds,
	INITIAL_MAIL_LIST_STATE,
	reduceMailListState,
	type MailThread,
} from "@/pages/mail-page-utils";
import {
	useIsWorkspacePanel,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from "@/workspace/route-context";

const MAIL_REFRESH_INTERVAL_MS = 10_000;
const MESSAGE_BORDER_COLORS = [
	"oklch(0.68 0.16 252)",
	"oklch(0.7 0.14 165)",
	"oklch(0.72 0.15 72)",
	"oklch(0.66 0.16 325)",
] as const;

interface MailThreadGridProps {
	threads: MailThread[];
	expandedThreadIds: ReadonlySet<string>;
	focusedThreadId: string | null;
	sentMessageIds: ReadonlySet<string>;
	formatDate: (date: string) => string;
	onToggle: (threadId: string) => void;
	onFocus: (threadId: string) => void;
	onReply: (thread: MailThread) => void;
	onOpenThread?: (threadId: string) => void;
}

function MailThreadGrid({
	threads,
	expandedThreadIds,
	focusedThreadId,
	sentMessageIds,
	formatDate,
	onToggle,
	onFocus,
	onReply,
	onOpenThread,
}: MailThreadGridProps) {
	const rowRefs = useRef(new Map<string, HTMLDivElement>());

	useEffect(() => {
		if (!focusedThreadId) return;
		rowRefs.current.get(focusedThreadId)?.scrollIntoView({
			behavior: "smooth",
			block: "nearest",
		});
	}, [focusedThreadId]);

	if (threads.length === 0) {
		return <div className="flex flex-1 items-center justify-center p-12 text-sm text-muted-foreground"><Mail className="mr-2 h-4 w-4" />No messages</div>;
	}

	return <div className="overflow-auto bg-surface-secondary/35 p-2"><div className="space-y-2">
		{threads.map((thread) => {
			const expanded = expandedThreadIds.has(thread.id);
			const focused = focusedThreadId === thread.id;
			const hasOpenAction = typeof onOpenThread === "function";
			const latestMessage = thread.messages.at(-1)?.message;
			const automated = latestMessage ? /\b(?:brain|arm|coleo)\b/i.test(latestMessage.from) : false;
			const replyLevels = getConsecutiveReplyLevels(thread, MESSAGE_BORDER_COLORS.length);
			return <div
				key={thread.id}
				ref={(element) => {
					if (element) rowRefs.current.set(thread.id, element);
					else rowRefs.current.delete(thread.id);
				}}
				className={`overflow-hidden rounded-xl border bg-content1 transition-[border-color,box-shadow,background-color] ${
					focused
						? "border-accent/70 ring-2 ring-accent/20"
						: thread.unreadCount
							? "border-accent/25 bg-accent/[0.035]"
							: "border-border/70"
				}`}
			>
				<button
					type="button"
					onClick={() => {
						onFocus(thread.id);
						onToggle(thread.id);
					}}
					onFocus={() => onFocus(thread.id)}
					aria-expanded={expanded}
					aria-current={focused ? "true" : undefined}
					data-mail-thread-toggle={thread.id}
					className="group flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-accent/[0.045] focus-visible:outline-none"
				>
					<span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${automated ? "border-accent/20 bg-accent/10 text-accent" : "border-border bg-surface-secondary text-muted-foreground"}`}>
						{automated ? <Bot className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}
					</span>
					<span className="min-w-0 flex-1">
						<span className="flex items-center gap-2">
							<span className={`truncate text-sm ${thread.unreadCount ? "font-semibold text-foreground" : "font-medium text-foreground/90"}`}>{thread.subject}</span>
							{thread.unreadCount ? <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground">{thread.unreadCount}</span> : null}
						</span>
						<span className="mt-0.5 block truncate text-xs text-muted-foreground">{latestMessage?.from || "Unknown sender"} · {thread.messages.length} {thread.messages.length === 1 ? "message" : "messages"}</span>
						{latestMessage?.body ? <span className="mt-1.5 block truncate text-xs leading-5 text-muted-foreground/85">{latestMessage.body}</span> : null}
					</span>
					<span className="flex shrink-0 items-center gap-2 pt-0.5">
						<time className="text-[11px] tabular-nums text-muted-foreground">{formatDate(thread.lastMessageDate.toISOString())}</time>
						{expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground transition-transform" /> : <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-y-0.5" />}
					</span>
				</button>
				{expanded ? <div className="space-y-2 border-t border-border/60 bg-background/60 p-2.5">{thread.messages.map((threadMessage, index) => {
					const message = threadMessage.message;
					const sent = sentMessageIds.has(message.id);
					const messageAutomated = /\b(?:brain|arm|coleo)\b/i.test(message.from);
					const reply = index > 0;
					const replyLevel = replyLevels[index] ?? 0;
					const borderColor = MESSAGE_BORDER_COLORS[index % MESSAGE_BORDER_COLORS.length];
					return <div key={message.id} className="pl-2" style={{ marginLeft: `${replyLevel * 1.5}rem`, borderLeft: `2px solid ${borderColor}` }}><article className="rounded-lg border border-border/60 bg-content1 px-3 py-3 shadow-sm"><div className="flex items-start gap-2.5"><span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${sent ? 'bg-accent/15 text-accent' : 'bg-secondary text-muted-foreground'}`}>{sent || !messageAutomated ? <UserRound className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="truncate text-sm font-medium">{message.from}</span><span className="text-[11px] text-muted-foreground">{sent ? 'You sent' : messageAutomated ? 'Brain or arm' : 'Received'}{reply ? ' · Reply' : ''}</span><time className="ml-auto text-[11px] tabular-nums text-muted-foreground">{formatDate(message.date)}</time></div><p className="readable-copy mt-2 whitespace-pre-wrap">{message.body}</p><div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" onClick={() => onReply(thread)} className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"><Reply className="mr-1 h-3.5 w-3.5" />Reply</button>{hasOpenAction ? <button type="button" onClick={() => onOpenThread?.(thread.id)} className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground"><Eye className="mr-1 h-3.5 w-3.5" />Open detail</button> : null}</div></div></div></article></div>;
				})}</div> : null}
			</div>;
		})}
	</div></div>;
}

export function MailPage() {
	usePageTitle('Coleo Observatory - Mail');
	const isWorkspacePanel = useIsWorkspacePanel();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const [searchParams, setSearchParams] = useWorkspaceSearchParams();
	const [inbox, setInbox] = useState<{
		messages: MailMessage[];
		pagination: { unread: number };
	} | null>(null);
	const [sent, setSent] = useState<{ messages: MailMessage[] } | null>(null);
	const [archive, setArchive] = useState<{ messages: MailMessage[] } | null>(
		null,
	);
	const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
	const [mailListState, dispatchMailList] = useReducer(
		reduceMailListState,
		INITIAL_MAIL_LIST_STATE,
	);
	const { focusedThreadId, expandedThreadIds } = mailListState;
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<"inbox" | "sent" | "archive">(
		"inbox",
	);
	const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(
		new Set(),
	);
	const { openReply, openNewMessage } = useMessage();
	const threadListRef = useRef<HTMLDivElement>(null);
	const unreadMessageRef = useRef<HTMLDivElement>(null);
	const mailRefreshPromiseRef = useRef<Promise<void> | null>(null);
	const mailMutationVersionRef = useRef(0);

	useEffect(() => {
		if (!isWorkspacePanel) return;

		const mailbox = searchParams.get("mailbox");
		if (mailbox === "inbox" || mailbox === "sent" || mailbox === "archive") {
			setActiveTab(mailbox);
		}

		setSelectedThreadId(searchParams.get("thread"));
	}, [isWorkspacePanel, searchParams]);

	const loadMail = useCallback((): Promise<void> => {
		if (mailRefreshPromiseRef.current) {
			return mailRefreshPromiseRef.current;
		}

		const requestMutationVersion = mailMutationVersionRef.current;
		const refreshPromise = Promise.all([
			api.listInbox({ limit: 50 }),
			api.listSent({ limit: 50 }),
			api.listArchive({ limit: 50 }),
		])
			.then(([inboxRes, sentRes, archiveRes]) => {
				if (requestMutationVersion !== mailMutationVersionRef.current) return;
				setInbox(inboxRes);
				setSent(sentRes);
				setArchive(archiveRes);
				setError(null);
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : "Failed to load mail");
			})
			.finally(() => {
				mailRefreshPromiseRef.current = null;
				setLoading(false);
			});

		mailRefreshPromiseRef.current = refreshPromise;
		return refreshPromise;
	}, []);
	const reloadMail = useCallback(async (): Promise<void> => {
		if (mailRefreshPromiseRef.current) {
			await mailRefreshPromiseRef.current;
		}
		await loadMail();
	}, [loadMail]);

	const handleWSMessage = useCallback(
		(msg: { channel?: string; event?: string; data?: unknown }) => {
			if (
				msg.channel === "mail" &&
				(msg.event as string)?.includes("mail")
			) {
				loadMail();
			}
		},
		[loadMail],
	);

	useWebSocket({
		channels: ["mail"],
		onMessage: handleWSMessage,
	});

	useEffect(() => {
		void loadMail();

		const refreshWhenFocused = () => {
			if (document.visibilityState === "visible") {
				void loadMail();
			}
		};
		const refreshWhenVisible = () => {
			if (document.visibilityState === "visible") {
				void loadMail();
			}
		};
		const interval = window.setInterval(
			refreshWhenFocused,
			MAIL_REFRESH_INTERVAL_MS,
		);

		window.addEventListener("focus", refreshWhenFocused);
		document.addEventListener("visibilitychange", refreshWhenVisible);

		return () => {
			window.clearInterval(interval);
			window.removeEventListener("focus", refreshWhenFocused);
			document.removeEventListener("visibilitychange", refreshWhenVisible);
		};
	}, [loadMail]);

	// Auto-scroll to first unread message when thread is selected
	useEffect(() => {
		if (selectedThreadId && unreadMessageRef.current) {
			setTimeout(() => {
				unreadMessageRef.current?.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
			}, 100);
		}
	}, [selectedThreadId]);

	const handleMarkRead = async (id: string) => {
		try {
			await api.markMailRead(id);
			await loadMail();
		} catch (err) {
			console.error("Failed to mark as read:", err);
		}
	};

	const toggleMessageCollapse = (threadId: string, messageId: string) => {
		setCollapsedThreads((prev) => {
			const key = `${threadId}-${messageId}`;
			const newSet = new Set(prev);
			if (newSet.has(key)) {
				newSet.delete(key);
			} else {
				newSet.add(key);
			}
			return newSet;
		});
	};

	const focusThread = useCallback((threadId: string) => {
		dispatchMailList({ type: "focus", threadId });
	}, []);

	const toggleThreadExpansion = useCallback((threadId: string) => {
		dispatchMailList({ type: "toggle", threadId });
	}, []);

	const formatDate = (dateStr: string) => {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return "Just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return date.toLocaleDateString();
	};

	const formatFullDate = (dateStr: string) => {
		return new Date(dateStr).toLocaleString();
	};

	// Group messages into threads (combine all folders for proper threading)
	const threads = useMemo(
		() =>
			buildMailThreads({
				inboxMessages: inbox?.messages,
				sentMessages: sent?.messages,
				archiveMessages: archive?.messages,
				activeTab,
				collapsedThreads,
			}),
		[inbox?.messages, sent?.messages, archive?.messages, activeTab, collapsedThreads],
	);

	const selectedThread = threads.find((t) => t.id === selectedThreadId);
	const sentMessageIds = useMemo(
		() => new Set(sent?.messages.map((message) => message.id)),
		[sent?.messages],
	);
	const focusedThread = threads.find((thread) => thread.id === focusedThreadId);

	useEffect(() => {
		dispatchMailList({
			type: "sync",
			threadIds: threads.map((thread) => thread.id),
		});
	}, [threads]);

	// Find first unread message index in selected thread
	const firstUnreadIndex = selectedThread
		? selectedThread.messages.findIndex((m) => !m.message.flags.seen)
		: -1;

	const selectedInboxUnreadMessageIds = useMemo(
		() =>
			getSelectedInboxUnreadMessageIds(
				selectedThread,
				activeTab,
				inbox?.messages,
			),
		[activeTab, inbox?.messages, selectedThread],
	);
	const selectedInboxUnreadMessageIdsKey = selectedInboxUnreadMessageIds.join(",");

	const markThreadRead = useCallback(
		async (messageIds: string[]) => {
			if (messageIds.length === 0) return;

			try {
				await Promise.all(messageIds.map((messageId) => api.markMailRead(messageId)));
				await loadMail();
			} catch (err) {
				console.error("Failed to mark thread as read:", err);
			}
		},
		[loadMail],
	);

	// Auto-mark a viewed thread as read after 4 seconds, unless the user switches threads.
	// This version marks messages as read without reloading mail data to avoid disrupting the view.
	useEffect(() => {
		if (!selectedThreadId || selectedInboxUnreadMessageIds.length === 0) return;

		const timer = window.setTimeout(() => {
			// Mark messages as read without reloading to avoid view disruption in split mode
			void Promise.all(
				selectedInboxUnreadMessageIds.map((messageId) => api.markMailRead(messageId)),
			).catch((err) => {
				console.error("Failed to auto-mark thread as read:", err);
			});
		}, 4000);

		return () => window.clearTimeout(timer);
	}, [selectedInboxUnreadMessageIds, selectedInboxUnreadMessageIdsKey, selectedThreadId]);

	const handleArchive = async (id: string) => {
		const selectedThreadBeforeArchive = selectedThreadId
			? threads.find((thread) => thread.id === selectedThreadId)
			: null;
		const archivedSelectedThread =
			selectedThreadBeforeArchive?.messages.some(
				(threadMessage) => threadMessage.message.id === id,
			) ?? false;
		const removesSelectedThread =
			archivedSelectedThread &&
			(selectedThreadBeforeArchive?.messages.length ?? 0) === 1;
		const selectedThreadIndex = selectedThreadBeforeArchive
			? threads.findIndex((thread) => thread.id === selectedThreadBeforeArchive.id)
			: -1;
		const fallbackThreadId =
			selectedThreadIndex >= 0
				? (threads[selectedThreadIndex + 1]?.id ??
					threads[selectedThreadIndex - 1]?.id ??
					null)
				: null;

		try {
			await api.archiveMail(id);
			await loadMail();

			if (removesSelectedThread) {
				setSelectedThreadId(fallbackThreadId);
			}
		} catch (err) {
			console.error("Failed to archive:", err);
		}
	};

	const replyToThread = useCallback(
		(thread: MailThread) => {
			const lastMessage = thread.messages[thread.messages.length - 1];
			if (!lastMessage) return;

				openReply({
					messageId: getMailMessageId(lastMessage.message),
					threadId: getMailThreadId(lastMessage.message, thread.id),
					from: lastMessage.message.from,
					subject: thread.subject,
					body: lastMessage.message.body,
			});
		},
		[openReply],
	);

	const setMailbox = useCallback(
		(nextTab: "inbox" | "sent" | "archive") => {
			dispatchMailList({ type: "reset" });
			if (!isWorkspacePanel) {
				setActiveTab(nextTab);
				setSelectedThreadId(null);
				return;
			}

			setSearchParams({ mailbox: nextTab });
		},
		[isWorkspacePanel, setSearchParams],
	);

  const openThreadDetail = useCallback(
    (threadId: string) => {
      const thread = threads.find((t) => t.id === threadId);
      if (!isWorkspacePanel) {
        setSelectedThreadId(threadId);
        return;
      }

      const nextSearchParams = new URLSearchParams();
      nextSearchParams.set("mailbox", activeTab);
      nextSearchParams.set("thread", threadId);

      // If this panel is already viewing a thread, update it instead of splitting
      const isAlreadyViewingThread = searchParams.get("thread") !== null;

      openWorkspaceRoute(
        {
          pathname: "/mail",
          search: `?${nextSearchParams.toString()}`,
          title: thread ? `Mail: ${thread.subject}` : undefined,
        },
        isAlreadyViewingThread ? "focus" : "split",
      );
    },
    [activeTab, isWorkspacePanel, openWorkspaceRoute, searchParams, threads],
  );

	const archiveThread = useCallback(
		async (thread: MailThread) => {
			const messageIds = getInboxMessageIdsForThread(thread, inbox?.messages);
			if (messageIds.length === 0) return;
			const archivedMessageIds = new Set(messageIds);
			mailMutationVersionRef.current += 1;

			const threadIndex = threads.findIndex(
				(candidateThread) => candidateThread.id === thread.id,
			);
			const fallbackThreadId =
				threadIndex >= 0
					? (threads[threadIndex + 1]?.id ??
						threads[threadIndex - 1]?.id ??
						null)
					: null;
			setInbox((current) => {
				if (!current) return current;
				const archivedUnreadCount = current.messages.filter(
					(message) => archivedMessageIds.has(message.id) && !message.flags.seen,
				).length;
				return {
					messages: current.messages.filter(
						(message) => !archivedMessageIds.has(message.id),
					),
					pagination: {
						...current.pagination,
						unread: Math.max(0, current.pagination.unread - archivedUnreadCount),
					},
				};
			});
			if (selectedThreadId === thread.id) setSelectedThreadId(fallbackThreadId);
			dispatchMailList({
				type: "archive",
				threadId: thread.id,
				fallbackThreadId,
			});

			try {
				await Promise.all(
					messageIds.map((messageId) => api.archiveMail(messageId)),
				);
				await reloadMail();
			} catch (err) {
				console.error("Failed to archive thread:", err);
				await reloadMail();
			}
		},
		[inbox?.messages, reloadMail, selectedThreadId, threads],
	);

	// Gmail-style keyboard shortcuts (mail page only):
	// c = compose, r = reply, j/k = next/previous thread, e = archive.
	const handleMailKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;

		const target = event.target as HTMLElement | null;
		if (
			target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable)
		) {
			return;
		}

		const key = event.key.toLowerCase();
		if (key === " " || key === "spacebar") {
			const threadToggle = target?.closest<HTMLElement>("[data-mail-thread-toggle]");
			const otherInteractiveTarget = target?.closest<HTMLElement>(
				"button, a, [role='button'], [role='link']",
			);
			if (otherInteractiveTarget && !threadToggle) return;

			event.preventDefault();
			const scrollRegion = event.currentTarget.querySelector<HTMLElement>(
				"[data-mail-scroll-region]",
			);
			if (scrollRegion) {
				scrollRegion.scrollBy({ top: scrollRegion.clientHeight, behavior: "auto" });
			}
			return;
		}

		if (key === "c") {
			event.preventDefault();
			openNewMessage();
			return;
		}

		const activeThread = focusedThread ?? selectedThread;
		if (key === "r" && activeThread) {
			event.preventDefault();
			replyToThread(activeThread);
			return;
		}

		if (key === "enter" && focusedThread) {
			const threadToggle = target?.closest<HTMLElement>("[data-mail-thread-toggle]");
			const otherInteractiveTarget = target?.closest<HTMLElement>(
				"button, a, [role='button'], [role='link']",
			);
			if (otherInteractiveTarget && !threadToggle) return;

			event.preventDefault();
			dispatchMailList({ type: "toggle", threadId: focusedThread.id });
			return;
		}

		const threadIds = threads.map((thread) => thread.id);
		if (key === "j" && threadIds.length > 0) {
			event.preventDefault();
			dispatchMailList({ type: "move", threadIds, direction: "next" });
			return;
		}

		if (key === "k" && threadIds.length > 0) {
			event.preventDefault();
			dispatchMailList({ type: "move", threadIds, direction: "previous" });
			return;
		}

		if (key === "e" && activeThread && activeTab === "inbox") {
			event.preventDefault();
			void archiveThread(activeThread);
		}
	}, [
		activeTab,
		archiveThread,
		focusedThread,
		openNewMessage,
		replyToThread,
		selectedThread,
		threads,
	]);

	if (loading) {
		return (
			<div className="p-8">
				<div className="animate-pulse space-y-4">
					<div className="h-8 bg-secondary rounded w-48" />
					<div className="h-96 bg-secondary rounded" />
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-8">
				<Card className="border-destructive">
					<CardContent>
						<p className="text-destructive">Error: {error}</p>
					</CardContent>
				</Card>
			</div>
		);
	}

	if (isWorkspacePanel) {
		const mailboxToolbar = (
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
				<div className="flex items-stretch" role="tablist" aria-label="Mailbox">
					{(["inbox", "sent", "archive"] as const).map((tab) => (
						<button
							key={tab}
							type="button"
							role="tab"
							aria-selected={activeTab === tab}
							onClick={() => setMailbox(tab)}
							className={`inline-flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-sm capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
								activeTab === tab
									? "border-accent font-medium text-foreground"
									: "border-transparent text-muted-foreground hover:bg-surface-secondary hover:text-foreground"
							}`}
						>
							{tab === "inbox" ? <Inbox className="h-3.5 w-3.5" /> : null}
							{tab === "sent" ? <Send className="h-3.5 w-3.5" /> : null}
							{tab === "archive" ? <Archive className="h-3.5 w-3.5" /> : null}
							<span>{tab}</span>
							{tab === "inbox" ? (
								<Chip size="sm" color="danger" className="ml-0.5">
									{threads.reduce((sum, t) => sum + t.unreadCount, 0)}
								</Chip>
							) : null}
						</button>
					))}
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
					<div className="text-xs text-muted-foreground">{threads.length} threads</div>
					<Button variant="ghost" onPress={loadMail} aria-label="Refresh" size="sm" isIconOnly>
						<RefreshCw className="h-4 w-4" />
					</Button>
					<Button size="sm" variant="primary" onPress={openNewMessage}>
						<Send className="mr-1.5 h-3.5 w-3.5" />
						New
					</Button>
				</div>
			</div>
		);

		if (!selectedThread) {
			return (
				<div
					className="flex h-full min-h-0 flex-col bg-background focus:outline-none"
					tabIndex={-1}
					onKeyDown={handleMailKeyDown}
				>
					<header className="flex items-center border-b border-border px-3 py-2">
						{mailboxToolbar}
					</header>
					<div className="min-h-0 flex-1 overflow-auto" data-mail-scroll-region>
						<Card className="rounded-none h-full">
							<CardContent className="p-0">
								<MailThreadGrid
									threads={threads}
									expandedThreadIds={expandedThreadIds}
									focusedThreadId={focusedThreadId}
									sentMessageIds={sentMessageIds}
									formatDate={formatDate}
									onToggle={toggleThreadExpansion}
									onFocus={focusThread}
									onReply={replyToThread}
									onOpenThread={openThreadDetail}
								/>
							</CardContent>
						</Card>
					</div>
				</div>
			);
		}

		return (
			<div className="h-full focus:outline-none" tabIndex={-1} onKeyDown={handleMailKeyDown}>
			<WorkspacePageShell
				title={selectedThread.subject}
				subtitle={`${selectedThread.messages.length} messages`}
				toolbar={
					<>
						<Button size="sm" variant="primary" onPress={() => replyToThread(selectedThread)}>
							<Reply className="h-3.5 w-3.5 mr-1.5" />
							Reply
						</Button>
						{activeTab === "inbox" ? (
							<Button size="sm" variant="ghost" onPress={() => void archiveThread(selectedThread)}>
								<Archive className="h-3.5 w-3.5 mr-1.5" />
								Archive
							</Button>
						) : null}
					</>
				}
			>
				<div className="h-full overflow-auto p-3" data-mail-scroll-region>
					<div className="space-y-3">
						{selectedThread.messages.map((threadMessage, index) => {
							const message = threadMessage.message;
							const isFirstUnread = index === firstUnreadIndex;

							return (
								<div
									key={message.id}
									ref={isFirstUnread ? unreadMessageRef : undefined}
									className="rounded-md border border-border/70 bg-content1/85"
								>
									<div className="border-b border-border/60 px-3 py-2">
										<div className="flex items-center justify-between gap-2">
											<div className="min-w-0">
												<div className="truncate text-sm font-medium">{message.from}</div>
												<div className="text-xs text-muted-foreground">
													{formatFullDate(message.date)}
												</div>
											</div>
											{!message.flags.seen && activeTab === "inbox" ? (
												<Button size="sm" variant="ghost" onPress={() => handleMarkRead(message.id)}>
													<Eye className="h-3.5 w-3.5 mr-1.5" />
													Read
												</Button>
											) : null}
										</div>
									</div>
									<div className="readable-copy whitespace-pre-wrap px-3 py-3">{message.body}</div>
								</div>
							);
						})}
					</div>
				</div>
			</WorkspacePageShell>
			</div>
		);
	}

	if (!isWorkspacePanel) {
		return (
			<div
				className="flex h-full min-h-0 flex-col bg-background focus:outline-none"
				tabIndex={-1}
				onKeyDown={handleMailKeyDown}
			>
				<header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
					<div><h1 className="text-lg font-semibold">Mail</h1><p className="text-xs text-muted-foreground">Open a conversation to read its complete thread.</p></div>
					<div className="ml-auto flex items-center gap-1" role="tablist" aria-label="Mailbox">
						{(["inbox", "sent", "archive"] as const).map((tab) => <Button key={tab} size="sm" variant={activeTab === tab ? "primary" : "ghost"} onPress={() => { setActiveTab(tab); dispatchMailList({ type: "reset" }); }}>{tab === "inbox" ? <Inbox className="mr-1 h-3.5 w-3.5" /> : tab === "sent" ? <Send className="mr-1 h-3.5 w-3.5" /> : <Archive className="mr-1 h-3.5 w-3.5" />}{tab}{tab === "inbox" && inbox?.pagination.unread ? <Chip size="sm" color="danger" className="ml-1">{inbox.pagination.unread}</Chip> : null}</Button>)}
						<Button size="sm" variant="ghost" onPress={loadMail} isIconOnly aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
						<Button size="sm" variant="primary" onPress={openNewMessage}><Send className="mr-1.5 h-3.5 w-3.5" />New</Button>
					</div>
				</header>
				<div className="min-h-0 flex-1 overflow-auto p-4" data-mail-scroll-region><Card className="min-h-full rounded-lg"><CardContent className="p-0"><MailThreadGrid threads={threads} expandedThreadIds={expandedThreadIds} focusedThreadId={focusedThreadId} sentMessageIds={sentMessageIds} formatDate={formatDate} onToggle={toggleThreadExpansion} onFocus={focusThread} onReply={replyToThread} /></CardContent></Card></div>
			</div>
		);
	}

	return (
		<div className="p-4 space-y-4 h-full min-h-0 flex flex-col">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-bold text-gradient-heading">Mail</h1>
				<Button
					variant="ghost"
					onPress={loadMail}
					aria-label="Refresh"
					size="sm"
				>
					<RefreshCw className="h-4 w-4" />
				</Button>
			</div>

			{/* Tabs */}
			<div className="flex gap-1">
				{(["inbox", "sent", "archive"] as const).map((tab) => (
					<Button
						key={tab}
						variant={activeTab === tab ? "primary" : "ghost"}
						size="sm"
						onPress={() => {
							setActiveTab(tab);
							setSelectedThreadId(null);
						}}
						className="capitalize"
					>
				{tab === "inbox" ? <Inbox className="h-3 w-3 mr-1" /> : null}
					{tab === "sent" ? <Send className="h-3 w-3 mr-1" /> : null}
					{tab === "archive" ? <Archive className="h-3 w-3 mr-1" /> : null}
					<span>{tab}</span>
					{tab === "inbox" ? (
						<Chip size="sm" color="danger" className="ml-1">
							{threads.reduce((sum, t) => sum + t.unreadCount, 0)}
						</Chip>
					) : null}
				</Button>
				))}
			</div>

			<div className="grid grid-cols-3 gap-4 flex-1 min-h-0">
				{/* Thread List */}
				<div className="col-span-1 flex flex-col min-h-0">
					<div className="text-xs text-muted-foreground mb-2 px-1">
						{threads.length} threads
					</div>
					<Card className="rounded-sm flex-1 flex flex-col min-h-0">
						<CardContent className="p-0 flex-1 overflow-y-auto">
							{threads.length === 0 ? (
								<div className="p-4 text-center text-muted-foreground">
									<Mail className="h-6 w-6 mx-auto mb-1 opacity-50" />
									<p className="text-sm">No messages</p>
								</div>
							) : (
								<div className="divide-y">
									{threads.map((thread) => (
										<div
											key={thread.id}
											role="button"
											tabIndex={0}
											className={`w-full py-2 px-3 cursor-pointer hover:bg-accent/5 transition-colors rounded-none ${
												thread.unreadCount > 0 &&
												selectedThreadId !== thread.id
													? "bg-accent/5"
													: ""
											} ${
												selectedThreadId === thread.id
													? "bg-accent/15 border-l-4 border-accent"
													: ""
											}`}
											onClick={() => setSelectedThreadId(thread.id)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													setSelectedThreadId(thread.id);
												}
											}}
										>
											<div className="flex items-start justify-between gap-2 w-full">
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-1">
														<MessageCircle className="h-3 w-3 text-muted-foreground" />
														<span
															className={`text-sm font-medium truncate ${thread.unreadCount > 0 ? "text-foreground" : "text-muted-foreground"}`}
														>
															{thread.subject}
														</span>
													</div>
													<p className="text-xs text-muted-foreground mt-0.5">
														{thread.messages.length} message
														{thread.messages.length !== 1 ? "s" : ""}
														{thread.unreadCount > 0 && (
															<span className="ml-1 text-accent font-medium">
																({thread.unreadCount} unread)
															</span>
														)}
													</p>
												</div>
												<span className="text-xs text-muted-foreground whitespace-nowrap">
													{formatDate(thread.lastMessageDate.toISOString())}
												</span>
											</div>
										</div>
									))}
								</div>
							)}
						</CardContent>
					</Card>
				</div>

				{/* Thread View */}
				<div className="col-span-2 flex flex-col min-h-0">
					<Card className="rounded-sm flex-1 flex flex-col min-h-0">
						{selectedThread ? (
							<>
								<CardHeader className="border-b">
									<div className="flex items-center justify-between">
										<div>
											<CardTitle className="text-lg font-medium">
												{selectedThread.subject}
											</CardTitle>
											<p className="text-sm text-muted-foreground mt-1">
												{selectedThread.messages.length} messages •{" "}
												{selectedThread.unreadCount} unread
											</p>
										</div>
										<div className="flex gap-2">
											<Button
												variant="primary"
												size="sm"
												onPress={() => replyToThread(selectedThread)}
											>
												<Reply className="h-4 w-4 mr-2" />
												Reply
											</Button>
											{activeTab === "inbox" &&
												selectedThread.unreadCount > 0 && (
													<Button
														variant="secondary"
														size="sm"
														onPress={() =>
															void markThreadRead(selectedInboxUnreadMessageIds)
														}
													>
														<Eye className="h-4 w-4 mr-2" />
														Mark All Read
													</Button>
												)}
											{activeTab !== "archive" && (
												<Button
													variant="secondary"
													size="sm"
													onPress={() => void archiveThread(selectedThread)}
												>
													<Archive className="h-4 w-4 mr-2" />
													Archive
												</Button>
											)}
										</div>
									</div>
								</CardHeader>
								<CardContent className="p-0">
									<div
										ref={threadListRef}
										className="max-h-[600px] overflow-y-auto"
									>
										{selectedThread.messages.map((threadMsg, index) => {
											const isUnread = !threadMsg.message.flags.seen;
											const isFirstUnread = index === firstUnreadIndex;
											const isCollapsed = threadMsg.isCollapsed;

											return (
												<div
													key={threadMsg.message.id}
													ref={isFirstUnread ? unreadMessageRef : null}
													className={`p-3 border-b last:border-b-0 ${isUnread ? "bg-accent/5" : ""} ${isFirstUnread ? "ring-2 ring-accent ring-inset" : ""}`}
												>
													{/* Message Header */}
													<div className="flex items-center justify-between mb-2">
														<div className="flex items-center gap-2">
															<div
																className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium ${
																	threadMsg.message.from.includes("human") ||
																	threadMsg.message.from.includes("user")
																		? "bg-blue-500 text-white"
																		: "bg-purple-500 text-white"
																}`}
															>
																{threadMsg.message.from.charAt(0).toUpperCase()}
															</div>
															<div>
																<p className="font-medium text-sm">
																	{threadMsg.message.from}
																</p>
																<p className="text-xs text-muted-foreground">
																	To: {threadMsg.message.to}
																</p>
															</div>
														</div>
														<div className="flex items-center gap-2">
															<span className="text-xs text-muted-foreground">
																{formatFullDate(threadMsg.message.date)}
															</span>
															{selectedThread.messages.length > 1 && (
																<Button
																	variant="ghost"
																	size="sm"
																	onPress={() =>
																		toggleMessageCollapse(
																			selectedThread.id,
																			threadMsg.message.id,
																		)
																	}
																	className="h-6 w-6 p-0"
																>
																	{isCollapsed ? (
																		<ChevronDown className="h-4 w-4" />
																	) : (
																		<ChevronUp className="h-4 w-4" />
																	)}
																</Button>
															)}
														</div>
													</div>

													{/* Message Body */}
													{!isCollapsed && (
														<div className="pl-9">
															<div className="readable-copy max-h-80 overflow-auto whitespace-pre-wrap rounded bg-secondary/30 p-3">
																{threadMsg.message.body}
															</div>

															{/* Message Actions */}
															{activeTab === "inbox" && (
																<div className="mt-2 flex gap-2">
																	{!threadMsg.message.flags.seen && (
																		<Button
																			variant="ghost"
																			size="sm"
																			onPress={() =>
																				handleMarkRead(threadMsg.message.id)
																			}
																		>
																			<Eye className="h-3 w-3 mr-1" />
																			Mark Read
																		</Button>
																	)}
																	<Button
																		variant="ghost"
																		size="sm"
																		onPress={() =>
																			handleArchive(threadMsg.message.id)
																		}
																	>
																		<Archive className="h-3 w-3 mr-1" />
																		Archive
																	</Button>
																</div>
															)}
														</div>
													)}

													{/* Collapsed indicator */}
													{isCollapsed && (
														<div className="pl-9 text-xs text-muted-foreground italic">
															Message collapsed. Click arrow to expand.
														</div>
													)}

													{/* Unread indicator */}
													{isUnread && (
														<div className="mt-2 flex items-center gap-2">
															<span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-accent text-white">
																Unread
															</span>
														</div>
													)}
												</div>
											);
										})}
									</div>
								</CardContent>
							</>
						) : (
							<CardContent className="flex items-center justify-center h-full text-muted-foreground min-h-[400px]">
								<div className="text-center">
									<Mail className="h-12 w-12 mx-auto mb-4 opacity-50" />
									<p className="text-lg font-medium">Select a thread to view</p>
									<p className="text-sm mt-2">
										Choose a conversation from the list
									</p>
								</div>
							</CardContent>
						)}
					</Card>
				</div>
			</div>
		</div>
	);
}
