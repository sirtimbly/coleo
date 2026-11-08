import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/fixtures";
import { fixtureMessagingPage } from "./support/messaging";

for (const width of [1280, 390]) {
  test(`reviews and applies Catch me up without silently archiving at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await installMockApi(page, { layoutMode: "golden" });
    const preview = { id: "a9c6860a-3be6-48c5-96a6-cd51fa00dfd2", status: "review", startedAt: new Date().toISOString(),
      detail: "Ready for your review", unreadCount: 12, plan: { actions: [{ title: "Release the file claim for task 42",
        action: "Please release Octavia’s claim on src/app.ts so task 42 can continue.",
        context: "The same blocker was reported six times. The latest report still says the claim is held.", sourceIds: ["1", "2", "3", "4", "5", "6"] }],
      resolvedTopics: 2, informationalTopics: 1, applyPolicyVersion: 2,
      archiveSourceIds: Array.from({ length: 10 }, (_, index) => String(index + 1)),
      retainedSources: [{ sourceId: "11", reason: "Uncertain assignment; original retained." }, { sourceId: "12", reason: "Unmatched issue; original retained." }] },
      sourceSubjects: Array.from({ length: 12 }, (_, index) => ({ sourceId: String(index + 1), subject: index < 6 ? "Task 42 blocked on src/app.ts" : index < 10 ? "Requirements question resolved" : "Uncertain original question" })),
      archiveSubjects: Array.from({ length: 10 }, (_, index) => ({ sourceId: String(index + 1), subject: index < 6 ? "Task 42 blocked on src/app.ts" : "Requirements question resolved" })) };
    let job: Record<string, unknown> | null = null;
    let applied = 0;
    await page.route("**/api/workbench/inbox?*", route => {
      const query = JSON.parse(new URL(route.request().url()).searchParams.get("query")!);
      return route.fulfill({ json: fixtureMessagingPage({ inbox: [{
        id: applied ? "catchup-action" : "old-notice", from: "brain@coleo.local", to: "human@coleo.local",
        subject: applied ? "Action needed: Release the file claim for task 42" : "Original notice to archive",
        body: "Please release the claim.", date: applied ? new Date().toISOString() : "2026-11-07T12:00:00.000Z", flags: { seen: false },
        headers: { "message-id": applied ? "<catchup-action>" : "<old-notice>" },
      }] }, query, []) });
    });
    await page.route("**/api/workbench/inbox/catch-up", route => {
      if (route.request().method() === "POST") job = preview;
      return route.fulfill({ status: route.request().method() === "POST" ? 202 : 200, json: { job } });
    });
    await page.route("**/api/workbench/inbox/catch-up/*/apply", route => {
      applied++;
      job = { ...preview, status: "completed", detail: "Inbox caught up", archivedCount: 10 };
      return route.fulfill({ json: { job } });
    });
    await page.goto("/messaging");
    const button = page.getByRole("button", { name: "Catch me up", exact: true });
    await expect(button).toBeVisible();
    await expect(page.getByText("Original notice to archive", { exact: true })).toBeVisible();
    // A disappearing dark-mode row must never reveal the table's backing surface.
    const exitStyle = await page.locator(".tabulator-row").first().evaluate(row => {
      const element = row as HTMLElement;
      element.style.setProperty("--color-background", "rgb(19, 30, 36)");
      element.classList.add("coleo-inbox-row-removed");
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause(); animation.currentTime = 80;
      }
      const style = getComputedStyle(element);
      const result = { opacity: style.opacity, background: style.backgroundColor };
      element.classList.remove("coleo-inbox-row-removed");
      element.style.removeProperty("--color-background");
      return result;
    });
    expect(exitStyle).toEqual({ opacity: "1", background: "rgb(19, 30, 36)" });
    await button.click();
    const panel = page.getByRole("region", { name: "Catch me up", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Review unread messages", exact: true }).click();
    await expect(panel.getByLabel("Catch-up statistics")).toContainText("12 unread reviewed · 1 new action thread · 10 to archive · 2 kept in inbox");
    await expect(panel.getByText("Action needed: Release the file claim for task 42", { exact: true })).toBeHidden();
    await expect(panel.getByText(preview.plan.actions[0]!.context, { exact: true })).toHaveCount(0);
    const panelBox = await panel.boundingBox();
    expect(panelBox!.height).toBeLessThan(450);
    expect(applied).toBe(0);
    await expect(page.locator(".coleo-inbox-row-added")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`catch-up-${width}.png`), fullPage: true });
    await panel.locator("summary", { hasText: "Originals to archive (10)" }).click();
    await expect(panel.getByText(/Task 42 blocked on src\/app.ts.*6 messages/)).toBeVisible();
    await panel.locator("summary", { hasText: "New action threads (1)" }).click();
    await expect(panel.getByText("Action needed: Release the file claim for task 42", { exact: true })).toBeVisible();
    await expect(panel.getByText("Task 42 blocked on src/app.ts (6 originals)", { exact: true })).toBeVisible();
    await panel.locator("summary", { hasText: "Originals kept in inbox (2)" }).click();
    await expect(panel.getByText("Uncertain assignment; original retained.", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Apply catch-up", exact: true }).click();
    await expect(page.locator(".coleo-inbox-row-added")).toHaveCount(1);
    await expect(panel.getByRole("status")).toContainText("10 original messages archived; 1 focused action message created. 2 originals kept untouched");
    expect(applied).toBe(1);
    await expect(page.getByText("Original notice to archive", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Action needed: Release the file claim for task 42", { exact: true })).toBeVisible();
  });
}

test("catch-up failure is actionable and never claims that messages were archived", async ({ page }) => {
  await installMockApi(page);
  await page.route("**/api/workbench/inbox/catch-up", route => route.fulfill({ json: { job: {
    id: "a9c6860a-3be6-48c5-96a6-cd51fa00dfd2", status: "failed", unreadCount: 12,
    startedAt: new Date().toISOString(), detail: "Failed", error: "Brain model request failed (HTTP 401). No messages were archived.",
  } } }));
  await page.goto("/messaging");
  await page.getByRole("button", { name: "Catch me up", exact: true }).click();
  const panel = page.getByRole("region", { name: "Catch me up", exact: true });
  await expect(panel.getByRole("alert")).toContainText("No messages were archived");
  await expect(panel.getByRole("button", { name: "Start a fresh review" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Apply catch-up" })).toHaveCount(0);
});

test("focused messages render readable sections and navigate to archived originals safely", async ({ page }) => {
  const unsafe = '<img src="x" onerror="window.injected=true">';
  await installMockApi(page, { layoutMode: "golden", inbox: [{
    id: "summary", from: "brain@coleo.local", to: "human@coleo.local", subject: "Action needed: Release file claim",
    date: "2026-11-07T12:00:00.000Z", flags: { seen: false },
    headers: { "message-id": "<summary>", "x-coleo-thread-id": "catchup-summary", "x-coleo-catchup-id": "a9c6860a-3be6-48c5-96a6-cd51fa00dfd2" },
    body: `## What needs your attention\n\nRelease the file claim.\n\n## Context\n\nSix reports, still blocked. ${unsafe}\n\n## Original messages\n\n- [Original blocker](/messaging?mailbox=archive&thread=source-topic&message=old) — Octavia`,
  }], archive: [{
    id: "old", from: "arm@coleo.local", to: "human@coleo.local", subject: "Original blocker",
    date: "2026-11-07T11:00:00.000Z", body: "Please unblock task 42.", flags: { seen: false },
    headers: { "message-id": "<old>", "x-coleo-thread-id": "source-topic" },
  }] });
  await page.goto("/messaging?mailbox=inbox&thread=catchup-summary");
  await expect(page.getByRole("heading", { name: "What needs your attention", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Context", exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.getByRole("link", { name: "Original blocker", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Original blocker", exact: true })).toBeVisible();
  await expect(page.getByText("Please unblock task 42.", { exact: true })).toBeVisible();
});
