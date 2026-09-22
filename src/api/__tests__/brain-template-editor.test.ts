import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { LocalWorkspaceAccess } from '../../workspace';
import { createProjectSetupRoutes } from '../routes/project-setup';
import { formatErrorResponse } from '../middleware/error';
import { BrainTemplateManager } from '../../brain/template-manager';
import { loadSwarmPrompts } from '../../brain/swarm/prompts';

let root: string;
let db: Database;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'brain-template-editor-')); db = new Database(':memory:'); });
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

it('edits the effective template in a custom Coleo directory with conflict and schema validation', async () => {
  const coleoDir = join(root, 'custom-state');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const app = new Hono<{ Variables: { db: Database } }>();
  app.use('*', async (c, next) => { c.set('db', db); await next(); });
  app.onError((error, c) => formatErrorResponse(c, error));
  app.route('/api/project-setup', createProjectSetupRoutes({ workspace: new LocalWorkspaceAccess(workspaceRoot), coleoDir }));
  const path = '.coleo/src/brain/templates/jev-swarm-questions.jinja';
  const initial = await app.request(`/api/project-setup/file?path=${encodeURIComponent(path)}`);
  expect(initial.status).toBe(200);
  const { file } = await initial.json();
  const text = JSON.parse(file.content);
  text.routing.criteria.wait = 'Give arms more time to respond.';
  const put = (content: string, hash = file.contentHash) => app.request('/api/project-setup/file', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content, expectedHash: hash, kind: 'template' }),
  });
  const saved = await put(JSON.stringify(text));
  expect(saved.status).toBe(200);
  const { file: edited } = await saved.json();
  expect(await readFile(join(coleoDir, 'src/brain/templates/jev-swarm-questions.jinja'), 'utf8')).toBe(edited.content);
  expect((await loadSwarmPrompts(new BrainTemplateManager(coleoDir, () => {}))).questions.routing.criteria.wait).toBe('Give arms more time to respond.');
  expect((await put(file.content)).status).toBe(409);
  expect((await put('{broken', edited.contentHash)).status).toBe(400);
  delete text.routing.criteria.act;
  expect((await put(JSON.stringify(text), edited.contentHash)).status).toBe(400);
  expect(await readFile(join(coleoDir, 'src/brain/templates/jev-swarm-questions.jinja'), 'utf8')).toBe(edited.content);
  expect((await app.request(`/api/project-setup/file?path=${encodeURIComponent('.coleo/src/brain/templates/../../config.toml')}`)).status).toBe(400);
});
