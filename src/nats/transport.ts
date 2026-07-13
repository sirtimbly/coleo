import { connect as connectTcp } from "nats";
import { connect as connectWebSocket } from "nats.ws";
import type { ConnectionOptions, NatsConnection } from "nats";

export interface ColeoNatsConnectionOptions extends ConnectionOptions {
  token?: string;
}

export function usesWebSocketTransport(servers: ConnectionOptions["servers"]): boolean {
  const values = Array.isArray(servers) ? servers : [servers ?? ""];
  return values.some((server) => /^wss?:\/\//i.test(String(server)));
}

/**
 * Connect using native TCP for nats:// URLs and WebSocket transport for
 * ws:// or wss:// URLs. The WebSocket path is used by hosted arm agents,
 * whose NATS endpoint is proxied through the Reef Worker.
 */
export async function connectToNats(options: ColeoNatsConnectionOptions): Promise<NatsConnection> {
  if (!usesWebSocketTransport(options.servers)) return connectTcp(options);

  const connection = await connectWebSocket({
    ...options,
    ignoreClusterUpdates: true,
  });
  return connection as NatsConnection;
}
