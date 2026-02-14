import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { JSONCodec, type Msg, type Subscription } from "nats";
import { startBrainMessageBridge } from "../brain-message-bridge";

class MockSubscription implements AsyncIterable<Msg> {
	private queue: Msg[] = [];
	private waiters: Array<(value: IteratorResult<Msg>) => void> = [];
	private closed = false;

	push(msg: Msg): void {
		if (this.closed) {
			return;
		}
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value: msg, done: false });
			return;
		}
		this.queue.push(msg);
	}

	unsubscribe(): void {
		this.closed = true;
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			waiter?.({ value: undefined as unknown as Msg, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<Msg> {
		return {
			next: () => {
				if (this.queue.length > 0) {
					const value = this.queue.shift()!;
					return Promise.resolve({ value, done: false });
				}
				if (this.closed) {
					return Promise.resolve({
						value: undefined as unknown as Msg,
						done: true,
					});
				}
				return new Promise((resolve) => {
					this.waiters.push(resolve);
				});
			},
		};
	}
}

class MockNatsConnection {
	public readonly subscription = new MockSubscription();

	subscribe(_subject: string): Subscription {
		return this.subscription as unknown as Subscription;
	}
}

const codec = JSONCodec<unknown>();

function setupMessagesTable(db: Database): void {
	db.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      error TEXT
    )
  `);
}

describe("brain-message-bridge", () => {
	it("queues valid brain messages from NATS into the API message table", async () => {
		const db = new Database(":memory:");
		setupMessagesTable(db);
		const connection = new MockNatsConnection();

		const bridge = startBrainMessageBridge({
			connection: connection as unknown as Parameters<
				typeof startBrainMessageBridge
			>[0]["connection"],
			db,
		});

		connection.subscription.push({
			data: codec.encode({
				from: "arm-1",
				to: "brain",
				type: "status_update",
				payload: { taskId: "task-1" },
				timestamp: new Date().toISOString(),
			}),
		} as Msg);

		await Bun.sleep(20);

		const row = db
			.query("SELECT from_id, to_id, message_type, payload FROM messages LIMIT 1")
			.get() as
			| {
					from_id: string;
					to_id: string;
					message_type: string;
					payload: string;
			  }
			| null;

		expect(row).toBeTruthy();
		expect(row?.from_id).toBe("arm-1");
		expect(row?.to_id).toBe("brain");
		expect(row?.message_type).toBe("status_update");
		expect(JSON.parse(row?.payload || "{}")).toEqual({ taskId: "task-1" });

		bridge.close();
		db.close();
	});

	it("ignores invalid payloads", async () => {
		const db = new Database(":memory:");
		setupMessagesTable(db);
		const connection = new MockNatsConnection();

		const bridge = startBrainMessageBridge({
			connection: connection as unknown as Parameters<
				typeof startBrainMessageBridge
			>[0]["connection"],
			db,
		});

		connection.subscription.push({
			data: codec.encode({ from: "arm-1", to: "not-brain" }),
		} as Msg);

		await Bun.sleep(20);

		const row = db.query("SELECT COUNT(*) AS count FROM messages").get() as {
			count: number;
		};
		expect(row.count).toBe(0);

		bridge.close();
		db.close();
	});

	it("ignores unsupported brain message types", async () => {
		const db = new Database(":memory:");
		setupMessagesTable(db);
		const connection = new MockNatsConnection();

		const bridge = startBrainMessageBridge({
			connection: connection as unknown as Parameters<
				typeof startBrainMessageBridge
			>[0]["connection"],
			db,
		});

		connection.subscription.push({
			data: codec.encode({
				from: "arm-1",
				to: "brain",
				type: "claim_transfer",
				payload: { filePath: "src/x.ts" },
				timestamp: new Date().toISOString(),
			}),
		} as Msg);

		await Bun.sleep(20);

		const row = db.query("SELECT COUNT(*) AS count FROM messages").get() as {
			count: number;
		};
		expect(row.count).toBe(0);

		bridge.close();
		db.close();
	});
});
