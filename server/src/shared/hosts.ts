/** Inventory is distinct from observed processes and active connection settings. */
export const HOST_ROLES = ['arm', 'api', 'nats', 'database'] as const;
export type HostRole = (typeof HOST_ROLES)[number];
export interface HostInput {
  name: string;
  hostname: string;
  roles: HostRole[];
  agentId?: string | null;
  notes: string;
}
export interface HostRecord extends HostInput {
  id: string;
  source: 'registered' | 'discovered';
  status: 'connected' | 'offline' | 'observed' | 'unknown';
  capabilities: string[];
}
export interface ServiceSettings {
  host: string;
  port: string;
  natsUrl: string;
  dbPath: string;
}
export interface ServiceState {
  active: ServiceSettings;
  saved: Partial<ServiceSettings>;
  restartAvailable: boolean;
  restartLog: string | null;
  explanation: string;
}
