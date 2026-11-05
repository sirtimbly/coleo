import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { initDatabase } from '../../db';
import { createHostsRoutes } from '../routes/hosts';
import { createServiceRoutes } from '../routes/services';
import { formatErrorResponse } from '../middleware/error';
import { setArmClient } from '../arm-client-registry';
import type { ServerContext } from '../server-context';
import type { ArmClient } from '../../nats/arm-client';
import type { Database } from 'bun:sqlite';

describe('host inventory and service connections', () => {
  let dir: string;
  let db: Database;
  let app: Hono<ServerContext>;
  let oldDir: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coleo-hosts-'));
    oldDir = process.env.COLEO_DIR;
    process.env.COLEO_DIR = dir;
    db = await initDatabase(join(dir, 'coleo.db'));
    app = new Hono<ServerContext>();
    app.onError((error, c) => formatErrorResponse(c, error));
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.route(
      '/api/hosts/services',
      createServiceRoutes({
        host: '127.0.0.1',
        port: 8080,
        apiKey: 'test',
        corsOrigins: [],
        dbPath: join(dir, 'coleo.db'),
        logLevel: 'quiet',
      }),
    );
    app.route('/api/hosts', createHostsRoutes());
  });
  afterEach(async () => {
    setArmClient(null);
    db.close();
    if (oldDir === undefined) delete process.env.COLEO_DIR;
    else process.env.COLEO_DIR = oldDir;
    await rm(dir, { recursive: true, force: true });
  });
  const host = {
    name: 'Reef',
    hostname: 'reef.example',
    roles: ['arm', 'nats'],
    agentId: 'reef-1',
    notes: 'Test machine',
  };
  async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return app.request('http://test/api/hosts' + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  }
  it('persists CRUD, merges connected agents, and retains runtime observations after deletion', async () => {
    const created = await request('', 'POST', host);
    expect(created.status).toBe(201);
    const { host: saved } = await created.json();
    setArmClient({
      getAgents: () => [{ agentId: 'reef-1', hostname: 'reef.example', capabilities: ['opencode-api'] }],
    } as unknown as ArmClient);
    const list = await (await request('')).json();
    expect(list.hosts.filter((h: { hostname: string }) => h.hostname === 'reef.example')).toHaveLength(1);
    expect(list.hosts.find((h: { id: string }) => h.id === saved.id).status).toBe('connected');
    expect((await request('/' + saved.id, 'PATCH', { notes: 'Updated', roles: ['api', 'database'] })).status).toBe(200);
    expect((await (await request('/' + saved.id)).json()).host.notes).toBe('Updated');
    expect((await request('/' + saved.id, 'DELETE')).status).toBe(200);
    expect((await request('/' + saved.id)).status).toBe(404);
    const after = await (await request('')).json();
    expect(after.hosts.some((h: { id: string }) => h.id === 'runtime:api')).toBe(true);
    expect(after.hosts.some((h: { id: string }) => h.id === 'agent:reef-1')).toBe(true);
  });
  it('rejects invalid bodies and editing observations', async () => {
    for (const body of [
      null,
      { ...host, roles: [] },
      { ...host, hostname: 'http://bad' },
      { ...host, roles: ['other'] },
      { ...host, command: 'shell' },
    ]) {
      expect((await request('', 'POST', body)).status).toBe(400);
    }
    expect((await request('/runtime:api', 'PATCH', { name: 'Fake' })).status).toBe(404);
    expect((await request('/runtime:api', 'DELETE')).status).toBe(404);
    expect((await (await request('')).json()).discoveryAvailable).toBe(false);
  });
  it('blocks active harness restarts and passes saved settings to the separate restart operator', async () => {
    const queued: unknown[] = [];
    const controlled = new Hono<ServerContext>();
    controlled.onError((error, c) => formatErrorResponse(c, error));
    controlled.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    controlled.route(
      '/',
      createServiceRoutes(
        {
          host: '127.0.0.1',
          port: 8080,
          apiKey: 'test',
          corsOrigins: [],
          dbPath: join(dir, 'coleo.db'),
          logLevel: 'quiet',
        },
        {
          managed: async () => true,
          restart: async (settings) => {
            queued.push(settings);
          },
        },
      ),
    );
    db.run(
      "INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at) VALUES ('active', 'Active', 'general', 'opencode-api', 'busy', 1000, 0, datetime('now'), datetime('now'))",
    );
    expect((await controlled.request('http://test/restart', { method: 'POST' })).status).toBe(409);
    expect(queued).toHaveLength(0);
    db.run("UPDATE arms SET status='stopped' WHERE id='active'");
    await request('/services', 'PATCH', { host: '0.0.0.0', port: '9090', natsUrl: 'nats://new-broker:4222' });
    expect((await controlled.request('http://test/restart', { method: 'POST' })).status).toBe(202);
    expect(queued).toEqual([
      { host: '0.0.0.0', port: '9090', natsUrl: 'nats://new-broker:4222', dbPath: join(dir, 'coleo.db') },
    ]);
  });
  it('saves validated service settings without changing the active runtime; refuses unsafe database switches', async () => {
    expect((await request('/services', 'PATCH', { port: '9000', natsUrl: 'nats://broker:4222' })).status).toBe(200);
    const state = await (await request('/services')).json();
    expect(state.active.port).toBe('8080');
    expect(state.saved.port).toBe('9000');
    expect(state.saved.natsUrl).toBe('nats://broker:4222');
    for (const body of [
      {},
      { port: '70000' },
      { natsUrl: 'https://wrong' },
      { natsUrl: 'nats://user:secret@broker' },
      { dbPath: join(dir, 'absent.db') },
    ]) {
      expect((await request('/services', 'PATCH', body)).status).toBe(400);
    }
    expect((await request('/services/restart', 'POST', {})).status).toBe(409);
    expect((await (await request('/services')).json()).saved.port).toBe('9000');
  });
});
