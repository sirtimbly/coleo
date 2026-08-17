/**
 * Shared browser WebSocket transport.
 *
 * Every legacy page and new workbench projection uses this hook, but the module
 * owns only one physical connection. Subscribers are fan-out listeners with
 * channel reference counting, which prevents high-pane Golden Layout
 * workspaces from opening one socket and heartbeat timer per panel.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { api, type JsonValue } from "@/lib";

export type Channel =
	| "arms"
	| "activity"
	| "proposals"
	| "brain"
	| "mail"
	| "tasks"
	| "bugs"
	| "arm-events"
	| "agents"
	| "workbench"
	| "all";

export interface WebSocketMessage {
	type: string;
	channel?: Channel;
	event?: string;
	data?: JsonValue;
	timestamp?: string;
	success?: boolean;
	error?: string;
}

interface UseWebSocketOptions {
	channels: Channel[];
	onMessage?: (message: WebSocketMessage) => void;
	autoConnect?: boolean;
}

interface ConnectionSnapshot {
	connected: boolean;
	authenticated: boolean;
}

interface Subscriber {
	channels: Set<Channel>;
	onMessageRef: { current: UseWebSocketOptions["onMessage"] };
}

const DISCONNECTED_SNAPSHOT: ConnectionSnapshot = {
	connected: false,
	authenticated: false,
};

class SharedWebSocketTransport {
	private socket: WebSocket | null = null;
	private subscribers = new Set<Subscriber>();
	private stateListeners = new Set<() => void>();
	private channelCounts = new Map<Channel, number>();
	private snapshot: ConnectionSnapshot = DISCONNECTED_SNAPSHOT;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectAttempts = 0;
	private shouldReconnect = false;

	getSnapshot = (): ConnectionSnapshot => this.snapshot;

	subscribeState = (listener: () => void): (() => void) => {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	};

	addSubscriber(subscriber: Subscriber): () => void {
		this.subscribers.add(subscriber);
		for (const channel of subscriber.channels) {
			const count = this.channelCounts.get(channel) ?? 0;
			this.channelCounts.set(channel, count + 1);
			if (count === 0 && this.snapshot.authenticated) {
				this.send({ type: "subscribe", channel });
			}
		}
		this.connect();

		return () => {
			this.subscribers.delete(subscriber);
			for (const channel of subscriber.channels) {
				const count = this.channelCounts.get(channel) ?? 0;
				if (count <= 1) {
					this.channelCounts.delete(channel);
					if (this.snapshot.authenticated) {
						this.send({ type: "unsubscribe", channel });
					}
				} else {
					this.channelCounts.set(channel, count - 1);
				}
			}
		};
	}

	connect = (): void => {
		if (typeof window === "undefined") return;
		if (
			this.socket?.readyState === WebSocket.OPEN ||
			this.socket?.readyState === WebSocket.CONNECTING
		) {
			return;
		}

		this.shouldReconnect = true;
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
		this.socket = socket;

		socket.onopen = () => {
			this.reconnectAttempts = 0;
			this.setSnapshot({ connected: true, authenticated: false });
			this.send({ type: "auth", apiKey: api.getApiKey() ?? "" });
		};

		socket.onmessage = (event) => {
			try {
				const message = JSON.parse(String(event.data)) as WebSocketMessage;
				if (message.type === "auth") {
					if (message.success) {
						this.setSnapshot({ connected: true, authenticated: true });
						for (const channel of this.channelCounts.keys()) {
							this.send({ type: "subscribe", channel });
						}
					} else {
						this.setSnapshot({ connected: true, authenticated: false });
					}
					return;
				}
				if (message.type === "pong") return;

				for (const subscriber of this.subscribers) {
					if (
						message.channel &&
						(subscriber.channels.has(message.channel) || subscriber.channels.has("all"))
					) {
						subscriber.onMessageRef.current?.(message);
					}
				}
			} catch (error) {
				console.error("[WS] Failed to parse message:", error);
			}
		};

		socket.onerror = (error) => {
			console.error("[WS] Connection error:", error);
		};

		socket.onclose = () => {
			if (this.socket === socket) this.socket = null;
			this.stopHeartbeat();
			this.setSnapshot(DISCONNECTED_SNAPSHOT);
			if (!this.shouldReconnect || this.subscribers.size === 0) return;
			const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 30_000);
			this.reconnectAttempts += 1;
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				this.connect();
			}, delay);
		};

		this.startHeartbeat();
	};

	disconnect = (): void => {
		this.shouldReconnect = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.stopHeartbeat();
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.onclose = null;
			socket.close();
		}
		this.setSnapshot(DISCONNECTED_SNAPSHOT);
	};

	private send(message: Record<string, unknown>): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.pingTimer = setInterval(() => this.send({ type: "ping" }), 30_000);
	}

	private stopHeartbeat(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = null;
	}

	private setSnapshot(next: ConnectionSnapshot): void {
		if (
			next.connected === this.snapshot.connected &&
			next.authenticated === this.snapshot.authenticated
		) {
			return;
		}
		this.snapshot = next;
		for (const listener of this.stateListeners) listener();
	}
}

const sharedTransport = new SharedWebSocketTransport();

export function useWebSocket({
	channels,
	onMessage,
	autoConnect = true,
}: UseWebSocketOptions) {
	const onMessageRef = useRef(onMessage);
	onMessageRef.current = onMessage;
	const channelKey = [...channels].sort().join("|");
	const snapshot = useSyncExternalStore(
		sharedTransport.subscribeState,
		sharedTransport.getSnapshot,
		() => DISCONNECTED_SNAPSHOT,
	);

	useEffect(() => {
		if (!autoConnect) return;
		const subscriber: Subscriber = {
			channels: new Set(channelKey.split("|").filter(Boolean) as Channel[]),
			onMessageRef,
		};
		return sharedTransport.addSubscriber(subscriber);
	}, [autoConnect, channelKey]);

	const connect = useCallback(() => sharedTransport.connect(), []);
	const disconnect = useCallback(() => sharedTransport.disconnect(), []);

	return {
		...snapshot,
		connect,
		disconnect,
	};
}
