import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';

test('Brain responsibility controls persist, explain scope, and open the live template editor', async ({ page }) => {
  test.setTimeout(60000);
  await installMockApi(page);
  let brain = { model: 'test-model', provider: 'openai', pollIntervalMs: 30000, maxArms: 4,
    swarmEvaluationMode: 'execute', swarmWindowPolls: 10, responsibilityEnabled: {} as Record<string, boolean>, swarmActionModes: {} as Record<string, string> };
  let failSave = false;
  const templateName = 'arm-output-processor-system-prompt.jinja';
  const filePath = `.coleo/src/brain/templates/${templateName}`;
  let content = 'Current customized prompt for {{ arm_name }}';
  let savedKind = '';
  const file = () => ({ path: filePath, content, contentHash: 'hash', size: content.length, modifiedAt: '2026-09-21T12:00:00Z' });
  await page.route('**/api/config/brain/models', route => route.fulfill({ json: { models: [] } }));
  await page.route('**/api/config/brain', async route => {
    if (route.request().method() === 'PATCH') {
      if (failSave) return route.fulfill({ status: 500, json: { error: 'Settings unavailable' } });
      const patch = route.request().postDataJSON();
      brain = { ...brain, ...patch, responsibilityEnabled: { ...brain.responsibilityEnabled, ...patch.responsibilityEnabled },
        swarmActionModes: { ...brain.swarmActionModes, ...patch.swarmActionModes } };
    }
    await route.fulfill({ json: { brain } });
  });
  await page.route('**/api/config/brain/templates/*', route => route.fulfill({ json: { name: templateName, content, path: filePath } }));
  await page.route('**/api/project-setup', route => route.fulfill({ json: {
    required: false, completed: true, taskCount: 1, canonicalPlan: null, canonicalTaskCount: 1,
    candidates: [], projectDocuments: [], templateFiles: [{ ...file(), format: 'jinja' }], projectTree: [filePath],
    recommendedPath: '.project/plan.md', defaultContent: '# Plan', defaultTemplateContent: '',
  } }));
  await page.route('**/api/project-setup/file?*', route => route.fulfill({ json: { file: file() } }));
  await page.route('**/api/project-setup/file', async route => {
    const body = route.request().postDataJSON();
    expect(body.path).toBe(filePath);
    savedKind = body.kind;
    content = body.content;
    await route.fulfill({ json: { file: file() } });
  });
  await page.goto('/brain');
  const nav = page.getByRole('navigation', { name: 'Brain responsibilities' });
  await nav.getByRole('button', { name: 'Follow-up prompts from arm messages' }).click();
  const section = page.getByRole('region', { name: 'Follow-up prompts from arm messages', exact: true });
  await expect(section.getByText('Where JEV fits')).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Follow-up prompts from arm messages' })).toHaveAttribute('aria-current', 'location');
  const builtin = section.getByRole('switch', { name: 'Assistant-output follow-up prompts' });
  await builtin.focus(); await builtin.press('Space');
  await expect(builtin).not.toBeChecked();
  expect(brain.responsibilityEnabled.followups).toBe(false);
  await section.getByLabel('JEV Prompt an arm').selectOption('shadow');
  await expect(section.getByLabel('JEV Prompt an arm')).toBeEnabled();
  expect(brain.swarmActionModes.prompt_arm).toBe('shadow');
  failSave = true;
  await builtin.focus(); await builtin.press('Space');
  await expect(page.getByRole('alert').filter({ hasText: 'Settings unavailable' })).toBeVisible();
  await expect(builtin).not.toBeChecked();
  failSave = false;
  await page.reload();
  await expect(builtin).not.toBeChecked();
  await expect(section.getByLabel('JEV Prompt an arm')).toHaveValue('shadow');
  await nav.getByRole('button', { name: 'Follow-up prompts from arm messages' }).click();
  await page.screenshot({ path: '/tmp/brain-settings-desktop.png' });
  const preview = section.getByRole('button', { name: `Preview ${templateName}`, exact: true });
  await preview.focus(); await preview.press('Enter');
  const dialog = page.getByRole('dialog', { name: `Template ${templateName}`, exact: true });
  await expect(dialog.getByText(content, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Edit in Plan & Documents' }).click();
  const editor = page.getByRole('textbox', { name: 'Jinja file content' });
  await expect(editor).toHaveValue(content);
  await editor.fill('New customized prompt for {{ arm_name }}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(savedKind).toBe('template');
  expect(content).toBe('New customized prompt for {{ arm_name }}');
  await page.goto('/brain');
  await preview.focus(); await preview.press('Enter');
  await expect(dialog.getByText(content, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByLabel('Find a responsibility').fill('human');
  await expect(nav.getByRole('button', { name: 'Classify direct human messages' })).toHaveCount(1);
  await page.screenshot({ path: '/tmp/brain-settings-narrow.png' });
});
