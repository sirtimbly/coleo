import { expect, test } from '@playwright/test';
import { installMockApi } from './support/fixtures';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Config file browser stays contained at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await installMockApi(page, { layoutMode: 'golden' });
    await page.addInitScript(() => {
      localStorage.setItem('coleo_project_setup_help_dismissed', 'true');
      localStorage.setItem('coleo-theme', 'dark');
    });
    const plan = { path: '.project/plan.md', content: '# Project plan\n\nBuild a better workspace.\n', contentHash: 'plan', size: 48, modifiedAt: '2026-11-08T12:00:00Z' };
    const documents = Array.from({ length: 6 }, (_, index) => ({ ...plan,
      path: `.project/decisions/000${index + 1}-component-package-boundaries-and-workspace-layout.md`, recentlyChanged: true }));
    const paths = [plan.path, ...documents.map(document => document.path), '.coleo/config.toml',
      ...Array.from({ length: 1790 }, (_, index) => `src/modules/module-${index}/implementation.ts`)];
    await page.route('**/api/project-setup', route => route.fulfill({ json: {
      required: false, completed: true, canonicalPlan: plan, canonicalTaskCount: 1, taskCount: 0,
      projectDocuments: [plan, ...documents], projectTree: paths, candidates: [], defaultContent: '',
    } }));
    await page.route('**/api/project-setup/file?*', route => route.fulfill({ json: { file: {
      ...plan, path: new URL(route.request().url()).searchParams.get('path'),
    } } }));
    await page.goto('/setup');
    const sidebar = page.getByRole('complementary', { name: 'File browser' });
    await expect(sidebar.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: 'Markdown file content' })).toHaveValue(plan.content);
    const content = await sidebar.locator('.setup-browser-content').boundingBox();
    const footer = await sidebar.locator('footer').boundingBox();
    expect(content!.y + content!.height).toBeLessThanOrEqual(footer!.y + 1);
    await expect(sidebar.locator('.setup-file-tree-container')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('config-files.png'), fullPage: true });
    await sidebar.getByRole('tab', { name: 'Recently changed' }).click();
    await expect(sidebar.locator('.setup-file-tree-container')).toHaveCount(0);
    await expect(sidebar.getByLabel('Recently changed project documents')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('config-recent.png'), fullPage: true });
    await sidebar.getByRole('tab', { name: 'Files', exact: true }).click();
    await sidebar.getByRole('searchbox', { name: 'Find a file' }).fill('config.toml');
    await expect(sidebar.getByLabel('Matching files').getByRole('button')).toHaveCount(1);
    await sidebar.getByLabel('Matching files').getByRole('button').click();
    await expect(page.getByRole('textbox', { name: 'TOML file content' })).toBeVisible();
    await sidebar.getByRole('searchbox', { name: 'Find a file' }).fill('no-such-file');
    await expect(sidebar.getByText('No files match your search.')).toBeVisible();
    await sidebar.getByRole('button', { name: 'Clear file search' }).click();
    expect(await page.locator('.setup-page-shell').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
