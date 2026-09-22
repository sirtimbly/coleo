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

test('Swarm switches persist modes, window size, and retain state when a save fails', async ({ page }) => {
  await installMockApi(page);
  let brain = { model: 'test-model', provider: 'openai', pollIntervalMs: 30000, maxArms: 4,
    swarmEvaluationMode: 'off', swarmWindowPolls: 10 };
  let failSave = false;
  await page.route('**/api/config/brain/models', (route) => route.fulfill({ json: { models: [] } }));
  await page.route('**/api/config/brain', async (route) => {
    if (route.request().method() === 'PATCH') {
      if (failSave) return route.fulfill({ status: 500, json: { error: 'Settings unavailable' } });
      brain = { ...brain, ...route.request().postDataJSON() };
    }
    await route.fulfill({ json: { brain } });
  });
  await page.goto('/brain');
  const evaluate = page.getByRole('switch', { name: 'Evaluate swarm activity', exact: true });
  const execute = page.getByRole('switch', { name: 'Execute swarm actions', exact: true });
  await expect(evaluate).not.toBeChecked();
  await expect(execute).toBeDisabled();
  await page.getByText('Evaluate swarm activity', { exact: true }).click();
  await expect(evaluate).toBeChecked();
  await expect(page.getByRole('region', { name: 'Swarm activity evaluation', exact: true }).getByText('Proposals only', { exact: true })).toBeVisible();
  await execute.focus();
  await execute.press('Space');
  await expect(execute).toBeChecked();
  expect(brain.swarmEvaluationMode).toBe('execute');
  await page.getByLabel('Activity window (polls)').fill('20');
  await page.getByRole('button', { name: 'Save window' }).click();
  await expect(page.getByText(/Current window: 20 polls/)).toBeVisible();
  await page.reload();
  await expect(execute).toBeChecked();
  await expect(page.getByLabel('Activity window (polls)')).toHaveValue('20');
  failSave = true;
  await execute.focus();
  await execute.press('Space');
  await expect(page.getByRole('alert').filter({ hasText: 'Settings unavailable' })).toBeVisible();
  await expect(execute).toBeChecked();
  failSave = false;
  await page.getByText('Evaluate swarm activity', { exact: true }).click();
  await expect(evaluate).not.toBeChecked();
  await expect(execute).toBeDisabled();
  await page.getByText('Evaluate swarm activity', { exact: true }).click();
  await expect(evaluate).toBeChecked();
  await expect(execute).not.toBeChecked();
  expect(brain.swarmEvaluationMode).toBe('shadow');
});
