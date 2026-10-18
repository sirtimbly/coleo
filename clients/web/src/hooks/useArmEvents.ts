import { useEffect, useRef, useState, useCallback } from 'react';
import { api, isJsonObject, isOpenCodeEvent, type JsonValue, type OpenCodeEvent } from '@/lib';

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
  const onEventRef = useRef(onEvent);
  const [state, setState] = useState<ArmEventsState>({
    connected: false,
    error: null,
    lastEventTime: null,
  });

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

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
      if (eventSourceRef.current !== eventSource) return;
      console.log('[ArmEvents] Connected');
      setState({
        connected: true,
        error: null,
        lastEventTime: Date.now(),
      });
    };

    eventSource.onmessage = (event) => {
      if (eventSourceRef.current !== eventSource) return;
      try {
        const parsed = JSON.parse(event.data) as JsonValue;
        const data = isOpenCodeEvent(parsed)
          ? parsed
          : isJsonObject(parsed) &&
              typeof parsed.type === 'string' &&
              isJsonObject(parsed.data)
            ? {
                type: parsed.type,
                properties: parsed.data,
                timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
                sequence: typeof parsed.sequence === 'number' ? parsed.sequence : undefined,
              }
            : null;
        if (!data) {
          throw new Error('Invalid arm event payload');
        }
        setState(s => ({ ...s, lastEventTime: Date.now() }));
        
        if (data.type === 'error') {
          setState(s => ({ ...s, error: String(data.properties?.error || 'Unknown error') }));
        } else {
          onEventRef.current?.(data);
        }
      } catch (err) {
        console.error('[ArmEvents] Failed to parse event:', err);
      }
    };

    eventSource.onerror = () => {
      if (eventSourceRef.current !== eventSource) return;
      setState(s => ({
        ...s,
        connected: false,
        error: eventSource.readyState === EventSource.CONNECTING ? null : 'Connection error',
      }));
      
      // Keep the EventSource open so its native reconnect behavior can recover.
    };
  }, [armId]);

  const disconnect = useCallback(() => {
    const eventSource = eventSourceRef.current;
    if (eventSource) {
      console.log('[ArmEvents] Disconnecting');
      eventSource.close();
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
