/**
 * Route-level immutable event projection.
 *
 * Live signals prepend through the shared transport by refreshing the first
 * page, while cursor pagination loads older JetStream-backed activity.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { usePageTitle } from "@/hooks/usePageTitle";
import { api, type ActivityEntry } from "@/lib";
import { EventTimeline } from "@/workbench/EventTimeline";
import { useProjectionSignal } from "@/workbench/live-projections";

export function ActivityPage() {
	usePageTitle("Coleo Observatory - Event Timeline");
	const [events, setEvents] = useState<ActivityEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [nextCursor, setNextCursor] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);
	const refreshTimerRef = useRef<number | null>(null);

	const loadFirstPage = useCallback(async () => {
		setLoading(true);
		try {
			const response = await api.listActivity({ limit: 100 });
			setEvents(response.activity);
			setTotal(response.pagination.total);
			setNextCursor(response.pagination.nextCursor);
		} finally {
			setLoading(false);
		}
	}, []);

	const loadMore = useCallback(async () => {
		if (!nextCursor || loading) return;
		setLoading(true);
		try {
			const response = await api.listActivity({ limit: 100, beforeSequence: nextCursor });
			setEvents((current) => {
				const seen = new Set(current.map((event) => event.id));
				return [...current, ...response.activity.filter((event) => !seen.has(event.id))];
			});
			setNextCursor(response.pagination.nextCursor);
		} finally {
			setLoading(false);
		}
	}, [loading, nextCursor]);

	useEffect(() => {
		void loadFirstPage();
	}, [loadFirstPage]);

	useProjectionSignal((signal) => {
		if (signal.channel !== "activity") return;
		if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
		refreshTimerRef.current = window.setTimeout(() => {
			refreshTimerRef.current = null;
			void loadFirstPage();
		}, 150);
	});

	useEffect(() => () => {
		if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
	}, []);

	return (
		<EventTimeline
			events={events}
			total={total}
			loading={loading}
			onRefresh={() => void loadFirstPage()}
			onLoadMore={() => void loadMore()}
			hasMore={nextCursor !== null}
		/>
	);
}
