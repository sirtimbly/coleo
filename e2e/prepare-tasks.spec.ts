import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';

for (const outcome of ['success', 'fallback', 'error'] as const) {
  test(`plan preparation progress and ${outcome} result`, async ({ page }, testInfo) => {
    await installMockApi(page);
    await page.addInitScript(() => localStorage.setItem('coleo_project_setup_help_dismissed', 'true'));
    const canonicalPlan = {
      path: '.project/plan.md', content: '# Plan\n\n## Phase 1: Foundation\n\n### Tasks\n- [ ] Build accounts\n',
      contentHash: 'original', size: 80, modifiedAt: new Date().toISOString(),
    };
    await page.route('**/api/project-setup', (route) => route.fulfill({ json: {
      required: false, completed: true, canonicalPlan, canonicalTaskCount: 1, taskCount: 0,
      projectDocuments: [canonicalPlan], projectTree: ['.project/plan.md'], candidates: [], defaultContent: '',
    } }));
    let requests = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    await page.route('**/api/project-setup/prepare', async (route) => {
      requests += 1;
      await pending;
      await route.fulfill(outcome === 'error'
        ? { status: 500, json: { error: 'Unable to save the plan' } }
        : { json: { canonicalPlan, taskCount: 1, mode: outcome === 'success' ? 'ai' : 'structured',
          ...(outcome === 'fallback' ? { formatterError: 'Plan formatter timed out' } : {}),
        } });
    });
    await page.goto('/setup');
    await page.getByRole('button', { name: 'Prepare tasks', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Prepare tasks?' })).toBeVisible();
    await expect(dialog.getByRole('progressbar')).toHaveCount(0);
    await expect(dialog).toContainText('Overwrites .project/plan.md');
    await expect(dialog).toContainText('it does not add, update, or delete database tasks');
    await expect(dialog).toContainText('adds or updates tasks in the database');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests).toBe(0);
    await page.getByRole('button', { name: 'Prepare tasks', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm overwrite', exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(dialog.getByRole('heading', { name: 'Preparing tasks' })).toBeVisible();
    await expect(dialog.getByRole('progressbar')).toBeVisible();
    await expect(dialog.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    await expect(dialog.getByText(/dependency order/)).toBeVisible();
    await expect(dialog.getByLabel('Elapsed time')).not.toHaveText('0:00 elapsed');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    if (outcome === 'success') {
      await page.screenshot({ path: testInfo.outputPath('preparing-tasks.png') });
      await page.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.setAttribute('data-theme', 'dark'); });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath('preparing-tasks-narrow-dark.png') });
    }
    finish();
    await expect(dialog.getByRole('progressbar')).toHaveCount(0);
    await expect(dialog.getByRole(outcome === 'success' ? 'status' : 'alert')).toBeVisible();
    if (outcome === 'success') await expect(dialog).toContainText('Task synchronization is still pending.');
    if (outcome === 'fallback') await expect(dialog).toContainText('The plan was saved, but AI evaluation has not succeeded.');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.route('**/api/project-setup/file?*', (route) => route.fulfill({ json: {
      file: { ...canonicalPlan, path: '.coleo/src/brain/templates/plan-evaluation-system-prompt.jinja', content: 'Preserve all requirements while organizing the plan.' },
    } }));
    await page.getByRole('button', { name: 'Prepare tasks', exact: true }).click();
    await dialog.getByRole('button', { name: 'plan-evaluation instructions', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveValue('Preserve all requirements while organizing the plan.');
    expect(requests).toBe(1);
  });
}
