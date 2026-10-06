import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { api } from "@/lib/api";
import { useLiveProjections, useProjectionSignal } from "./live-projections";
import { ProjectionController } from "../../../workbench/projection-controller";
import { reconcileMessagingPage } from "../../../workbench/messaging-collection";
import { compareMessagingPositions, messagingQueryIdentity } from "../../../workbench/messaging-query";
import { validateMessagingResponseIdentity } from "../../../workbench/messaging-response";

import type { MessagingCollectionPage, MessagingItem } from "../../../workbench/messaging-collection";
import type { MessagingQuery } from "../../../workbench/messaging-query";

interface QueryOwner {
	controller: ProjectionController<MessagingCollectionPage>;
	pages: number;
}

const owners = new Map<string, QueryOwner>();

function queryOwner(query: MessagingQuery): QueryOwner {
	const key = messagingQueryIdentity(query);
	const existing = owners.get(key);
	if (existing) return existing;
	if (owners.size >= 32) {
		const unused = [...owners.entries()].find(([, owner]) => !owner.controller.active);
		if (unused) { unused[1].controller.dispose(); owners.delete(unused[0]); }
	}
	const owner: QueryOwner = { pages: 1, controller: new ProjectionController(async (signal, previous) => {
		const pages: MessagingCollectionPage[] = [];
		let cursor: string | undefined;
		const wanted = owner.pages;
		for (let page = 0; page < wanted; page++) {
			const response = await api.getMessagingCollection(query, cursor, signal);
			validateMessagingResponseIdentity(response, key);
			pages.push(response);
			if (!response.nextCursor || !response.summaries.complete) break;
			cursor = response.nextCursor;
		}
		const first = pages[0]!;
		const items = new Map<string, MessagingItem>();
		for (const page of pages) for (const item of page.items) if (!items.has(item.id)) items.set(item.id, item);
		const complete = pages.every((page) => page.summaries.complete);
		const coveredSources = first.sources.map((source) => pages.flatMap((page) => page.sources)
			.find((candidate) => candidate.id === source.id && (candidate.status !== "fresh" || !candidate.complete)) ?? source);
		const interrupted = !complete && pages.length < wanted;
		const combined = { ...first, cursor: null, items: [...items.values()], nextCursor: pages.at(-1)!.nextCursor,
			summaries: { ...first.summaries, complete },
			sources: interrupted ? coveredSources.map((source) => ({ ...source, complete: false })) : coveredSources };
		if (combined.summaries.complete && owner.pages === wanted) owner.pages = pages.length;
		const result = reconcileMessagingPage(previous, combined);
		const merged = new Map(result.items.map((item) => [item.id, item]));
		// Healthy page sections can update known IDs even when a missing source prevented whole-window replacement.
		if (interrupted) for (const item of items.values()) {
			if (first.sources.some((source) => source.id === item.sourceId && source.status === "fresh" && source.complete)) merged.set(item.id, item);
		}
		return { ...result, items: [...merged.values()].sort((left, right) => compareMessagingPositions(left, right, query.sort.direction)) };
	}) };
	owners.set(key, owner);
	return owner;
}

export function useMessagingCollection(query: MessagingQuery) {
	const key = messagingQueryIdentity(query);
	const owner = useMemo(() => queryOwner(JSON.parse(key) as MessagingQuery), [key]);
	const snapshot = useSyncExternalStore(owner.controller.subscribe, owner.controller.getSnapshot, owner.controller.getSnapshot);
	const [confirmed, setConfirmed] = useState(snapshot.value);
	// Retain the last rendered window while the new query is pending; never write it into that query's cache.
	if (snapshot.value && snapshot.value !== confirmed) setConfirmed(snapshot.value);
	const { recoveryRevision } = useLiveProjections();
	const lastRecovery = useRef(recoveryRevision);
	useEffect(() => {
		if (lastRecovery.current !== recoveryRevision) { lastRecovery.current = recoveryRevision; owner.controller.schedule(); }
	}, [owner, recoveryRevision]);
	useProjectionSignal((signal) => {
		if (/heartbeat|metric|sample/.test(signal.event)) return;
		const relevant = query.scope === "mail" || query.facet === "messages"
			? signal.channel === "mail" || signal.channel === "workbench" && signal.event.includes("attention")
			: ["mail", "brain", "arms", "arm-events", "activity", "tasks", "bugs", "proposals"].includes(signal.channel) ||
				signal.channel === "workbench" && signal.event.includes("attention");
		if (relevant) owner.controller.schedule();
	});
	const refresh = useCallback(() => owner.controller.refresh(), [owner]);
	const beginMutation = useCallback(() => owner.controller.beginMutation(), [owner]);
	const loadMore = useCallback(() => {
		if (!owner.controller.getSnapshot().value?.nextCursor) return Promise.resolve();
		owner.pages++; return owner.controller.refresh();
	}, [owner]);
	return { ...snapshot, value: snapshot.value ?? confirmed, pendingQuery: snapshot.value === undefined, refresh, loadMore, beginMutation };
}
