/**
 * Test Port Utilities
 * 
 * Port allocation and availability checking for tests.
 */

import { createServer } from "node:net";
import type { EventEmitter } from "node:events";

const BASE_PORT = 18000;
let portCounter = 0;

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer() as unknown as EventEmitter & { listen(port: number, host: string): void; close(cb: () => void): void };

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

/**
 * Get a unique port for this test
 */
export async function getNextPort(): Promise<number> {
  const maxAttempts = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    const port = BASE_PORT + (portCounter++ % 10000);
    const available = await isPortAvailable(port);
    if (available) return port;
  }

  // Fallback: ask OS for any free port
  return await new Promise<number>((resolve, reject) => {
    const server = createServer() as unknown as EventEmitter & { listen(port: number, host: string, cb: () => void): void; address(): { port: number } | string; close(cb: (err?: Error) => void): void };
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : undefined;
      server.close((closeErr?: Error) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        if (!port) {
          reject(new Error("Failed to allocate dynamic port"));
          return;
        }
        resolve(port);
      });
    });
  });
}
