import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { Archive, Mail, Reply, X } from "lucide-react";

import { api, useMessage } from "@/lib";
import { presentMessage } from "@/adaptive-cards/presenters";
import { DeferredAdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import { WorkbenchEmptyState, WorkbenchHeader } from "@/design-system/WorkbenchSurface";
import { useLiveProjections } from "@/workbench/live-projections";
import { indexResourceHierarchy, visibleHierarchyRows } from "../../../src/workbench/resource-hierarchy";
import { useWorkspaceCloseRoute, useWorkspaceSearchParams } from "@/workspace/route-context";

import type { MessagingMailbox } from "../../../src/workbench/messaging-query";

export function MessagingThreadDetail({ threadId, mailbox, routePath }: {
	threadId: string; mailbox: MessagingMailbox; routePath: string;
}) {
	const close = useWorkspaceCloseRoute(routePath);
	const [params] = useWorkspaceSearchParams();
	const { openReply } = useMessage();
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const { data, error, refetch } = useQuery({ queryKey: ["mail", "thread", mailbox, threadId],
		queryFn: ({ signal }) => api.getMailThread(threadId, mailbox, signal), staleTime: 0, retry: false });
	const { recoveryRevision } = useLiveProjections();
	const previousRecovery = useRef(recoveryRevision);
	useEffect(() => { if (previousRecovery.current !== recoveryRevision) {
		previousRecovery.current = recoveryRevision; void refetch();
	} }, [recoveryRevision, refetch]);
	const index = useMemo(() => data ? indexResourceHierarchy(data.thread.hierarchy) : null, [data]);
	const rows = index ? visibleHierarchyRows(index, new Set(index.preorder)).filter((row) => row.node.selectable) : [];
	if (!data) return <WorkbenchEmptyState title={error ? "Thread unavailable" : "Loading thread"}
		description={error?.message ?? "Loading the conversation and its reply relationships."} />;
	const { thread, messages } = data;
	const byId = new Map(messages.map((message) => [message.id, message]));
	const focusedId = params.get("message");
	const target = (focusedId ? messages.find((message) => message.id === `message:${focusedId}`) : undefined)
		?? [...messages].reverse().find((message) => index?.byId.get(message.id)?.data.locations.some((location) => location.mailbox === "inbox"))
		?? messages.at(-1);
	const reply = (message = target) => {
		if (!message) return;
		openReply({ messageId: index!.byId.get(message.id)!.data.messageId!, threadId: thread.id,
			from: message.from, subject: thread.subject, body: message.body });
	};
	const archive = async () => {
		setBusy(true);
		try {
			await api.executeMailThreadAction(thread.id, mailbox, thread.revision,
				thread.hierarchy.nodes.filter((node) => node.selectable).map((node) => node.id), "archive");
			close();
		} catch (reason) { setActionError(reason instanceof Error ? reason.message : "Could not archive thread"); await refetch(); }
		finally { setBusy(false); }
	};
	return <div className="flex h-full min-h-0 flex-col bg-background">
		<WorkbenchHeader title={thread.subject} description={`${messages.length} messages · source-owned reply relationships`}
			icon={<Mail className="h-4 w-4" />} actions={<>
				<Button size="sm" variant="ghost" onPress={() => reply()} isDisabled={!target}><Reply className="h-3.5 w-3.5" />Reply</Button>
				{thread.hierarchy.nodes.some((node) => node.data.locations.some((location) => location.mailbox === "inbox")) &&
					<Button size="sm" variant="ghost" onPress={() => void archive()} isDisabled={busy}><Archive className="h-3.5 w-3.5" />{busy ? "Archiving…" : "Archive"}</Button>}
				<Button isIconOnly size="sm" variant="ghost" onPress={close} aria-label="Close thread"><X className="h-3.5 w-3.5" /></Button>
			</>} />
		{actionError && <p role="alert" className="border-b border-danger/20 bg-danger/10 p-3 text-sm text-danger">{actionError}</p>}
		<div className="min-h-0 flex-1 overflow-auto bg-surface-secondary/25 p-4"><div className="mx-auto max-w-4xl space-y-3">
			{rows.map((row) => {
				const message = byId.get(row.node.id);
				if (!message) return null;
				const sent = !row.node.data.locations.some((location) => location.mailbox === "inbox");
				return <article key={row.node.id} className="border-l-2 border-accent/50 pl-3" style={{ marginLeft: `${(row.depth - 1) * 24}px` }} data-thread-depth={row.depth - 1}>
					<DeferredAdaptiveCardView envelope={presentMessage({ id: message.id, from: message.from, subject: thread.subject,
						preview: message.body, timestamp: message.timestamp, sent })} allCardsDefault="detail" />
					<Button size="sm" variant="ghost" onPress={() => reply(message)}><Reply className="h-3.5 w-3.5" />Reply</Button>
				</article>;
			})}
		</div></div>
	</div>;
}
