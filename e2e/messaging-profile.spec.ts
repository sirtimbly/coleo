import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/fixtures";

for (const named of [false, true]) {
  test(`${named ? "named" : "default"} Inbox scopes collection, detail, and attention writes to the selected profile`, async ({ page }) => {
    await installMockApi(page, { profileId: "reviewer", activity: [{ id: "profile-poll", sequence: 101,
      timestamp: "2026-10-01T12:00:00Z", actor: "brain", action: "poll_failed",
      target: null, details: { pendingTasks: 2, activeArms: 3, durationMs: 1200 } }] });
    const queries: string[] = [];
    const writes: Record<string, unknown>[] = [];
    const reads: string[] = [];
    await page.route("**/api/workbench/attention/**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        reads.push(new URL(request.url()).searchParams.get("profileId") ?? "missing");
        return route.fulfill({ json: { attention: null } });
      }
      writes.push(request.postDataJSON());
      return route.fulfill({ json: { attention: [] } });
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/workbench/inbox") queries.push(JSON.parse(url.searchParams.get("query")!).profileId);
    });
    await page.goto(`/messaging?facet=brain${named ? "&view=inbox-triage" : ""}`);
    await expect(page.getByText("Poll failed", { exact: true })).toBeVisible();
    expect(queries.length).toBeGreaterThan(0);
    expect(new Set(queries)).toEqual(new Set(["reviewer"]));
    if (!named) {
      await page.getByRole("button", { name: "Mark read", exact: true }).click();
      await expect.poll(() => writes.some((body) => body.action === "read" && body.profileId === "reviewer")).toBe(true);
    }
    await page.getByText("Poll failed", { exact: true }).dblclick();
    await expect.poll(() => writes.some((body) => body.readAt && body.profileId === "reviewer")).toBe(true);
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    expect(reads.every((profileId) => profileId === "reviewer")).toBe(true);
    expect(writes.every((body) => body.profileId === "reviewer")).toBe(true);
  });
}
