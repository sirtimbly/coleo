import { describe, expect, it } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { OpenCodeApiHarness } from "../opencode-api";
import { isColeoSessionForArm, shouldPruneSession } from "../session-lifecycle";

interface SessionFixture {
  id?: string;
  title?: string;
}

function invokePrune(
  harness: OpenCodeApiHarness,
  client: OpencodeClient,
  armId: string,
  keepSessionId: string,
): Promise<void> {
  const privateApi = harness as unknown as {
    pruneOtherSessions: (
      client: OpencodeClient,
      armId: string,
      keepSessionId: string,
    ) => Promise<void>;
  };
  return privateApi.pruneOtherSessions(client, armId, keepSessionId);
}

function createClient(
  sessions: SessionFixture[],
  opts?: {
    failDeleteIds?: string[];
    throwOnList?: boolean;
  },
): { client: OpencodeClient; deletedIds: string[] } {
  const deletedIds: string[] = [];
  const failDeleteIds = new Set(opts?.failDeleteIds || []);

  const client = {
    session: {
      list: async () => {
        if (opts?.throwOnList) {
          throw new Error("list failed");
        }
        return { data: sessions };
      },
      delete: async ({ path }: { path: { id: string } }) => {
        if (failDeleteIds.has(path.id)) {
          throw new Error(`delete failed for ${path.id}`);
        }
        deletedIds.push(path.id);
        return { data: { id: path.id } };
      },
    },
  } as unknown as OpencodeClient;

  return { client, deletedIds };
}

describe("session lifecycle helpers", () => {
  it("recognizes Coleo sessions for a specific arm", () => {
    expect(isColeoSessionForArm({ title: "Coleo Arm: Qorol (2026-03-16T00:00:00.000Z)" }, "Qorol")).toBe(true);
    expect(isColeoSessionForArm({ title: "Coleo Arm: Vorate (2026-03-16T00:00:00.000Z)" }, "Qorol")).toBe(false);
    expect(isColeoSessionForArm({ title: "Manual Session" }, "Qorol")).toBe(false);
  });

  it("only prunes same-arm Coleo sessions and never the keep session", () => {
    expect(shouldPruneSession({ id: "keep", title: "Coleo Arm: Qorol (x)" }, "Qorol", "keep")).toBe(false);
    expect(shouldPruneSession({ id: "stale", title: "Coleo Arm: Qorol (x)" }, "Qorol", "keep")).toBe(true);
    expect(shouldPruneSession({ id: "manual", title: "My Scratch Session" }, "Qorol", "keep")).toBe(false);
    expect(shouldPruneSession({ id: "other", title: "Coleo Arm: Vorate (x)" }, "Qorol", "keep")).toBe(false);
  });
});

describe("OpenCodeApiHarness session pruning", () => {
  it("deletes only stale sessions for the same arm", async () => {
    const harness = new OpenCodeApiHarness();
    const { client, deletedIds } = createClient([
      { id: "keep", title: "Coleo Arm: Qorol (new)" },
      { id: "stale-1", title: "Coleo Arm: Qorol (old)" },
      { id: "manual-1", title: "session: bug scratchpad" },
      { id: "other-arm", title: "Coleo Arm: Vorate (old)" },
      { id: "no-title" },
    ]);

    await invokePrune(harness, client, "Qorol", "keep");

    expect(deletedIds).toEqual(["stale-1"]);
  });

  it("continues pruning when one delete call fails", async () => {
    const harness = new OpenCodeApiHarness();
    const { client, deletedIds } = createClient(
      [
        { id: "stale-1", title: "Coleo Arm: Qorol (old-1)" },
        { id: "stale-2", title: "Coleo Arm: Qorol (old-2)" },
      ],
      { failDeleteIds: ["stale-1"] },
    );

    await invokePrune(harness, client, "Qorol", "keep");

    expect(deletedIds).toEqual(["stale-2"]);
  });

  it("swallows session.list errors", async () => {
    const harness = new OpenCodeApiHarness();
    const { client, deletedIds } = createClient([], { throwOnList: true });

    await expect(invokePrune(harness, client, "Qorol", "keep")).resolves.toBeUndefined();
    expect(deletedIds).toEqual([]);
  });
});
