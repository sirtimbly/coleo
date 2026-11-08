import { afterEach, expect, spyOn, test } from "bun:test";
import { createTestEventStore, resetEventStore, setEventStore } from "../../nats/jetstream";
import * as nats from "../../nats/server";
import { createActivityRoutes } from "../routes/activity";

const originalEnabled = process.env.COLEO_COMMAND_PROJECTOR_ENABLED;
let managerSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  managerSpy?.mockRestore();
  resetEventStore();
  if (originalEnabled === undefined) delete process.env.COLEO_COMMAND_PROJECTOR_ENABLED;
  else process.env.COLEO_COMMAND_PROJECTOR_ENABLED = originalEnabled;
});

test.each([
  { name: "idle queue with old delivery", pending: 0, ack: 0, age: 600_000, status: "healthy" },
  { name: "empty consumer with no deliveries", pending: 0, ack: 0, age: null, status: "healthy" },
  { name: "recent delivery with backlog", pending: 2, ack: 0, age: 1000, status: "lagging" },
  { name: "old delivery with backlog", pending: 2, ack: 0, age: 600_000, status: "stale" },
  { name: "old unacknowledged delivery", pending: 0, ack: 1, age: 600_000, status: "stale" },
  { name: "backlog without a delivery", pending: 1, ack: 0, age: null, status: "stale" },
])("command queue health: $name", async ({ pending, ack, age, status }) => {
  process.env.COLEO_COMMAND_PROJECTOR_ENABLED = "true";
  setEventStore(createTestEventStore());
  const lastActive = age === null ? undefined : new Date(Date.now() - age).toISOString();
  managerSpy = spyOn(nats, "getNatsManager").mockReturnValue({
    getConnection: () => ({
      jetstreamManager: async () => ({
        streams: { info: async () => ({ state: { last_seq: 152, messages: 152 } }) },
        consumers: { info: async () => ({
          num_pending: pending, num_ack_pending: ack,
          delivered: { stream_seq: 152, consumer_seq: 152, last_active: lastActive },
        }) },
      }),
    }),
  } as unknown as nats.NatsManager);
  const response = await createActivityRoutes().request("/command-queue-health?staleMs=120000");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status, lagMessages: pending, ackPending: ack, consumerFound: true });
});
