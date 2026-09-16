/** Shape consistency across shared controls, native fields, and portaled overlays. */
import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';

for (const theme of ['light', 'dark']) {
  test(`keeps shared controls and overlays consistent in ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.addInitScript((value) => localStorage.setItem('coleo-theme', value), theme);
    await installMockApi(page);
    await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
    await page.goto('/tasks', { waitUntil: 'domcontentloaded' });

    const insights = page.getByRole('group', { name: 'Tasks insights', exact: true });
    const activity = insights.getByRole('button', { name: 'Activity', exact: true });
    await expect(insights).toHaveCSS('border-top-left-radius', '2px');
    await expect(activity).toHaveCSS('border-top-left-radius', '0px');
    await expect(page.getByRole('button', { name: 'Drafts Only', exact: true })).toHaveCSS('border-top-left-radius', '0px');
    await expect(page.getByRole('searchbox', { name: 'Search tasks', exact: true })).toHaveCSS('border-top-left-radius', '2px');
    await insights.getByRole('button', { name: 'Burndown', exact: true }).click();
    const start = page.getByLabel('Start', { exact: true });
    await expect(start).toHaveCSS('font-size', '12px');
    await expect(start).toHaveCSS('height', '28px');
    await expect(start).toHaveCSS('border-top-left-radius', '2px');
    const resolution = page.getByRole('group', { name: 'Resolution', exact: true });
    const hour = resolution.getByRole('button', { name: 'Hour', exact: true });
    await expect(hour).toHaveCSS('font-size', '12px');
    await expect(hour).toHaveCSS('text-transform', 'none');
    await hour.click();
    await expect(hour).toHaveAttribute('aria-pressed', 'true');
    await expect(resolution.getByRole('button', { name: 'Day', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCSS('height', '28px');
    await page.screenshot({ path: testInfo.outputPath(`telemetry-${theme}.png`) });
    await activity.click();
    await expect(activity).toHaveAttribute('aria-pressed', 'true');
    await expect(activity).toHaveCSS('border-top-left-radius', '0px');
    await activity.click();
    await expect(page.getByRole('region', { name: 'Task Activity', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`tasks-${theme}.png`) });

    const newTask = page.getByRole('button', { name: 'New', exact: true });
    await expect(newTask).toHaveCSS('border-top-left-radius', '999px');
    await expect(newTask).toHaveCSS('border-top-width', '0px');
    await newTask.click();
    await expect(page.getByPlaceholder('Brief title for the task')).toHaveCSS('border-top-left-radius', '2px');
    await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toHaveCSS('border-top-left-radius', '0px');
    await page.screenshot({ path: testInfo.outputPath(`new-task-${theme}.png`) });

    // This menu is portaled outside the toolbar: it must inherit the same shape contract.
    await page.getByRole('link', { name: 'Arms', exact: true }).click();
    await page.getByRole('button', { name: /^Filter View:/ }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(page.locator('.dropdown__popover').filter({ has: menu })).toHaveCSS('border-top-left-radius', '2px');
    await page.keyboard.press('Escape');

    await page.getByRole('link', { name: 'Brain', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop Brain', exact: true })).toHaveCSS('border-top-left-radius', '0px');
    const configuration = page.getByRole('region', { name: 'Configuration', exact: true });
    await expect(configuration).toHaveCSS('border-top-left-radius', '2px');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Max Arms', { exact: true })).toHaveCSS('border-top-left-radius', '2px');
    await expect(page.getByLabel('Model', { exact: true })).toHaveCSS('border-top-left-radius', '2px');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`brain-${theme}.png`) });
  });
}

test('aligns native and HeroUI fields in Settings', async ({ page }) => {
  await installMockApi(page);
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('**/api/workbench/profiles', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ profiles: [] }),
  }));
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.select__trigger').first()).toHaveCSS('border-top-left-radius', '2px');
  expect((await page.locator('.select__trigger').first().boundingBox())?.height).toBeLessThanOrEqual(40);
  await expect(page.getByPlaceholder('Enter your API key')).toHaveCSS('border-top-left-radius', '2px');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCSS('border-top-left-radius', '0px');
});
