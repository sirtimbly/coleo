/**
 * NATS Connection Manager for Octopai
 * 
 * Connects to an external NATS server (e.g., running in Docker).
 * Falls back gracefully if NATS is not available.
 */

import { connect, type NatsConnection } from 'nats';

export interface NatsManagerOptions {
  url?: string;
  debug?: boolean;
  retryAttempts?: number;
  retryDelayMs?: number;
}

export class NatsManager {
  private connection: NatsConnection | null = null;
  private url: string;
  private debug: boolean;
  private retryAttempts: number;
  private retryDelayMs: number;
  private isConnected = false;

  constructor(options: NatsManagerOptions = {}) {
    this.url = options.url || process.env.OCTOPAI_NATS_URL || 'nats://localhost:4222';
    this.debug = options.debug || false;
    this.retryAttempts = options.retryAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  /**
   * Connect to the NATS server
   */
  async connect(): Promise<boolean> {
    if (this.isConnected && this.connection) {
      return true;
    }

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        if (this.debug) {
          console.log(`[NATS] Connecting to ${this.url} (attempt ${attempt}/${this.retryAttempts})...`);
        }

        this.connection = await connect({
          servers: this.url,
          timeout: 5000,
          reconnect: true,
          maxReconnectAttempts: 10,
          reconnectTimeWait: 1000,
        });

        this.isConnected = true;

        // Handle connection events
        (async () => {
          if (!this.connection) return;
          for await (const status of this.connection.status()) {
            if (this.debug) {
              console.log(`[NATS] Status: ${status.type}`, status.data);
            }
            if (status.type === 'disconnect' || status.type === 'error') {
              this.isConnected = false;
            } else if (status.type === 'reconnect') {
              this.isConnected = true;
            }
          }
        })();

        if (this.debug) {
          console.log(`[NATS] Connected to ${this.url}`);
        }

        return true;
      } catch (err) {
        if (this.debug) {
          console.log(`[NATS] Connection attempt ${attempt} failed:`, err);
        }
        
        if (attempt < this.retryAttempts) {
          await this.sleep(this.retryDelayMs);
        }
      }
    }

    console.log(`[NATS] Failed to connect after ${this.retryAttempts} attempts`);
    return false;
  }

  /**
   * Disconnect from NATS
   */
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.drain();
      await this.connection.close();
      this.connection = null;
    }
    this.isConnected = false;
    
    if (this.debug) {
      console.log('[NATS] Disconnected');
    }
  }

  /**
   * Get the NATS connection for publishing/subscribing
   */
  getConnection(): NatsConnection | null {
    return this.connection;
  }

  /**
   * Get the server URL
   */
  getServerUrl(): string {
    return this.url;
  }

  /**
   * Check if connected
   */
  ready(): boolean {
    return this.isConnected && this.connection !== null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let natsManager: NatsManager | null = null;

export function getNatsManager(): NatsManager | null {
  return natsManager;
}

export function setNatsManager(manager: NatsManager): void {
  natsManager = manager;
}

// Keep old exports for compatibility (aliased to new names)
export { NatsManager as EmbeddedNats };
export const getEmbeddedNats = getNatsManager;
export const setEmbeddedNats = setNatsManager;
