import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';

test('decision Markdown renders tables and expands without losing source edits', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMockApi(page, { layoutMode: 'golden' });
  await page.addInitScript(() => {
    localStorage.setItem('coleo_project_setup_help_dismissed', 'true');
    localStorage.setItem('coleo-theme', 'dark');
  });
  const content = '# Package boundaries\n\n| Component | Responsibility |\n| --- | --- |\n| **Server** | API and orchestration |\n| Client | `web` and terminal UI |\n\n## Example\n\n```ts\nconst ready = true;\n```\n\n- [x] Document the decision\n\n[Reference](https://example.com)\n';
  const file = { path: '.project/decisions/0001-package-boundaries.md', content, contentHash: 'original', size: content.length, modifiedAt: '2026-11-08T12:00:00Z' };
  await page.route('**/api/project-setup', route => route.fulfill({ json: {
    required: false, completed: true, canonicalPlan: null, canonicalTaskCount: 0, taskCount: 0,
    projectDocuments: [file], projectTree: [file.path], candidates: [], defaultContent: '', recommendedPath: file.path,
  } }));
  await page.route('**/api/project-setup/file?*', route => route.fulfill({ json: { file } }));
  await page.goto(`/setup?file=${encodeURIComponent(file.path)}`);
  const source = page.getByRole('textbox', { name: 'Markdown file content' });
  await expect(source).toHaveValue(content);
  const edited = `${content}\nUnsaved reading note.\n`;
  await source.fill(edited);
  await page.getByRole('button', { name: 'Markdown preview' }).click();
  const preview = page.getByRole('region', { name: 'Rendered Markdown' });
  await expect(preview.getByRole('columnheader', { name: 'Component' })).toBeVisible();
  await expect(preview.getByRole('cell', { name: 'Server', exact: true })).toBeVisible();
  await expect(preview.locator('pre code')).toHaveText('const ready = true;\n');
  await expect(preview.getByRole('checkbox')).toBeChecked();
  await expect(preview.getByRole('link', { name: 'Reference' })).toHaveAttribute('href', 'https://example.com');
  await preview.getByRole('button', { name: 'Expand preview' }).click();
  await expect(source).toBeHidden();
  const width = await preview.boundingBox();
  const panes = await page.locator('.setup-document-panes').boundingBox();
  expect(width!.width).toBeGreaterThan(panes!.width - 2);
  await expect(preview.getByText('Unsaved reading note.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('expanded-preview.png') });
  await preview.getByRole('button', { name: 'Return to split view' }).click();
  await expect(source).toBeVisible();
  await expect(source).toHaveValue(edited);
  await preview.getByRole('button', { name: 'Expand preview' }).click();
  await page.getByRole('button', { name: 'Markdown preview' }).click();
  await expect(source).toBeVisible();
  await expect(source).toHaveValue(edited);
});
