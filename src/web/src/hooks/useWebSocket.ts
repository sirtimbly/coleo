import { useEffect, useRef, useState, useCallback } from 'react';
import { api, getWebSocketUrl } from '@/lib';

type Channel = 'arms' | 'activity' | 'proposals' | 'brain' | 'mail' | 'tasks' | 'bugs' | 'arm-events' | 'all';

export interface WSMessage {
  type: string;
  channel?: Channel;
  event?: string;
  data?: unknown;
  timestamp?: string;
  success?: boolean;
  error?: string;
}

interface UseWebSocketOptions {
  channels: Channel[];
  onMessage?: (message: WSMessage) => void;
  autoConnect?: boolean;
}

export function useWebSocket({ channels, onMessage, autoConnect = true }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

  const connect = useCallback(() => {
    const apiKey = api.getApiKey();
    if (!apiKey) {
      console.warn('[WS] No API key available');
      return;
    }

    const wsUrl = getWebSocketUrl();

    console.log('[WS] Connecting to', wsUrl);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] Connected');
      setConnected(true);
      reconnectAttempts.current = 0;

      // Authenticate
      ws.send(JSON.stringify({ type: 'auth', apiKey }));
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);

        if (msg.type === 'auth') {
          if (msg.success) {
            console.log('[WS] Authenticated');
            setAuthenticated(true);

            // Subscribe to channels
            for (const channel of channels) {
              ws.send(JSON.stringify({ type: 'subscribe', channel }));
            }
          } else {
            console.error('[WS] Auth failed:', msg.error);
            setAuthenticated(false);
          }
        } else if (msg.type === 'pong') {
          // Heartbeat response
        } else if (onMessage) {
          onMessage(msg);
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      setConnected(false);
      setAuthenticated(false);
      wsRef.current = null;

      // Reconnect with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
      reconnectAttempts.current++;
      console.log(`[WS] Reconnecting in ${delay}ms...`);
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };

    wsRef.current = ws;

    // Start heartbeat
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
    };
  }, [channels, onMessage]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
    setAuthenticated(false);
  }, []);

  useEffect(() => {
    if (autoConnect && api.getApiKey()) {
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
