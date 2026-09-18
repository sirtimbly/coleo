import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';

test('Start Brain waits for the server and only displays running after success', async ({ page }) => {
  await installMockApi(page);
  await page.route('**/api/config/brain', (route) => route.fulfill({ json: { brain: { model: 'test-model', provider: 'openai', pollIntervalMs: 30000, maxArms: 4 } } }));
  await page.route('**/api/config/brain/models', (route) => route.fulfill({ json: { models: [] } }));
  let running = false;
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/brain/status', (route) => route.fulfill({ json: { brain: {
    status: running ? 'running' : 'stopped', pollIntervalMs: 30000,
    activeArmsCount: 0, pendingTasksCount: 0, completedToday: 0, uptime: 0,
    plan: { status: 'healthy', detail: '', blockedArmCount: 0, blockedTaskCount: 0 },
    modelAccess: { status: 'available' },
  } } }));
  await page.route('**/api/brain/start', async (route) => {
    calls += 1;
    await pending;
    running = true;
    await route.fulfill({ json: { started: true, status: 'running', pid: 1234 } });
  });
  await page.goto('/brain');
  await page.getByRole('button', { name: 'Start Brain', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Starting…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop Brain', exact: true })).toHaveCount(0);
  release();
  await expect(page.getByRole('button', { name: 'Stop Brain', exact: true })).toBeVisible();
  expect(calls).toBe(1);
});
