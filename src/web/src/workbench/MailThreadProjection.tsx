/**
 * Threaded project-message detail projection for the unified Inbox.
 *
 * Reply depth comes from message headers and is expressed as indentation and
 * a stable guide color. Archive operates on every inbox message in the thread.
 */

import { useMemo } from "react";
import { Button } from "@heroui/react";
import { Archive, Bot, Mail, Reply, UserRound, X } from "lucide-react";

import { WorkbenchEmptyState, WorkbenchHeader } from "@/design-system/WorkbenchSurface";
import { cn, type MailMessage } from "@/lib";
import {
	getConsecutiveReplyLevels,
	getInboxMessageIdsForThread,
	getMailMessageId,
	getMailThreadId,
	type MailThread,
} from "@/pages/mail-page-utils";

const THREAD_GUIDES = [
	"border-blue-500/60",
	"border-emerald-500/60",
	"border-amber-500/60",
	"border-fuchsia-500/60",
] as const;

export function MailThreadProjection({
	thread,
	inboxMessages,
	sentMessages,
	onReply,
	onArchive,
	onClose,
	archiving = false,
}: {
	thread: MailThread | null;
	inboxMessages: MailMessage[];
	sentMessages: MailMessage[];
	onReply: (context: {
		messageId: string;
		threadId: string;
		from: string;
		subject: string;
		body: string;
	}) => void;
	onArchive: (messageIds: string[]) => void;
	onClose: () => void;
	archiving?: boolean;
}) {
	const sentIds = useMemo(
		() => new Set(sentMessages.map((message) => message.id)),
		[sentMessages],
	);

	if (!thread) {
		return (
			<WorkbenchEmptyState
				title="Thread unavailable"
				description="It may have moved to another mailbox. Refresh the Inbox to reconcile it."
				icon={<Mail className="h-4 w-4" />}
			/>
		);
	}

	const latest = thread.messages.at(-1)?.message;
	const replyTarget = [...thread.messages]
		.reverse()
		.map((entry) => entry.message)
		.find((message) => !sentIds.has(message.id)) ?? latest;
	const inboxMessageIds = getInboxMessageIdsForThread(thread, inboxMessages);
	const replyLevels = getConsecutiveReplyLevels(thread, THREAD_GUIDES.length);
	const reply = () => {
		if (!replyTarget) return;
		onReply({
			messageId: getMailMessageId(replyTarget),
			threadId: getMailThreadId(replyTarget, thread.id),
			from: replyTarget.from,
			subject: thread.subject,
			body: replyTarget.body,
		});
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkbenchHeader
				title={thread.subject}
				description={`${thread.messages.length} ${thread.messages.length === 1 ? "message" : "messages"} · threaded project communication`}
				icon={<Mail className="h-4 w-4" />}
				actions={
					<>
						<Button size="sm" variant="ghost" onPress={reply} isDisabled={!replyTarget}>
							<Reply className="h-3.5 w-3.5" />
							Reply
						</Button>
						{inboxMessageIds.length > 0 ? (
							<Button
								size="sm"
								variant="ghost"
								onPress={() => onArchive(inboxMessageIds)}
								isDisabled={archiving}
							>
								<Archive className="h-3.5 w-3.5" />
								{archiving ? "Archiving…" : "Archive"}
							</Button>
						) : null}
						<Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close thread">
							<X className="h-3.5 w-3.5" />
						</Button>
					</>
				}
			/>
			<div className="min-h-0 flex-1 overflow-auto bg-surface-secondary/25 p-4">
				<div className="mx-auto max-w-4xl space-y-3">
					{thread.messages.map((threadMessage, index) => {
						const message = threadMessage.message;
						const sent = sentIds.has(message.id);
						const automated = /\b(?:brain|arm|coleo)\b/i.test(message.from);
						const level = replyLevels[index] ?? 0;
						return (
							<div
								key={message.id}
								className={cn("border-l-2 pl-3", THREAD_GUIDES[index % THREAD_GUIDES.length])}
								style={{ marginLeft: `${level * 1.5}rem` }}
								data-thread-depth={level}
							>
								<article className="border border-border bg-surface p-4">
									<header className="flex items-start gap-3">
										<span className="flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-surface-secondary text-muted-foreground">
											{automated ? <Bot className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}
										</span>
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className="truncate text-sm font-semibold">{message.from}</span>
												<span className="text-xs text-muted-foreground">
													{sent ? "Sent" : index > 0 ? "Reply" : "Received"}
												</span>
												<time className="ml-auto text-xs text-muted-foreground">
													{new Date(message.date).toLocaleString()}
												</time>
											</div>
											<div className="mt-1 text-xs text-muted-foreground">To {message.to}</div>
										</div>
									</header>
									<p className="readable-copy mt-4 whitespace-pre-wrap">{message.body}</p>
									<div className="mt-4">
										<Button size="sm" variant="ghost" onPress={reply}>
											<Reply className="h-3.5 w-3.5" />
											Reply
										</Button>
									</div>
								</article>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
