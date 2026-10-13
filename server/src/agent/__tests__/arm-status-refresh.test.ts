import { describe, expect, it } from "bun:test";

import { ArmAgent } from "../arm-agent";

describe("ArmAgent status refresh", () => {
	it("maps nested OpenCode session status events", () => {
		const agent = new ArmAgent({
			agentId: "test-agent",
			natsUrl: "nats://127.0.0.1:4222",
			coleoDir: "/tmp",
		});
		const mapEventStatus = (
			agent as unknown as {
				mapEventStatus: (event: string, data: unknown) => string | null;
			}
		).mapEventStatus.bind(agent);

		expect(mapEventStatus("session.status", { status: { type: "idle" } })).toBe("idle");
		expect(mapEventStatus("session.status", { status: { type: "busy" } })).toBe("busy");
	});

	it("refreshes persisted busy state from the live harness", async () => {
		const agent = new ArmAgent({
			agentId: "test-agent",
			natsUrl: "nats://127.0.0.1:4222",
			coleoDir: "/tmp",
		});
		const internals = agent as unknown as {
			managedArms: Map<string, Record<string, unknown>>;
			handleGetState: (command: { type: "get_state"; armId: string; requestId: string }) => Promise<{
				success: boolean;
				data?: { status: string };
			}>;
		};
		internals.managedArms.set("arm-1", {
			armId: "arm-1",
			name: "Arm One",
			domain: "general",
			harnessName: "opencode-api",
			harness: {
				getState: async () => "idle",
			},
			session: {},
			status: "busy",
			provider: null,
			model: null,
			startedAt: new Date().toISOString(),
			lastActivityAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
			error: null,
		});

		const response = await internals.handleGetState({
			type: "get_state",
			armId: "arm-1",
			requestId: "request-1",
		});

		expect(response.success).toBe(true);
		expect(response.data?.status).toBe("idle");
	});

	it("forwards interrupt with distributed prompts", async () => {
		const agent = new ArmAgent({
			agentId: "test-agent",
			natsUrl: "nats://127.0.0.1:4222",
			coleoDir: "/tmp",
		});
		let receivedOptions: unknown;
		const internals = agent as unknown as {
			managedArms: Map<string, Record<string, unknown>>;
			natsClient: { publishArmEvent: () => Promise<void> };
			handlePrompt: (command: {
				type: "prompt";
				armId: string;
				requestId: string;
				prompt: string;
				interrupt?: boolean;
			}) => Promise<{ success: boolean }>;
		};
		internals.natsClient = { publishArmEvent: async () => {} };
		internals.managedArms.set("arm-1", {
			armId: "arm-1",
			name: "Arm One",
			domain: "general",
			harnessName: "opencode-api",
			harness: {
				sendPrompt: async (_session: unknown, _prompt: string, options: unknown) => {
					receivedOptions = options;
				},
			},
			session: {},
			status: "busy",
			provider: null,
			model: null,
			startedAt: new Date().toISOString(),
			lastActivityAt: null,
			error: null,
		});

		const response = await internals.handlePrompt({
			type: "prompt",
			armId: "arm-1",
			requestId: "request-1",
			prompt: "Replacement prompt",
			interrupt: true,
		});

		expect(response.success).toBe(true);
		expect(receivedOptions).toEqual({ interrupt: true, attachments: undefined });
	});
});
