import { useEffect, useState, useCallback, useRef, useMemo } from "react";
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
	MessageCircle,
	Reply,
} from "lucide-react";
import { api, type MailMessage, useMessage } from "@/lib";
import { Card, CardHeader, CardTitle, CardContent } from "@/components";
import { useWebSocket } from "@/hooks/useWebSocket";

interface ThreadMessage {
	message: MailMessage;
	isCollapsed: boolean;
}

interface Thread {
	id: string;
	subject: string;
	messages: ThreadMessage[];
	unreadCount: number;
	lastMessageDate: Date;
}

export function MailPage() {
	document.title = "Coleo Observatory - Mail";
	const [inbox, setInbox] = useState<{
		messages: MailMessage[];
		pagination: { unread: number };
	} | null>(null);
	const [sent, setSent] = useState<{ messages: MailMessage[] } | null>(null);
	const [archive, setArchive] = useState<{ messages: MailMessage[] } | null>(
		null,
	);
	const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
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

	const loadMail = useCallback(async () => {
		try {
			const [inboxRes, sentRes, archiveRes] = await Promise.all([
				api.listInbox({ limit: 50 }),
				api.listSent({ limit: 50 }),
				api.listArchive({ limit: 50 }),
			]);
			setInbox(inboxRes);
			setSent(sentRes);
			setArchive(archiveRes);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load mail");
		} finally {
			setLoading(false);
		}
	}, []);

	const handleWSMessage = useCallback(
		(msg: { channel?: string; event?: string; data?: unknown }) => {
			if (msg.channel === "mail") {
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
		loadMail();
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
	const threads = useMemo(() => {
		// Combine all messages from all folders for proper threading
		const allMessages = [
			...(inbox?.messages || []),
			...(sent?.messages || []),
			...(archive?.messages || []),
		];

		const threadMap = new Map<string, Thread>();

		allMessages.forEach((msg) => {
			// Use subject as thread key (normalize by removing Re: and Fwd: prefixes)
			const normalizedSubject = msg.subject
				.replace(/^(Re:|Fwd:|RE:|FWD:)\s*/i, "")
				.trim();

			// Also check In-Reply-To header for more accurate threading
			const inReplyTo = msg.headers["in-reply-to"];
			const references = msg.headers["references"];

			// Use message-id from headers as thread ID if available, otherwise use normalized subject
			let threadId = normalizedSubject;

			// If this is a reply, try to find the parent thread
			if (inReplyTo || references) {
				// Check if there's an existing thread that matches
				for (const [existingId, thread] of threadMap) {
					if (
						thread.messages.some(
							(m) =>
								inReplyTo?.includes(m.message.headers["message-id"] || "") ||
								references?.includes(m.message.headers["message-id"] || ""),
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
			// Only auto-collapse if explicitly in collapsedThreads state
			const isCollapsed = collapsedThreads.has(`${threadId}-${msg.id}`);

			thread.messages.push({
				message: msg,
				isCollapsed,
			});

			if (!msg.flags.seen) {
				thread.unreadCount++;
			}

			const msgDate = new Date(msg.date);
			if (msgDate > thread.lastMessageDate) {
				thread.lastMessageDate = msgDate;
			}
		});

		// Sort messages within each thread by date (oldest first)
		threadMap.forEach((thread) => {
			thread.messages.sort(
				(a, b) =>
					new Date(a.message.date).getTime() -
					new Date(b.message.date).getTime(),
			);
		});

		// Sort threads by last message date (newest first)
		let sortedThreads = Array.from(threadMap.values()).sort(
			(a, b) => b.lastMessageDate.getTime() - a.lastMessageDate.getTime(),
		);

		// Filter threads by activeTab - only show threads that have messages in the selected folder
		if (activeTab === "inbox") {
			sortedThreads = sortedThreads.filter((t) =>
				t.messages.some((m) =>
					inbox?.messages.some((im) => im.id === m.message.id),
				),
			);
		} else if (activeTab === "sent") {
			sortedThreads = sortedThreads.filter((t) =>
				t.messages.some((m) =>
					sent?.messages.some((sm) => sm.id === m.message.id),
				),
			);
		} else if (activeTab === "archive") {
			sortedThreads = sortedThreads.filter((t) =>
				t.messages.some((m) =>
					archive?.messages.some((am) => am.id === m.message.id),
				),
			);
		}

		return sortedThreads;
	}, [inbox, sent, archive, activeTab, collapsedThreads]);

	const selectedThread = threads.find((t) => t.id === selectedThreadId);

	// Find first unread message index in selected thread
	const firstUnreadIndex = selectedThread
		? selectedThread.messages.findIndex((m) => !m.message.flags.seen)
		: -1;

	const selectedInboxUnreadMessageIds = useMemo(() => {
		if (!selectedThread || activeTab !== "inbox") return [];

		const inboxMessageIds = new Set(
			(inbox?.messages ?? []).map((message) => message.id),
		);

		return selectedThread.messages
			.map((threadMessage) => threadMessage.message)
			.filter((message) => !message.flags.seen && inboxMessageIds.has(message.id))
			.map((message) => message.id);
	}, [activeTab, inbox?.messages, selectedThread]);
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
	useEffect(() => {
		if (!selectedThreadId || selectedInboxUnreadMessageIds.length === 0) return;

		const timer = window.setTimeout(() => {
			void markThreadRead(selectedInboxUnreadMessageIds);
		}, 4000);

		return () => window.clearTimeout(timer);
	}, [markThreadRead, selectedInboxUnreadMessageIdsKey, selectedThreadId]);

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
		(thread: Thread) => {
			const lastMessage = thread.messages[thread.messages.length - 1];
			if (!lastMessage) return;

			openReply({
				messageId: lastMessage.message.id,
				from: lastMessage.message.from,
				subject: thread.subject,
				body: lastMessage.message.body,
			});
		},
		[openReply],
	);

	const archiveThread = useCallback(
		async (thread: Thread) => {
			const threadIndex = threads.findIndex(
				(candidateThread) => candidateThread.id === thread.id,
			);
			const fallbackThreadId =
				threadIndex >= 0
					? (threads[threadIndex + 1]?.id ??
						threads[threadIndex - 1]?.id ??
						null)
					: null;

			try {
				await Promise.all(
					thread.messages.map((message) => api.archiveMail(message.message.id)),
				);
				await loadMail();
				setSelectedThreadId(fallbackThreadId);
			} catch (err) {
				console.error("Failed to archive thread:", err);
			}
		},
		[loadMail, threads],
	);

	// Gmail-style keyboard shortcuts (mail page only):
	// c = compose, r = reply, j/k = next/previous thread, e = archive.
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
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
			const currentIndex = selectedThreadId
				? threads.findIndex((thread) => thread.id === selectedThreadId)
				: -1;

			if (key === "c") {
				event.preventDefault();
				openNewMessage();
				return;
			}

			if (key === "r" && selectedThread) {
				event.preventDefault();
				replyToThread(selectedThread);
				return;
			}

			if (key === "j" && threads.length > 0) {
				event.preventDefault();
				const nextIndex =
					currentIndex === -1
						? 0
						: Math.min(currentIndex + 1, threads.length - 1);
				setSelectedThreadId(threads[nextIndex]?.id ?? null);
				return;
			}

			if (key === "k" && threads.length > 0) {
				event.preventDefault();
				const previousIndex =
					currentIndex === -1
						? threads.length - 1
						: Math.max(currentIndex - 1, 0);
				setSelectedThreadId(threads[previousIndex]?.id ?? null);
				return;
			}

			if (key === "e" && selectedThread && activeTab !== "archive") {
				event.preventDefault();
				void archiveThread(selectedThread);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [
		activeTab,
		archiveThread,
		openNewMessage,
		replyToThread,
		selectedThread,
		selectedThreadId,
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

	return (
		<div className="p-4 space-y-4 h-screen flex flex-col">
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
						{tab === "inbox" && inbox?.pagination.unread ? (
							<Chip size="sm" color="danger" className="ml-1">
								{inbox.pagination.unread}
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
														<div className="pl-9 min-w-0 overflow-hidden">
															<pre className="whitespace-pre-wrap break-words text-sm font-mono bg-secondary/30 p-3 rounded overflow-auto max-h-80 max-w-full">
																{threadMsg.message.body}
															</pre>

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
