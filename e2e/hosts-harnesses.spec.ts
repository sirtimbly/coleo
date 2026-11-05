import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';

for (const width of [1280, 390]) {
  test(`manages hosts, harnesses, and service settings at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await installMockApi(page, { layoutMode: 'classic' });
    const hosts = [
      {
        id: 'reef-one',
        name: 'Reef',
        hostname: 'reef.local',
        roles: ['arm', 'api'],
        agentId: 'reef-agent',
        notes: 'Primary machine',
        source: 'registered',
        status: 'connected',
        capabilities: ['opencode-api'],
      },
    ];
    let armStatus = 'idle';
    let saved: Record<string, string> = {};
    const active = { host: '127.0.0.1', port: '8080', natsUrl: 'nats://broker:4222', dbPath: '/srv/coleo/coleo.db' };
    let restarted = false;
    await page.route('**/api/hosts**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/hosts/services/restart') {
        restarted = true;
        return route.fulfill({ status: 202, json: { accepted: true, message: 'Restart requested' } });
      }
      if (path === '/api/hosts/services') {
        if (method === 'PATCH') saved = route.request().postDataJSON();
        return route.fulfill({
          json: {
            active,
            saved,
            restartAvailable: true,
            restartLog: null,
            explanation: 'Save settings, then restart the API. SQLite runs on the API host.',
          },
        });
      }
      if (method === 'POST') {
        hosts.push({
          ...route.request().postDataJSON(),
          id: 'broker',
          source: 'registered',
          status: 'unknown',
          capabilities: [],
        });
        return route.fulfill({ status: 201, json: { host: hosts.at(-1) } });
      }
      return route.fulfill({ json: { hosts, discoveryAvailable: true } });
    });
    await page.route('**/api/arms**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/kill')) {
        armStatus = 'stopped';
        return route.fulfill({ json: { killed: true } });
      }
      return route.fulfill({
        json: {
          arms: [
            {
              id: 'octavia',
              name: 'Octavia',
              harness: 'opencode-api',
              status: armStatus,
              host: 'reef.local',
              provider: 'openai',
              model: 'test-model',
            },
          ],
        },
      });
    });
    await page.goto('/hosts');
    await expect(page.getByRole('heading', { name: 'Hosts & harnesses', exact: true })).toBeVisible();
    await expect(page.getByText('reef.local', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add host', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Broker');
    await page.getByLabel('Hostname or IP', { exact: true }).fill('broker.local');
    await page.getByRole('checkbox', { name: 'NATS', exact: true }).check();
    await page.getByRole('button', { name: 'Save host', exact: true }).click();
    await expect(page.getByText('broker.local', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`hosts-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Harnesses', exact: true }).click();
    await expect(page.locator('.fleet-view').getByText('Octavia', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('stopped', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Service connections', exact: true }).click();
    await page.getByRole('button', { name: 'Edit connections', exact: true }).click();
    await page.getByLabel('API port', { exact: true }).fill('9090');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('cell', { name: '9090', exact: true })).toBeVisible();
    expect(saved.port).toBe('9090');
    await expect(page.getByRole('cell', { name: '8080', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Apply and restart API', exact: true }).click();
    expect(restarted).toBe(false);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Restart requested' })).toBeVisible();
    expect(restarted).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`services-${width}.png`), fullPage: true });
    expect(await page.locator('.fleet-view').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}
