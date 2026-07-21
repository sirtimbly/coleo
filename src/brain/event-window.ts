/**
 * BrainEventWindow - Centralized JetStream event window fetcher
 *
 * Replaces ad-hoc state tracking (lastArmEventTime, idleArmPromptTracker, lastStuckState)
 * with a unified event window approach. Fetches event slices per arm from JetStream
 * and provides convenient transforms for analysis.
 */

import { eventStore, type EventData, type IEventStore } from "../nats/jetstream";
import { KNOWN_EVENT_TYPES, NOISE_EVENT_TYPES } from "./event-window-constants";

export interface EventWindowOptions {
  /** How far back to look for events (in milliseconds) */
  windowMs?: number;
  /** Maximum number of events to fetch */
  limit?: number;
}

export interface ArmEventWindow {
  armId: string;
  events: EventData[];
  /** Events grouped by type */
  byType: Map<string, EventData[]>;
  /** Most recent event of each type */
  latestByType: Map<string, EventData>;
  /** Timestamp of most recent event */
  lastEventAt: Date | null;
  /** Time since last event (in milliseconds) */
  silentDurationMs: number;
  /** Unknown event types encountered (for logging) */
  unknownEventTypes: string[];
}

export interface WindowSummary {
  totalEvents: number;
  eventTypeCounts: Map<string, number>;
  firstEventAt: Date | null;
  lastEventAt: Date | null;
  durationMs: number;
}

/**
 * BrainEventWindow provides a centralized way to fetch and analyze
 * event windows for arms from JetStream.
 */
export class BrainEventWindow {
  private store: IEventStore;
  private defaultWindowMs: number;
  private defaultLimit: number;
  private logFn: (msg: string) => void;

  // Cache of unknown event types we've already warned about
  private warnedUnknownTypes: Set<string> = new Set();

  constructor(options?: {
    store?: IEventStore;
    defaultWindowMs?: number;
    defaultLimit?: number;
    log?: (msg: string) => void;
  }) {
    this.store = options?.store ?? eventStore;
    this.defaultWindowMs = options?.defaultWindowMs ?? 10 * 60 * 1000; // 10 minutes
    this.defaultLimit = options?.defaultLimit ?? 200;
    this.logFn = options?.log ?? console.log;
  }

  /**
   * Check if the event store is available
   */
  isAvailable(): boolean {
    return this.store.isInitialized();
  }

  /**
   * Fetch the event window for a specific arm
   */
  async getWindowForArm(
    armId: string,
    options?: EventWindowOptions
  ): Promise<ArmEventWindow> {
    const windowMs = options?.windowMs ?? this.defaultWindowMs;
    const limit = options?.limit ?? this.defaultLimit;

    const since = new Date(Date.now() - windowMs);

    let events: EventData[] = [];
    if (this.store.isInitialized()) {
      try {
        events = await this.store.getArmEvents(armId, limit, since);
      } catch (err) {
        this.logFn(`[EventWindow] Failed to fetch events for arm ${armId}: ${err}`);
      }
    }

    return this.processEvents(armId, events);
  }

  /**
   * Fetch event windows for all arms
   */
  async getWindowsForAllArms(
    armIds: string[],
    options?: EventWindowOptions
  ): Promise<Map<string, ArmEventWindow>> {
    const windows = new Map<string, ArmEventWindow>();

    // Fetch in parallel for efficiency
    const results = await Promise.all(
      armIds.map(async (armId) => ({
        armId,
        window: await this.getWindowForArm(armId, options),
      }))
    );

    for (const { armId, window } of results) {
      windows.set(armId, window);
    }

    return windows;
  }

  /**
   * Get recent events across all arms (for global activity monitoring)
   */
  async getRecentEvents(
    limit?: number,
    since?: Date
  ): Promise<EventData[]> {
    if (!this.store.isInitialized()) {
      return [];
    }

    try {
      return await this.store.getRecentEvents(
        limit ?? this.defaultLimit,
        since
      );
    } catch (err) {
      this.logFn(`[EventWindow] Failed to fetch recent events: ${err}`);
      return [];
    }
  }

  /**
   * Process raw events into an ArmEventWindow structure
   */
  private processEvents(armId: string, events: EventData[]): ArmEventWindow {
    const byType = new Map<string, EventData[]>();
    const latestByType = new Map<string, EventData>();
    const unknownEventTypes: string[] = [];

    let lastEventAt: Date | null = null;

    for (const event of events) {
      const eventType = event.type;

      // Group by type
      if (!byType.has(eventType)) {
        byType.set(eventType, []);
      }
      byType.get(eventType)!.push(event);

      // Track latest by type
      const existing = latestByType.get(eventType);
      if (!existing || new Date(event.timestamp) > new Date(existing.timestamp)) {
        latestByType.set(eventType, event);
      }

      // Track overall last event
      const eventDate = new Date(event.timestamp);
      if (!lastEventAt || eventDate > lastEventAt) {
        lastEventAt = eventDate;
      }

      // Check for unknown event types
      if (!KNOWN_EVENT_TYPES.has(eventType) && !this.warnedUnknownTypes.has(eventType)) {
        unknownEventTypes.push(eventType);
        this.warnedUnknownTypes.add(eventType);
        this.logFn(
          `[EventWindow] WARNING: Unknown event type "${eventType}" for arm ${armId}. ` +
          `Consider adding classification in ArmActivityAnalyzer.`
        );
      }
    }

    const silentDurationMs = lastEventAt
      ? Date.now() - lastEventAt.getTime()
      : Infinity;

    return {
      armId,
      events,
      byType,
      latestByType,
      lastEventAt,
      silentDurationMs,
      unknownEventTypes,
    };
  }

  /**
   * Get a summary of an event window
   */
  summarizeWindow(window: ArmEventWindow): WindowSummary {
    const eventTypeCounts = new Map<string, number>();
    let firstEventAt: Date | null = null;
    let lastEventAt: Date | null = null;

    for (const event of window.events) {
      // Count by type
      const count = eventTypeCounts.get(event.type) || 0;
      eventTypeCounts.set(event.type, count + 1);

      // Track time range
      const eventDate = new Date(event.timestamp);
      if (!firstEventAt || eventDate < firstEventAt) {
        firstEventAt = eventDate;
      }
      if (!lastEventAt || eventDate > lastEventAt) {
        lastEventAt = eventDate;
      }
    }

    const durationMs =
      firstEventAt && lastEventAt
        ? lastEventAt.getTime() - firstEventAt.getTime()
        : 0;

    return {
      totalEvents: window.events.length,
      eventTypeCounts,
      firstEventAt,
      lastEventAt,
      durationMs,
    };
  }

  /**
   * Check if an arm has recent activity (within a threshold)
   */
  hasRecentActivity(window: ArmEventWindow, thresholdMs: number = 60000): boolean {
    return window.silentDurationMs < thresholdMs;
  }

  /**
   * Get the last heartbeat time for an arm
   */
  getLastHeartbeat(window: ArmEventWindow): Date | null {
    const heartbeatEvents = window.byType.get("arm.heartbeat") || [];
    if (heartbeatEvents.length === 0) {
      return null;
    }

    let latest: Date | null = null;
    for (const event of heartbeatEvents) {
      const date = new Date(event.timestamp);
      if (!latest || date > latest) {
        latest = date;
      }
    }
    return latest;
  }

  /**
   * Check if there's a pending permission request
   */
  hasPendingPermission(window: ArmEventWindow): { pending: boolean; request?: EventData } {
    const asked = window.byType.get("permission.asked") || [];
    const replied = window.byType.get("permission.replied") || [];

    if (asked.length === 0) {
      return { pending: false };
    }

    // Get the most recent asked and replied
    const latestAsked = window.latestByType.get("permission.asked");
    const latestReplied = window.latestByType.get("permission.replied");

    if (!latestAsked) {
      return { pending: false };
    }

    // If no reply, or reply is older than ask, permission is pending
    if (
      !latestReplied ||
      new Date(latestReplied.timestamp) < new Date(latestAsked.timestamp)
    ) {
      return { pending: true, request: latestAsked };
    }

    return { pending: false };
  }

  /**
   * Count consecutive events of the same type (for loop detection)
   */
  countConsecutiveSameType(
    window: ArmEventWindow,
    eventType: string,
    lookbackCount: number = 10
  ): number {
    const events = window.events.slice(-lookbackCount);
    let count = 0;

    // Count from the end backwards
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event && event.type === eventType) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  /**
   * Detect potential stuck loops by looking for repetitive patterns
   */
  detectRepetitivePattern(
    window: ArmEventWindow,
    minRepetitions: number = 3
  ): { detected: boolean; pattern?: string[]; count?: number } {
    if (window.events.length < minRepetitions * 2) {
      return { detected: false };
    }

    // Look at recent events
    const recentTypes = window.events.slice(-20).map((e) => e.type);

    // Try to find repeating patterns of length 1-5
    for (let patternLength = 1; patternLength <= 5; patternLength++) {
      if (recentTypes.length < patternLength * minRepetitions) continue;

      const pattern = recentTypes.slice(-patternLength);
      let repetitions = 0;

      for (
        let i = recentTypes.length - patternLength;
        i >= 0;
        i -= patternLength
      ) {
        const slice = recentTypes.slice(i, i + patternLength);
        if (slice.every((t, idx) => t === pattern[idx])) {
          repetitions++;
        } else {
          break;
        }
      }

      if (repetitions >= minRepetitions) {
        return { detected: true, pattern, count: repetitions };
      }
    }

    return { detected: false };
  }

	/**
	 * Get events that should be persisted/forwarded (filtering noise)
	 */
	getSignificantEvents(window: ArmEventWindow): EventData[] {
		return window.events.filter((e) => !NOISE_EVENT_TYPES.has(e.type));
	}

  /**
   * Reset the warned unknown types cache (for testing)
   */
  resetWarnings(): void {
    this.warnedUnknownTypes.clear();
  }
}

// Export a default instance
export const brainEventWindow = new BrainEventWindow();
