import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';
import { RUNTIME_VERSION } from '../src/version';

const arm = { id: 'arm-1', name: 'Octavia', agentId: 'host-1', status: 'running', domain: 'General', harness: 'opencode-api', lastHeartbeat: new Date().toISOString(), currentTaskSubject: 'Review migration safety' };

async function dashboard(page: import('@playwright/test').Page, options: { staleBrain?: boolean; failedTasks?: () => boolean } = {}) {
  await installMockApi(page, { arms: [arm] });
  const fulfill = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/status', (route) => route.fulfill(fulfill({
    status: 'ok', cwd: '/workspace/coleo', projectName: 'Coleo', version: RUNTIME_VERSION.version, uptime: 9000,
    versions: { api: RUNTIME_VERSION, agents: [{ ...RUNTIME_VERSION, agentId: 'host-1', hostname: 'Reef' }], agentDiscoveryAvailable: true },
    arms: { total: 1, healthy: 0, idle: 0, stuck: 0, stale: 0, details: [] }, proposals: { open: 0 }, activity: { last24h: 22 },
    infrastructure: { database: { healthy: true }, nats: { healthy: true }, maildir: { healthy: true }, qdrant: { healthy: false, optional: true, error: 'Connection refused' }, indexer: { healthy: false, optional: true, running: false } },
  })));
  await page.route('**/api/brain/status', (route) => route.fulfill(fulfill({ brain: {
    status: 'running', lastPollAt: new Date(Date.now() - (options.staleBrain ? 570 * 3600000 : 1000)).toISOString(), pollIntervalMs: 30000,
    activeArmsCount: 1, pendingTasksCount: 211, completedToday: 3,
    plan: { status: 'healthy', detail: 'Plan ready', nextStep: null }, modelAccess: { status: 'available' },
  } })));
  await page.route('**/api/tasks/stats', (route) => options.failedTasks?.() ? route.fulfill({ status: 503, ...fulfill({ error: 'Tasks offline' }) }) : route.fulfill(fulfill({ total: 211, active: 0, blocked: 0, byStatus: { pending: 211 }, completionRate: 0 })));
  await page.route('**/api/agents/providers', (route) => route.fulfill(fulfill({ hosts: [{ agentId: 'host-1', hostname: 'Reef', version: RUNTIME_VERSION.version, configuredProviders: [{ name: 'OpenAI', id: 'openai' }], availableProviderCount: 12, error: null }] })));
  await page.route('**/api/events/analysis*', (route) => route.fulfill(fulfill({ arms: [{ armId: 'arm-1', state: options.staleBrain ? 'silent' : 'productive', reason: 'No recent output', hasPermissionPending: false }], summary: { total: 1 } })));
  await page.route('**/api/activity/*-health*', (route) => route.fulfill(fulfill({ status: 'healthy', lagMessages: 0, ackPending: 0, consumerSeq: 1, consumerFound: true, durable: 'project-scoped', stream: 'coleo-events', lastActive: null, updatedAt: new Date().toISOString(), staleThresholdMs: 120000, enabled: true })));
}

test('keeps hierarchy flat, exposes stale Brain state, and retains drilldowns', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('coleo-theme', 'dark'));
  await dashboard(page, { staleBrain: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();
  await expect(page.getByText('Brain status is unverified', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan Status' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Component versions' })).toHaveCount(0);
  await expect(page.getByText('Completed today', { exact: true }).locator('..')).toContainText('Last reported: 3');
  await expect(page.getByText('Web app', { exact: true })).not.toBeVisible();
  await page.locator('summary').filter({ hasText: 'Releases in sync' }).click();
  await expect(page.getByText('Web app', { exact: true })).toBeVisible();
  await expect(page.getByText('Activity reports for 1/1 Arms', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dashboard-attention-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Inspect Arm', exact: true }).click();
  await expect(page).toHaveURL(/\/viewer\?arm=arm-1/);
});

test('keeps failed refreshes from displaying old work counts as current', async ({ page }) => {
  let failed = false;
  await page.clock.install();
  await dashboard(page, { failedTasks: () => failed });
  await page.goto('/');
  await expect(page.getByText('Pending tasks', { exact: true }).locator('..')).toContainText('211');
  failed = true;
  await page.clock.fastForward(31000);
  await expect(page.getByText('Some reports are unavailable or stale', { exact: true })).toBeVisible();
  await expect(page.getByText('Pending tasks', { exact: true }).locator('..')).toContainText('Last reported: 211');
  failed = false;
  await page.clock.fastForward(31000);
  await expect(page.getByText('Pending tasks', { exact: true }).locator('..')).not.toContainText('Last reported');
});

test('fits narrow screens without nested section cards', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 1000 });
  await dashboard(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'System', exact: true })).toBeVisible();
  await expect(page.getByText('No issues in the current reports.', { exact: true })).toBeVisible();
  expect(await page.getByTestId('dashboard-content').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dashboard-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: testInfo.outputPath('dashboard-desktop.png'), fullPage: true });
});
