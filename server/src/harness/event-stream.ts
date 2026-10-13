import type { EventCallback, OpenCodeEvent, EventStreamOptions } from "./event-stream-types";
import { truncateLargeFields } from "./event-utils";

export type { EventCallback, OpenCodeEvent, EventStreamOptions, PersistenceCheckResult } from "./event-stream-types";
export { truncateLargeFields, MAX_TEXT_FIELD_LENGTH } from "./event-utils";
export { filterEvent, shouldPersistEvent } from "./event-filters";

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

  async start(): Promise<void> {
    if (this.isClosing) return;

    console.log(`[event-stream] Starting event stream for ${this.armId}`);

    await new Promise(resolve => setTimeout(resolve, 2000));

    await this.connect();
  }

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

  private async connect(): Promise<void> {
    if (this.isClosing) return;

    this.abortController = new AbortController();
    
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
          break;
        } else {
          throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        retries--;
        if (retries > 0) {
          console.log(`[event-stream] Connection attempt failed, retrying in 1s... (${retries} retries left)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          const error = err instanceof Error ? err : new Error(String(err));
          if (error.message.includes("ConnectionRefused") || error.message.includes("Unable to connect")) {
            console.log(`[event-stream] ${this.armId} server not available (connection refused), stopping event stream`);
            this.isClosing = true;
            this.onClose?.();
            return;
          }
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
      
      await this.processStream(response.body as ReadableStream<Uint8Array>);
    } catch (error) {
      if (this.isClosing) return;
      
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === 'AbortError') return;
      
      if (err.message.includes("ConnectionRefused") || err.message.includes("Unable to connect")) {
        console.log(`[event-stream] ${this.armId} connection refused, stopping event stream`);
        this.isClosing = true;
        this.onClose?.();
        return;
      }
      
      console.error(`[event-stream] ${this.armId} connection error:`, err.message);
      this.onError?.(err);
      
      this.scheduleReconnect();
    }
  }

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
        
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        
        for (const eventStr of events) {
          if (eventStr.trim()) {
            this.parseAndEmitEvent(eventStr);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!this.isClosing) {
      this.scheduleReconnect();
    }
  }

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
        const sourceSessionId = this.extractSessionId(parsed.properties);

        if (sourceSessionId && sourceSessionId !== this.sessionId) {
          return;
        }

        const event: OpenCodeEvent = {
          type: parsed.type || eventType,
          properties: {
            ...parsed.properties,
            armId: this.armId,
            sessionId: sourceSessionId || this.sessionId,
          },
        };
        this.onEvent(event);
      } catch {
        console.log(`[event-stream] ${this.armId} RAW EVENT: ${eventType} - ${data.slice(0, 500)}`);
        this.onEvent({
          type: eventType,
          properties: { raw: data, armId: this.armId, sessionId: this.sessionId },
        });
      }
    }
  }

  private extractSessionId(properties: Record<string, unknown> | undefined): string | undefined {
    if (!properties) {
      return undefined;
    }

    const directSessionId = properties.sessionID || properties.sessionId;
    if (typeof directSessionId === "string" && directSessionId.length > 0) {
      return directSessionId;
    }

    const info = properties.info as Record<string, unknown> | undefined;
    if (info) {
      const infoSessionId = info.sessionID || info.sessionId || info.id;
      if (typeof infoSessionId === "string" && infoSessionId.length > 0) {
        return infoSessionId;
      }
    }

    const part = properties.part as Record<string, unknown> | undefined;
    if (part) {
      const partSessionId = part.sessionID || part.sessionId;
      if (typeof partSessionId === "string" && partSessionId.length > 0) {
        return partSessionId;
      }
    }

    return undefined;
  }

  private scheduleReconnect(): void {
    if (this.isClosing) return;
    
    console.log(`[event-stream] ${this.armId} scheduling reconnect in 5s...`);
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, 5000);
  }
}
