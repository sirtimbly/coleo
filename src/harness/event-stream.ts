/**
 * OpenCode Event Stream Listener
 * 
 * Subscribes to OpenCode's SSE event stream and forwards events to Octopai.
 * Events include:
 * - session.status: When session status changes (idle/running/pending)
 * - message.*: When messages are sent/received
 * - tool.*: When tools are invoked
 * - todo.*: When todos are updated
 */

export type EventCallback = (event: OpenCodeEvent) => void;

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface EventStreamOptions {
  serverUrl: string;
  armId: string;
  sessionId: string;
  onEvent: EventCallback;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

/**
 * Creates an SSE connection to OpenCode and forwards events
 */
export class OpenCodeEventStream {
  private serverUrl: string;
  private armId: string;
  private sessionId: string;
  private onEvent: EventCallback;
  private onError?: (error: Error) => void;
  private onClose?: () => void;
  private abortController: AbortController | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isClosing = false;

  constructor(options: EventStreamOptions) {
    this.serverUrl = options.serverUrl;
    this.armId = options.armId;
    this.sessionId = options.sessionId;
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.onClose = options.onClose;
  }

  /**
   * Start listening to the event stream
   */
  async start(): Promise<void> {
    if (this.isClosing) return;

    console.log(`[event-stream] Starting event stream for ${this.armId}`);

    // Wait a bit for the server to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    await this.connect();
  }

  /**
   * Stop listening and cleanup
   */
  stop(): void {
    this.isClosing = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.onClose?.();
  }

  /**
   * Connect to the SSE stream
   */
  private async connect(): Promise<void> {
    if (this.isClosing) return;

    this.abortController = new AbortController();
    
    // Try to connect with retries
    let response: Response | undefined;
    let retries = 3;

    while (retries > 0) {
      try {
        console.log(`[event-stream] Attempting to connect to ${this.serverUrl}/event (${4 - retries}/3)`);
        response = await fetch(`${this.serverUrl}/event`, {
          signal: this.abortController.signal,
          headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });

        if (response.ok) {
          break; // Connection successful
        } else {
          throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        retries--;
        if (retries > 0) {
          console.log(`[event-stream] Connection attempt failed, retrying in 1s... (${retries} retries left)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          throw err;
        }
      }
    }

    if (!response) {
      throw new Error('Failed to establish connection after all retries');
    }

    try {
      if (!response.body) {
        throw new Error('Response body is null');
      }

      console.log(`[event-stream] Connected to ${this.armId} event stream`);
      
      // Process the stream
      await this.processStream(response.body);
    } catch (error) {
      if (this.isClosing) return;
      
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === 'AbortError') return;
      
      console.error(`[event-stream] ${this.armId} connection error:`, err.message);
      this.onError?.(err);
      
      // Reconnect after delay
      this.scheduleReconnect();
    }
  }

  /**
   * Process the SSE stream
   */
  private async processStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!this.isClosing) {
        const { done, value } = await reader.read();
        
        if (done) {
          console.log(`[event-stream] ${this.armId} stream ended`);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        
        // Process complete events (separated by double newlines)
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // Keep incomplete event in buffer
        
        for (const eventStr of events) {
          if (eventStr.trim()) {
            this.parseAndEmitEvent(eventStr);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Reconnect if not intentionally closing
    if (!this.isClosing) {
      this.scheduleReconnect();
    }
  }

  /**
   * Parse SSE event string and emit
   */
  private parseAndEmitEvent(eventStr: string): void {
    const lines = eventStr.split('\n');
    let eventType = 'message';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      }
    }

    if (data) {
      try {
        const parsed = JSON.parse(data) as OpenCodeEvent;
        // Enrich with arm context
        const event: OpenCodeEvent = {
          type: parsed.type || eventType,
          properties: {
            ...parsed.properties,
            armId: this.armId,
            sessionId: this.sessionId,
          },
        };
        this.onEvent(event);
      } catch {
        // Non-JSON data, wrap it
        this.onEvent({
          type: eventType,
          properties: { raw: data, armId: this.armId, sessionId: this.sessionId },
        });
      }
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.isClosing) return;
    
    console.log(`[event-stream] ${this.armId} scheduling reconnect in 5s...`);
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, 5000);
  }
}

/**
 * Maximum length for text fields in event data to prevent MAX_PAYLOAD_EXCEEDED errors
 */
const MAX_TEXT_FIELD_LENGTH = 2000;

/**
 * Truncate large text fields in an object to prevent payload size issues.
 * Recursively processes nested objects and arrays.
 */
export function truncateLargeFields(obj: unknown, maxLength = MAX_TEXT_FIELD_LENGTH): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    if (obj.length > maxLength) {
      return obj.slice(0, maxLength) + `... [truncated, ${obj.length - maxLength} chars omitted]`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => truncateLargeFields(item, maxLength));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip internal/debugging fields that can be very large
      if (key === '_fullEvent' || key === '_rawResponse') {
        continue;
      }
      result[key] = truncateLargeFields(value, maxLength);
    }
    return result;
  }

  return obj;
}

/**
 * Filter events that are relevant to broadcast
 * Returns a simplified event name and whether to broadcast
 * 
 * NOTE: All data is truncated to prevent MAX_PAYLOAD_EXCEEDED errors
 */
export function filterEvent(event: OpenCodeEvent): { shouldBroadcast: boolean; eventName: string; data: Record<string, unknown> } {
  const type = event.type;
  const props = event.properties;

  // Helper to truncate and return data
  const truncate = (data: Record<string, unknown>) => truncateLargeFields(data) as Record<string, unknown>;

  // Skip server.connected as it's just a keepalive
  if (type === 'server.connected') {
    return { shouldBroadcast: false, eventName: '', data: {} };
  }

  // Session status changes
  if (type === 'session.updated' || type.startsWith('session.')) {
    return {
      shouldBroadcast: true,
      eventName: 'status',
      data: truncate({
        status: props.status || 'unknown',
        sessionId: props.id || props.sessionId,
        ...props,
      }),
    };
  }

  // Message events
  if (type.startsWith('message.')) {
    const role = (props.role as string) || 'unknown';
    return {
      shouldBroadcast: true,
      eventName: type.replace('message.', 'message-'),
      data: truncate({
        messageId: props.id || props.messageID,
        role,
        ...props,
      }),
    };
  }

  // Part events (tool invocations, results, text)
  if (type.startsWith('part.')) {
    const partType = props.type as string || 'unknown';
    return {
      shouldBroadcast: true,
      eventName: `part-${partType}`,
      data: truncate({
        partId: props.id,
        partType,
        // Include tool name if it's a tool invocation
        toolName: props.toolName || props.name,
        // Include status if available
        status: props.status,
        ...props,
      }),
    };
  }

  // Todo events
  if (type.startsWith('todo.')) {
    return {
      shouldBroadcast: true,
      eventName: type,
      data: truncate(props),
    };
  }

  // File events
  if (type.startsWith('file.')) {
    return {
      shouldBroadcast: true,
      eventName: type,
      data: truncate({
        path: props.path,
        ...props,
      }),
    };
  }

  // Default: broadcast with original type
  return {
    shouldBroadcast: true,
    eventName: type.replace(/\./g, '-'),
    data: truncate(props),
  };
}
