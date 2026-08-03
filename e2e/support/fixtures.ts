/**
 * Deterministic API boundary used by workbench browser tests.
 *
 * Individual specs override only the resources they exercise while common
 * shell, onboarding, profile, and empty-resource responses stay centralized.
 */

/// <reference lib="dom" />

import type { Page, Route } from "@playwright/test";

interface MockApiOptions {
	arms?: unknown[];
	tasks?: Array<Record<string, unknown>>;
	bugs?: Array<Record<string, unknown>>;
	discoveries?: Array<Record<string, unknown>>;
	inbox?: unknown[];
	sent?: unknown[];
	archive?: unknown[];
	activity?: unknown[];
	recentEvents?: unknown[];
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
	const taskRecords = (options.tasks ?? []).map((task) => ({ ...task }));
	const bugRecords = (options.bugs ?? []).map((bug) => ({ ...bug }));
	const discoveryRecords = (options.discoveries ?? []).map((discovery) => ({ ...discovery }));
	const viewRecords: Array<Record<string, unknown>> = [];
	const cardInstances = new Map<string, unknown>();
	const attentionRecords = new Map<string, Record<string, unknown>>();

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
			return json(route, {
				cwd: "/workspace/coleo",
				projectName: "Coleo",
				status: "healthy",
				version: "test",
				uptime: 3600,
				brain: { running: true, status: "running" },
				arms: {
					total: options.arms?.length ?? 0,
					healthy: options.arms?.length ?? 0,
					idle: 0,
					stuck: 0,
					stale: 0,
					details: [],
				},
				proposals: { open: 0 },
				activity: { last24h: options.recentEvents?.length ?? options.activity?.length ?? 0 },
				infrastructure: {
					database: { healthy: true },
					nats: { healthy: true, optional: false },
					maildir: { healthy: true },
					qdrant: { healthy: true, optional: true },
					indexer: { healthy: true, optional: true, running: true },
				},
				timestamp: now,
			});
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
				views: viewRecords,
				layouts: [],
			});
		}
		if (path === "/api/workbench/inbox") {
			return json(route, { items: [], nextCursor: undefined });
		}
		if (path === "/api/workbench/attention" && request.method() === "GET") {
			return json(route, { attention: [...attentionRecords.values()] });
		}
		if (path === "/api/workbench/attention/bulk" && request.method() === "POST") {
			const input = request.postDataJSON() as {
				itemKeys?: string[];
				action?: string;
			};
			const attention = (input.itemKeys ?? []).map((itemKey) => {
				const record = {
					profileId: "local",
					itemKey,
					readAt: now,
					requiresAction: input.action !== "resolve",
					updatedAt: now,
				};
				attentionRecords.set(itemKey, record);
				return record;
			});
			return json(route, { attention });
		}
		if (path.startsWith("/api/workbench/attention/") && request.method() === "PUT") {
			const itemKey = decodeURIComponent(path.slice("/api/workbench/attention/".length));
			const input = request.postDataJSON() as Record<string, unknown>;
			const attention = {
				profileId: "local",
				itemKey,
				...input,
				updatedAt: now,
			};
			attentionRecords.set(itemKey, attention);
			return json(route, { attention });
		}
		if (path === "/api/workbench/cards/instances" && request.method() === "POST") {
			const input = request.postDataJSON() as { envelope: unknown };
			const id = `018fd384-7c9a-7a83-8fd8-${String(cardInstances.size + 1).padStart(12, "0")}`;
			cardInstances.set(id, input.envelope);
			return json(route, {
				instance: { id, envelope: input.envelope, createdAt: now },
			}, 201);
		}
		if (/^\/api\/workbench\/cards\/instances\/[^/]+$/.test(path)) {
			const id = decodeURIComponent(path.split("/").at(-1) ?? "");
			const envelope = cardInstances.get(id);
			return envelope
				? json(route, { instance: { id, envelope, createdAt: now } })
				: json(route, { error: "Card not found" }, 404);
		}
		if (path === "/api/workbench/cards/actions" && request.method() === "POST") {
			const input = request.postDataJSON() as { clientActionId: string };
			return json(route, {
				result: {
					ok: true,
					clientActionId: input.clientActionId,
					message: "Action complete",
				},
			});
		}
		if (path === "/api/workbench/views" && request.method() === "POST") {
			const input = request.postDataJSON() as Record<string, unknown>;
			const view = {
				...input,
				id: input.id ?? `view-${viewRecords.length + 1}`,
				version: 1,
				createdAt: now,
				updatedAt: now,
			};
			viewRecords.push(view);
			return json(route, { view });
		}
		if (/^\/api\/workbench\/views\/[^/]+$/.test(path) && request.method() === "PUT") {
			const viewId = decodeURIComponent(path.split("/").at(-1) ?? "");
			const input = request.postDataJSON() as Record<string, unknown>;
			const index = viewRecords.findIndex((view) => view.id === viewId);
			const view = {
				...(index >= 0 ? viewRecords[index] : {}),
				...input,
				id: viewId,
				version: Number(viewRecords[index]?.version ?? 0) + 1,
				createdAt: viewRecords[index]?.createdAt ?? now,
				updatedAt: now,
			};
			if (index >= 0) viewRecords[index] = view;
			else viewRecords.push(view);
			return json(route, { view });
		}

		if (path === "/api/arms" && request.method() === "GET") {
			return json(route, { arms: options.arms ?? [] });
		}
		if (path === "/api/agents/providers") return json(route, { hosts: [] });
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
		if (path === "/api/project-setup") {
			return json(route, { required: false, completed: true });
		}
		if (path === "/api/tasks/stats") {
			return json(route, {
				total: options.tasks?.length ?? 0,
				byStatus: {},
				completionRate: 0,
				active: 0,
				blocked: 0,
			});
		}
		if (path === "/api/bugs/stats") {
			return json(route, {
				bySource: {},
				byStatus: {},
				byPriority: {},
				recent24h: 0,
			});
		}
		if (path === "/api/discoveries/stats") {
			return json(route, {
				bySeverity: {},
				byKind: {},
				byStatus: {},
				recent24h: 0,
			});
		}
		if (path === "/api/activity/indexer-health") {
			return json(route, {
				status: "healthy",
				stream: "coleo-events",
				durable: "project-scoped",
				consumerFound: true,
				lagMessages: 0,
				ackPending: 0,
				streamLastSeq: 0,
				consumerStreamSeq: 0,
				consumerSeq: 0,
				lastActive: now,
				staleThresholdMs: 120000,
				updatedAt: now,
			});
		}
		if (path === "/api/activity/command-queue-health") {
			return json(route, {
				status: "healthy",
				stream: "coleo-commands",
				durable: "cmd-projector-to-db",
				consumerFound: true,
				lagMessages: 0,
				ackPending: 0,
				streamLastSeq: 0,
				consumerStreamSeq: 0,
				consumerSeq: 0,
				lastActive: now,
				staleThresholdMs: 120000,
				updatedAt: now,
				enabled: true,
			});
		}
		if (path === "/api/events/analysis") {
			return json(route, {
				arms: [],
				summary: {
					productive: 0,
					idle: 0,
					starting: 0,
					waiting: 0,
					looping: 0,
					silent: 0,
					error: 0,
				},
			});
		}
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

		if (path === "/api/tasks" && request.method() === "POST") {
			const input = request.postDataJSON() as Record<string, unknown>;
			const created = {
				...taskRecords[0],
				...input,
				id: `task-created-${taskRecords.length + 1}`,
				createdAt: now,
				updatedAt: now,
			};
			taskRecords.push(created);
			return json(route, { task: created }, 201);
		}
		if (path === "/api/tasks") {
			return json(route, {
				tasks: taskRecords,
				pagination: { limit: 100, offset: 0, total: taskRecords.length },
				counts: { total: taskRecords.length, byStatus: {} },
			});
		}
		if (path === "/api/tasks/reorder" && request.method() === "POST") {
			const input = request.postDataJSON() as {
				taskId: string;
				toIndex?: number;
				prevTaskId?: string | null;
				nextTaskId?: string | null;
			};
			const fromIndex = taskRecords.findIndex((candidate) => candidate.id === input.taskId);
			if (fromIndex < 0) return json(route, { error: "Task not found" }, 404);
			const [movedTask] = taskRecords.splice(fromIndex, 1);
			const nextIndex = input.nextTaskId
				? taskRecords.findIndex((candidate) => candidate.id === input.nextTaskId)
				: -1;
			const previousIndex = input.prevTaskId
				? taskRecords.findIndex((candidate) => candidate.id === input.prevTaskId)
				: -1;
			const targetIndex = nextIndex >= 0
				? nextIndex
				: previousIndex >= 0
					? previousIndex + 1
					: Math.max(0, Math.min(input.toIndex ?? taskRecords.length, taskRecords.length));
			if (movedTask) taskRecords.splice(targetIndex, 0, movedTask);
			taskRecords.forEach((record, index) => {
				record.sortOrder = index;
			});
			return json(route, { success: true });
		}
		if (/^\/api\/tasks\/[^/]+$/.test(path) && request.method() === "PATCH") {
			const taskId = path.split("/")[3];
			const index = taskRecords.findIndex((candidate) => candidate.id === taskId);
			if (index < 0) return json(route, { error: "Task not found" }, 404);
			const updates = request.postDataJSON() as Record<string, unknown>;
			taskRecords[index] = { ...taskRecords[index], ...updates };
			return json(route, { task: taskRecords[index] });
		}
		if (/^\/api\/tasks\/[^/]+$/.test(path) && request.method() === "GET") {
			const taskId = path.split("/")[3];
			const task = taskRecords.find((candidate) => candidate.id === taskId);
			return task
				? json(route, { task, dependencies: [] })
				: json(route, { error: "Task not found" }, 404);
		}
		if (path === "/api/bugs" && request.method() === "GET") {
			return json(route, { bugs: bugRecords });
		}
		if (path === "/api/bugs/reorder" && request.method() === "POST") {
			const input = request.postDataJSON() as { bugId: string; toSortOrder: number };
			const fromIndex = bugRecords.findIndex((candidate) => candidate.id === input.bugId);
			if (fromIndex < 0) return json(route, { error: "Bug not found" }, 404);
			const [movedBug] = bugRecords.splice(fromIndex, 1);
			const targetIndex = input.toSortOrder < 0
				? bugRecords.length
				: Math.min(input.toSortOrder, bugRecords.length);
			if (movedBug) bugRecords.splice(targetIndex, 0, movedBug);
			bugRecords.forEach((record, index) => {
				record.sortOrder = index;
			});
			return json(route, { success: true });
		}
		if (/^\/api\/bugs\/[^/]+$/.test(path) && request.method() === "PATCH") {
			const bugId = path.split("/")[3];
			const index = bugRecords.findIndex((candidate) => candidate.id === bugId);
			if (index < 0) return json(route, { error: "Bug not found" }, 404);
			const updates = request.postDataJSON() as Record<string, unknown>;
			bugRecords[index] = { ...bugRecords[index], ...updates };
			return json(route, { success: true });
		}
		if (path === "/api/discoveries" && request.method() === "GET") {
			return json(route, {
				discoveries: discoveryRecords,
				pagination: {
					limit: 100,
					offset: 0,
					total: discoveryRecords.length,
				},
			});
		}
		if (/^\/api\/discoveries\/[^/]+$/.test(path) && request.method() === "PATCH") {
			const discoveryId = path.split("/")[3];
			const index = discoveryRecords.findIndex(
				(candidate) => candidate.id === discoveryId,
			);
			if (index < 0) return json(route, { error: "Discovery not found" }, 404);
			const updates = request.postDataJSON() as Record<string, unknown>;
			discoveryRecords[index] = { ...discoveryRecords[index], ...updates };
			return json(route, { success: true });
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
			const events = options.recentEvents ?? [];
			return json(route, { events, total: events.length });
		}

		return json(route, {});
	});
}
