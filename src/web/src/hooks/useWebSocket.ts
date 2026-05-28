import { useEffect, useRef, useState, useCallback } from 'react';
import { api, type JsonValue } from '@/lib';

type Channel = 'arms' | 'activity' | 'proposals' | 'brain' | 'mail' | 'tasks' | 'bugs' | 'arm-events' | 'all';

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

export function useWebSocket({ channels, onMessage, autoConnect = true }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const channelsRef = useRef(channels);
  const onMessageRef = useRef(onMessage);
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttempts = useRef(0);
  const shouldReconnectRef = useRef(false);

  channelsRef.current = channels;
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    shouldReconnectRef.current = true;
    const apiKey = api.getApiKey();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    console.log('[WS] Connecting to', wsUrl);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] Connected');
      setConnected(true);
      reconnectAttempts.current = 0;

      // Direct/self-hosted clients authenticate in-band. In Reef, the reverse
      // proxy authenticates the upgrade and the server sends the same success
      // message without exposing its private credential to this browser.
      if (apiKey) {
        ws.send(JSON.stringify({ type: 'auth', apiKey }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg: WebSocketMessage = JSON.parse(event.data);

        if (msg.type === 'auth') {
          if (msg.success) {
            console.log('[WS] Authenticated');
            setAuthenticated(true);

            // Subscribe to channels
            for (const channel of channelsRef.current) {
              ws.send(JSON.stringify({ type: 'subscribe', channel }));
            }
          } else {
            console.error('[WS] Auth failed:', msg.error);
            setAuthenticated(false);
          }
        } else if (msg.type === 'pong') {
          // Heartbeat response
        } else {
          onMessageRef.current?.(msg);
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      setConnected(false);
      setAuthenticated(false);
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      if (!shouldReconnectRef.current) return;

      // Reconnect with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
      reconnectAttempts.current++;
      console.log(`[WS] Reconnecting in ${delay}ms...`);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connect();
      }, delay);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };

    wsRef.current = ws;

    // Start heartbeat
    pingIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }, []);

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      ws.onclose = null;
      ws.close();
    }
    setConnected(false);
    setAuthenticated(false);
  }, []);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  return {
    connected,
    authenticated,
    connect,
    disconnect,
  };
}
