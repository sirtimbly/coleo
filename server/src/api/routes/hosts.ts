import { hostname } from 'node:os';
import { Hono } from 'hono';
import { z } from 'zod';
import { getArmClient } from '../arm-client-registry';
import { HttpError } from '../middleware';
import { HOST_ROLES } from '../../shared/hosts';
import { resolveNatsUrl } from '../../network-config';
import type { ServerContext } from '../server-context';
import type { HostInput, HostRecord } from '../../shared/hosts';
import type { Database } from 'bun:sqlite';

const hostSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    hostname: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .refine((v) => !/[\s/@?#\u0000]/.test(v), 'Use a hostname or IP address'),
    roles: z
      .array(z.enum(HOST_ROLES))
      .min(1)
      .max(4)
      .transform((v) => [...new Set(v)]),
    agentId: z.string().trim().min(1).max(200).nullable().optional(),
    notes: z.string().max(4000),
  })
  .strict();
const createHostSchema = hostSchema.extend({ notes: hostSchema.shape.notes.default('') });
const patchHostSchema = hostSchema.partial();
interface HostRow {
  id: string;
  name: string;
  hostname: string;
  roles: string;
  agentId: string | null;
  notes: string;
}
function registered(db: Database): HostRecord[] {
  const agents = getArmClient()?.getAgents() ?? [];
  return (
    db
      .query('SELECT id, name, hostname, roles, agent_id AS agentId, notes FROM hosts ORDER BY name, id')
      .all() as HostRow[]
  ).map((row) => {
    const agent = agents.find((a) => (row.agentId ? a.agentId === row.agentId : a.hostname === row.hostname));
    return {
      ...row,
      roles: JSON.parse(row.roles),
      source: 'registered',
      status: row.roles.includes('arm') ? (agent ? 'connected' : getArmClient() ? 'offline' : 'unknown') : 'unknown',
      capabilities: agent?.capabilities ?? [],
    };
  });
}
export function listHosts(db: Database): HostRecord[] {
  const rows = registered(db);
  const agents = getArmClient()?.getAgents() ?? [];
  for (const agent of agents) {
    if (rows.some((r) => r.agentId === agent.agentId || (!r.agentId && r.hostname === agent.hostname))) continue;
    rows.push({
      id: `agent:${agent.agentId}`,
      name: agent.hostname,
      hostname: agent.hostname,
      roles: ['arm'],
      agentId: agent.agentId,
      notes: '',
      source: 'discovered',
      status: 'connected',
      capabilities: agent.capabilities,
    });
  }
  rows.push({
    id: 'runtime:api',
    name: 'API and SQLite',
    hostname: hostname(),
    roles: ['api', 'database'],
    notes: 'Observed API process and its local SQLite database.',
    source: 'discovered',
    status: 'observed',
    capabilities: [],
  });
  const natsHost = new URL(resolveNatsUrl()).hostname;
  rows.push({
    id: 'runtime:nats',
    name: 'NATS connection',
    hostname: natsHost,
    roles: ['nats'],
    notes: 'Configured connection; availability is reported by system status.',
    source: 'discovered',
    status: 'unknown',
    capabilities: [],
  });
  return rows;
}
export function createHostsRoutes(): Hono<ServerContext> {
  const app = new Hono<ServerContext>();
  app.get('/', (c) => c.json({ hosts: listHosts(c.get('db')), discoveryAvailable: getArmClient() !== null }));
  app.get('/:id', (c) => {
    const host = listHosts(c.get('db')).find((r) => r.id === c.req.param('id'));
    if (!host) throw HttpError.notFound('Host not found');
    return c.json({ host });
  });
  app.post('/', async (c) => {
    const parsed = createHostSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw HttpError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const data: HostInput = parsed.data;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    c.get('db').run(
      'INSERT INTO hosts (id, name, hostname, roles, agent_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, data.name, data.hostname, JSON.stringify(data.roles), data.agentId ?? null, data.notes, now, now],
    );
    return c.json({ host: registered(c.get('db')).find((r) => r.id === id) }, 201);
  });
  app.patch('/:id', async (c) => {
    const db = c.get('db');
    const current = registered(db).find((r) => r.id === c.req.param('id'));
    if (!current) throw HttpError.notFound('Registered host not found; register discovered hosts before editing');
    const parsed = patchHostSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw HttpError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const next = { ...current, ...parsed.data };
    db.run('UPDATE hosts SET name=?, hostname=?, roles=?, agent_id=?, notes=?, updated_at=? WHERE id=?', [
      next.name,
      next.hostname,
      JSON.stringify(next.roles),
      next.agentId ?? null,
      next.notes,
      new Date().toISOString(),
      current.id,
    ]);
    return c.json({ host: registered(db).find((r) => r.id === current.id) });
  });
  app.delete('/:id', (c) => {
    const result = c.get('db').run('DELETE FROM hosts WHERE id=?', [c.req.param('id')]);
    if (!result.changes) throw HttpError.notFound('Registered host not found');
    return c.json({ deleted: true });
  });
  return app;
}
