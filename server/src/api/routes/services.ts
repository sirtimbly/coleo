import { open, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadApiConfig } from '../config';
import { HttpError } from '../middleware';
import { getColeoDir } from '../../config';
import { getServiceStatus, getRunDir, isProcessRunning } from '../../daemon';
import { getCliEntrypoint } from '../../cli/entrypoint';
import { readOperatorConfig, saveOperatorConfig, validateOperatorConfig } from '../../cli/operator-config';
import { resolveNatsUrl } from '../../network-config';
import { openDatabase } from '../../db';
import type { ApiConfig } from '../config';
import type { ServerContext } from '../server-context';
import type { ServiceSettings, ServiceState } from '../../shared/hosts';

const settingsSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .refine((v) => !/[\s/@?#\u0000]/.test(v), 'Use a bind hostname or IP'),
    port: z
      .string()
      .regex(/^\d+$/)
      .refine((v) => Number(v) > 0 && Number(v) <= 65535, 'Port must be 1–65535'),
    natsUrl: z.string().min(1).max(2000),
    dbPath: z.string().min(1).max(4000).refine(isAbsolute, 'Database path must be absolute'),
  })
  .partial()
  .strict();
function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'Unavailable';
  }
}
interface ServiceControls {
  managed?: () => Promise<boolean>;
  restart?: (settings: ServiceSettings) => Promise<void>;
}
export function createServiceRoutes(
  config: ApiConfig = loadApiConfig(),
  controls: ServiceControls = {},
): Hono<ServerContext> {
  const app = new Hono<ServerContext>();
  const active: ServiceSettings = {
    host: config.host,
    port: String(config.port),
    natsUrl: publicUrl(resolveNatsUrl()),
    dbPath: config.dbPath,
  };
  let restartPid: number | undefined;
  const logPath = join(getRunDir(), 'hosts-restart.log');
  async function state(): Promise<ServiceState> {
    const saved = await readOperatorConfig();
    const status = await getServiceStatus('server');
    let restartLog: string | null = null;
    try {
      restartLog = (await readFile(logPath, 'utf8')).slice(-8000);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return {
      active,
      saved: {
        host: saved.host,
        port: saved.port,
        natsUrl: saved.natsUrl ? publicUrl(saved.natsUrl) : undefined,
        dbPath: saved.dbPath,
      },
      restartAvailable: controls.managed ? await controls.managed() : status.running && status.pid === process.pid,
      restartLog,
      explanation:
        'Save connection settings, then apply and restart the managed API. NATS is an external connection; SQLite runs inside the API. A database switch requires an existing compatible Coleo database and stopped harnesses. These settings configure this API process; configure Brain and Arm Hosts separately when moving NATS. Update client URLs after changing the API address.',
    };
  }
  app.get('/', async (c) => c.json(await state()));
  app.patch('/', async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw HttpError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    if (!Object.keys(parsed.data).length) throw HttpError.badRequest('Provide at least one service setting');
    try {
      validateOperatorConfig(parsed.data);
    } catch (e) {
      throw HttpError.badRequest(e instanceof Error ? e.message : 'Invalid settings');
    }
    if (parsed.data.dbPath && parsed.data.dbPath !== active.dbPath) {
      // Do not initialize an empty database or silently migrate user data during a switch.
      try {
        const db = openDatabase(parsed.data.dbPath, { readonly: true });
        db.close();
      } catch {
        throw HttpError.badRequest('Database must be an existing, compatible Coleo database on the API host');
      }
    }
    await saveOperatorConfig({ ...(await readOperatorConfig()), ...parsed.data });
    return c.json({ ...(await state()), savedForRestart: true });
  });
  app.post('/restart', async (c) => {
    const current = await state();
    if (!current.restartAvailable)
      throw new HttpError(
        409,
        'API is managed externally. Apply these settings and restart it through its deployment controls.',
      );
    if (restartPid && isProcessRunning(restartPid)) throw new HttpError(409, 'Restart already in progress');
    const busy = c
      .get('db')
      .query("SELECT COUNT(*) AS count FROM arms WHERE status NOT IN ('stopped', 'error') OR pid > 0")
      .get() as { count: number };
    if (busy.count) throw new HttpError(409, 'Stop all harnesses before restarting the API or switching its database');
    const next = {
      ...active,
      ...Object.fromEntries(Object.entries(current.saved).filter(([, v]) => v !== undefined && v !== '')),
    };
    if (next.dbPath !== active.dbPath) {
      try {
        const db = openDatabase(next.dbPath, { readonly: true });
        db.close();
      } catch {
        throw new HttpError(
          409,
          'Saved database is no longer compatible or accessible; edit the database path before applying',
        );
      }
    }
    if (controls.restart) {
      await controls.restart(next);
      return c.json({ accepted: true, settings: next }, 202);
    }
    await mkdir(getRunDir(), { recursive: true });
    const log = await open(logPath, 'w', 0o600);
    try {
      // A separate operator must own restart: terminating this API cannot kill its replacement launcher.
      const child = spawn(
        process.execPath,
        [
          getCliEntrypoint('server'),
          'restart',
          '--json',
          '--delay-ms',
          '1000',
          '--host',
          next.host,
          '--port',
          next.port,
          '--nats-url',
          next.natsUrl,
          '--db-path',
          next.dbPath,
        ],
        {
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          cwd: process.cwd(),
          env: { ...process.env, COLEO_DIR: getColeoDir(), COLEO_DB_PATH: next.dbPath },
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      restartPid = child.pid;
      child.unref();
    } finally {
      await log.close();
    }
    return c.json(
      {
        accepted: true,
        message: 'Restart requested. Reconnect to the configured API address and refresh to inspect the restart log.',
        settings: next,
      },
      202,
    );
  });
  return app;
}
