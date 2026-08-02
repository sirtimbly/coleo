/**
 * Deterministic API boundary used by workbench browser tests.
 *
 * Individual specs override only the resources they exercise while common
 * shell, onboarding, profile, and empty-resource responses stay centralized.
 */

import type { Page, Route } from "@playwright/test";

interface MockApiOptions {
	arms?: unknown[];
	tasks?: unknown[];
	inbox?: unknown[];
	sent?: unknown[];
	archive?: unknown[];
	activity?: unknown[];
}

const now = "2026-08-02T12:00:00.000Z";

function json(route: Route, body: unknown, status = 200) {
	return route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

export async function installMockApi(page: Page, options: MockApiOptions = {}) {
	await page.addInitScript(() => {
		window.localStorage.setItem("coleo-layout-mode", "classic");
		window.localStorage.setItem("coleo:workbench-profile", "local");
	});

	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;

		if (path === "/api/onboarding") {
			return json(route, {
				ready: true,
				projectDir: "/workspace/coleo",
				repository: {
					checkedOut: true,
					remoteUrl: "git@example.test/coleo.git",
					branch: "codex/workbench-ui",
					commit: null,
					trackedFileCount: 100,
					dirtyFileCount: 0,
					topLevelEntries: [],
				},
				ssh: { configured: true, publicKey: null },
			});
		}

		if (path === "/api/status") {
			return json(route, { cwd: "/workspace/coleo", projectName: "Coleo" });
		}

		if (path === "/api/workbench/bootstrap") {
			return json(route, {
				schemaVersion: 1,
				profile: {
					id: "local",
					name: "Local",
					isDefault: true,
					preferences: {},
					createdAt: now,
					updatedAt: now,
				},
				views: [],
				layouts: [],
			});
		}

		if (path === "/api/arms" && request.method() === "GET") {
			return json(route, { arms: options.arms ?? [] });
		}
		if (path === "/api/agents") return json(route, { agents: [] });
		if (path === "/api/config/defaults") {
			return json(route, {
				defaults: {
					harness: "opencode-api",
					provider: "openai",
					model: "gpt-5",
					contextBudget: 128000,
				},
			});
		}
		if (path === "/api/config/brain/models") {
			return json(route, { models: [] });
		}
		if (path === "/api/config/brain") {
			return json(route, {
				brain: {
					pollIntervalMs: 30000,
					maxArms: 8,
					provider: "openai",
					model: "gpt-5",
					apiKeyConfigured: true,
				},
			});
		}
		if (path === "/api/brain/status") {
			return json(route, {
				brain: {
					status: "running",
					lastPollAt: now,
					pollIntervalMs: 30000,
					activeArmsCount: options.arms?.length ?? 0,
					pendingTasksCount: options.tasks?.length ?? 0,
					completedToday: 0,
					uptime: 3600,
				},
			});
		}
		if (path === "/api/opencode/providers") {
			return json(route, { providers: [], connected: [], source: "cache" });
		}
		if (path === "/api/arms/templates") return json(route, { templates: [] });
		if (path === "/api/events/telemetry") {
			return json(route, {
				armCount: options.arms?.length ?? 0,
				window: { start: now, end: now },
				activity: {
					buckets: [],
					summary: {
						totalEvents: 0,
						activeTimeMs: 0,
						idleTimeMs: 0,
						efficiency: 0,
					},
				},
				contextSamples: [],
				costSamples: [],
			});
		}
		if (/^\/api\/events\/arms\/[^/]+\/analysis$/.test(path)) {
			const armId = path.split("/")[4] ?? "arm";
			return json(route, {
				armId,
				analysis: {
					state: "productive",
					confidence: "high",
					reason: "Recent work is progressing",
					metrics: {
						eventCount: 0,
						silentDurationMs: 0,
						lastEventAt: null,
						recentMessageCount: 0,
						recentToolCount: 0,
						recentFileEditCount: 0,
					},
					unknownEventTypes: [],
				},
				trend: {
					improving: false,
					degrading: false,
					stable: true,
					recentStates: ["productive"],
				},
			});
		}
		if (/^\/api\/events\/arms\/[^/]+\/window$/.test(path)) {
			const armId = path.split("/")[4] ?? "arm";
			return json(route, {
				armId,
				window: {
					events: [],
					lastEventAt: null,
					silentDurationMs: 0,
					unknownEventTypes: [],
				},
				summary: {
					totalEvents: 0,
					eventTypeCounts: {},
					firstEventAt: null,
					lastEventAt: null,
					durationMs: 0,
				},
			});
		}
		if (/^\/api\/events\/arms\/[^/]+\/metrics$/.test(path)) {
			const armId = path.split("/")[4] ?? "arm";
			return json(route, {
				armId,
				window: { start: now, end: now },
				buckets: [],
				summary: {
					totalEvents: 0,
					activeTimeMs: 0,
					idleTimeMs: 0,
					efficiency: 0,
				},
			});
		}
		if (/^\/api\/arms\/[^/]+\/state$/.test(path)) {
			return json(route, { state: "idle", hasSession: true });
		}
		if (/^\/api\/arms\/[^/]+\/todos$/.test(path)) {
			return json(route, { todos: [] });
		}
		if (/^\/api\/arms\/[^/]+\/messages$/.test(path)) {
			return json(route, { messages: [], truncated: false });
		}

		if (path === "/api/tasks") {
			const tasks = options.tasks ?? [];
			return json(route, {
				tasks,
				pagination: { limit: 100, offset: 0, total: tasks.length },
				counts: { total: tasks.length, byStatus: {} },
			});
		}
		if (/^\/api\/tasks\/[^/]+$/.test(path) && request.method() === "GET") {
			const taskId = path.split("/")[3];
			const task = (options.tasks ?? []).find(
				(candidate) =>
					typeof candidate === "object" &&
					candidate !== null &&
					"id" in candidate &&
					candidate.id === taskId,
			);
			return task
				? json(route, { task, dependencies: [] })
				: json(route, { error: "Task not found" }, 404);
		}

		if (path === "/api/mail/inbox") {
			const messages = options.inbox ?? [];
			return json(route, {
				messages,
				pagination: {
					limit: 100,
					offset: 0,
					total: messages.length,
					unread: messages.length,
				},
			});
		}
		if (path === "/api/mail/sent") {
			const messages = options.sent ?? [];
			return json(route, {
				messages,
				pagination: { limit: 100, offset: 0, total: messages.length },
			});
		}
		if (path === "/api/mail/archive") {
			const messages = options.archive ?? [];
			return json(route, {
				messages,
				pagination: { limit: 100, offset: 0, total: messages.length },
			});
		}

		if (path === "/api/status-reports") {
			return json(route, {
				reports: [],
				pagination: { limit: 100, offset: 0, total: 0 },
			});
		}
		if (path === "/api/activity") {
			const activity = options.activity ?? [];
			return json(route, {
				activity,
				pagination: {
					limit: url.searchParams.get("producer") === "brain" ? 200 : 100,
					offset: 0,
					total: activity.length,
					hasMore: false,
					nextCursor: null,
				},
			});
		}
		if (path === "/api/events/recent") {
			return json(route, { events: [], total: 0 });
		}

		return json(route, {});
	});
}
