import { useEffect, useRef, useState, useCallback } from 'react';
import { api, isOpenCodeEvent, type OpenCodeEvent } from '@/lib';

interface UseArmEventsOptions {
  armId: string | null;
  onEvent?: (event: OpenCodeEvent) => void;
  autoConnect?: boolean;
}

interface ArmEventsState {
  connected: boolean;
  error: string | null;
  lastEventTime: number | null;
}

export function useArmEvents({ armId, onEvent, autoConnect = true }: UseArmEventsOptions) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const [state, setState] = useState<ArmEventsState>({
    connected: false,
    error: null,
    lastEventTime: null,
  });

  const connect = useCallback(() => {
    if (!armId) {
      setState(s => ({ ...s, error: 'No arm ID provided' }));
      return;
    }

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = api.getArmEventsUrl(armId);
    console.log('[ArmEvents] Connecting to', url);

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      console.log('[ArmEvents] Connected');
      setState({
        connected: true,
        error: null,
        lastEventTime: Date.now(),
      });
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!isOpenCodeEvent(data)) {
          throw new Error('Invalid arm event payload');
        }
        setState(s => ({ ...s, lastEventTime: Date.now() }));
        
        if (data.type === 'error') {
          setState(s => ({ ...s, error: String(data.properties?.error || 'Unknown error') }));
        } else if (onEvent) {
          onEvent(data);
        }
      } catch (err) {
        console.error('[ArmEvents] Failed to parse event:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('[ArmEvents] Error:', err);
      setState(s => ({
        ...s,
        connected: false,
        error: 'Connection error',
      }));
      
      // EventSource will auto-reconnect, but we might want to handle this
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [armId, onEvent]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      console.log('[ArmEvents] Disconnecting');
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState({
      connected: false,
      error: null,
      lastEventTime: null,
    });
  }, []);

  // Auto-connect when armId changes
  useEffect(() => {
    if (autoConnect && armId) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [armId, autoConnect, connect, disconnect]);

  return {
    ...state,
    connect,
    disconnect,
  };
}
