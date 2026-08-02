/**
 * Live projection coordinator.
 *
 * The provider consumes the shared WebSocket once, invalidates the narrowest
 * React Query cache affected by each server message, and records attention
 * signals for background workbench panels.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
	type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useWebSocket, type WebSocketMessage } from "@/hooks/useWebSocket";
import { bugsKeys, tasksKeys } from "@/lib/queryKeys";

import type { ProjectionSignal, WorkbenchChannel } from "./types";

type SignalListener = (signal: ProjectionSignal) => void;

interface AttentionSnapshot {
	revision: number;
	channels: Partial<Record<WorkbenchChannel, number>>;
}

interface LiveProjectionContextValue {
	connected: boolean;
	authenticated: boolean;
	subscribe: (listener: SignalListener) => () => void;
	attention: AttentionSnapshot;
	clearAttention: (channels?: WorkbenchChannel[]) => void;
}

const EMPTY_ATTENTION: AttentionSnapshot = { revision: 0, channels: {} };
const LiveProjectionContext = createContext<LiveProjectionContextValue | null>(null);

function invalidateForMessage(
	queryClient: ReturnType<typeof useQueryClient>,
	message: WebSocketMessage,
): void {
	switch (message.channel) {
		case "tasks":
			void queryClient.invalidateQueries({ queryKey: tasksKeys.all() });
			void queryClient.invalidateQueries({ queryKey: ["runs"] });
			break;
		case "bugs":
			void queryClient.invalidateQueries({ queryKey: bugsKeys.all() });
			void queryClient.invalidateQueries({ queryKey: ["runs"] });
			break;
		case "arms":
		case "arm-events":
		case "agents":
			void queryClient.invalidateQueries({ queryKey: ["arms"] });
			void queryClient.invalidateQueries({ queryKey: ["events"] });
			void queryClient.invalidateQueries({ queryKey: ["runs"] });
			break;
		case "mail":
			void queryClient.invalidateQueries({ queryKey: ["mail"] });
			break;
		case "brain":
			void queryClient.invalidateQueries({ queryKey: ["brain"] });
			break;
		case "activity":
		case "proposals":
			void queryClient.invalidateQueries({ queryKey: [message.channel] });
			break;
		case "workbench":
			void queryClient.invalidateQueries({ queryKey: ["workbench"] });
			break;
		default:
			break;
	}
}

function isWorkbenchChannel(value: WebSocketMessage["channel"]): value is WorkbenchChannel {
	return Boolean(value && value !== "all");
}

export function LiveProjectionProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient();
	const listenersRef = useRef(new Set<SignalListener>());
	const attentionListenersRef = useRef(new Set<() => void>());
	const attentionRef = useRef<AttentionSnapshot>(EMPTY_ATTENTION);

	const publishAttention = useCallback((channel: WorkbenchChannel) => {
		const current = attentionRef.current;
		attentionRef.current = {
			revision: current.revision + 1,
			channels: {
				...current.channels,
				[channel]: (current.channels[channel] ?? 0) + 1,
			},
		};
		for (const listener of attentionListenersRef.current) listener();
	}, []);

	const handleMessage = useCallback((message: WebSocketMessage) => {
		if (!message.event || !message.timestamp || !isWorkbenchChannel(message.channel)) return;
		invalidateForMessage(queryClient, message);
		const signal: ProjectionSignal = {
			channel: message.channel,
			event: message.event,
			timestamp: message.timestamp,
			data: message.data,
		};
		for (const listener of listenersRef.current) listener(signal);
		if (
			message.event.includes("received") ||
			message.event.includes("blocked") ||
			message.event.includes("error") ||
			message.event.includes("failed") ||
			message.event.includes("created") ||
			message.event.includes("updated") ||
			message.event.includes("completed")
		) {
			publishAttention(message.channel);
		}
	}, [publishAttention, queryClient]);

	const connection = useWebSocket({
		channels: ["all"],
		onMessage: handleMessage,
	});

	const subscribe = useCallback((listener: SignalListener) => {
		listenersRef.current.add(listener);
		return () => listenersRef.current.delete(listener);
	}, []);

	const clearAttention = useCallback((channels?: WorkbenchChannel[]) => {
		const current = attentionRef.current;
		if (!channels) {
			if (Object.keys(current.channels).length === 0) return;
			attentionRef.current = { revision: current.revision + 1, channels: {} };
		} else {
			const next = { ...current.channels };
			let changed = false;
			for (const channel of channels) {
				if (channel in next) {
					delete next[channel];
					changed = true;
				}
			}
			if (!changed) return;
			attentionRef.current = { revision: current.revision + 1, channels: next };
		}
		for (const listener of attentionListenersRef.current) listener();
	}, []);

	const attention = useSyncExternalStore(
		useCallback((listener: () => void) => {
			attentionListenersRef.current.add(listener);
			return () => attentionListenersRef.current.delete(listener);
		}, []),
		() => attentionRef.current,
		() => EMPTY_ATTENTION,
	);

	const value = useMemo<LiveProjectionContextValue>(() => ({
		connected: connection.connected,
		authenticated: connection.authenticated,
		subscribe,
		attention,
		clearAttention,
	}), [
		attention,
		clearAttention,
		connection.authenticated,
		connection.connected,
		subscribe,
	]);

	return (
		<LiveProjectionContext.Provider value={value}>
			{children}
		</LiveProjectionContext.Provider>
	);
}

export function useLiveProjections(): LiveProjectionContextValue {
	const context = useContext(LiveProjectionContext);
	if (!context) throw new Error("useLiveProjections must be used inside LiveProjectionProvider");
	return context;
}

export function useProjectionSignal(listener: SignalListener): void {
	const { subscribe } = useLiveProjections();
	const listenerRef = useRef(listener);
	listenerRef.current = listener;

	useEffect(
		() => subscribe((signal) => listenerRef.current(signal)),
		[subscribe],
	);
}
