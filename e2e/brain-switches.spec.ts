import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';

for (const layout of ['classic', 'golden']) {
  test(`Brain switches support pointer clicks in ${layout} layout`, async ({ page }) => {
    test.setTimeout(60000);
    await installMockApi(page);
    await page.addInitScript(mode => localStorage.setItem('coleo-layout-mode', mode), layout);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let brain = { provider: 'openai', model: 'test-model', pollIntervalMs: 30000, maxArms: 8,
      swarmEvaluationMode: 'off', swarmWindowPolls: 10, responsibilityEnabled: {} as Record<string, boolean> };
    let patches = 0;
    let pendingSave: Promise<void> | null = null;
    let rejectSave = false;
    await page.route('**/api/config/brain/models', route => route.fulfill({ json: { models: [] } }));
    await page.route('**/api/config/brain', async route => {
      if (route.request().method() === 'PATCH') {
        patches++;
        if (pendingSave) await pendingSave;
        if (rejectSave) return route.fulfill({ status: 500, json: { error: 'Could not save Brain settings' } });
        const patch = route.request().postDataJSON();
        brain = { ...brain, ...patch, responsibilityEnabled: { ...brain.responsibilityEnabled, ...patch.responsibilityEnabled } };
      }
      await route.fulfill({ json: { brain } });
    });
    await page.goto('/brain');
    await page.getByText('Evaluate swarm activity', { exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Evaluate swarm activity', exact: true })).toBeChecked();
    await page.getByText('Execute swarm actions', { exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Execute swarm actions', exact: true })).toBeChecked();
    await page.getByRole('navigation', { name: 'Brain responsibilities' }).getByRole('button', { name: 'Follow-up prompts from arm messages' }).click();
    const followup = page.getByRole('region', { name: 'Follow-up prompts from arm messages', exact: true });
    await followup.locator('[data-slot="switch-control"]').click();
    await expect(followup.getByRole('switch')).not.toBeChecked();
    await followup.getByText('Assistant-output follow-up prompts', { exact: true }).click();
    await expect(followup.getByRole('switch')).toBeChecked();
    expect(patches).toBe(4);
    let release!: () => void;
    pendingSave = new Promise<void>(resolve => { release = resolve; });
    rejectSave = true;
    const control = followup.getByRole('switch');
    await control.click();
    await expect(control).toBeDisabled();
    await expect(control).toBeFocused();
    await control.press('Space');
    expect(patches).toBe(5);
    release();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not save Brain settings' })).toBeVisible();
    await expect(control).toBeEnabled();
    await expect(control).toBeChecked();
    await expect(control).toBeFocused();
    pendingSave = null;
    rejectSave = false;
    await control.press('Space');
    await expect(control).not.toBeChecked();
    expect(patches).toBe(6);
    expect(errors).toEqual([]);
    await expect(page.getByRole('heading', { name: 'Brain', exact: true })).toBeVisible();
  });
}
