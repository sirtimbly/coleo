import { describe, expect, it } from "bun:test";
import type { JsMsg } from "nats";

import { getProjectScope } from "../../project-scope";
import { buildIndexableEvent } from "../jetstream-transcript-indexer";

describe("transcript indexer", () => {
  it("stores the canonical project partition in transcript metadata", () => {
    const scope = getProjectScope();
    const msg = {
      seq: 42,
      subject: "coleo.events.arm.arm-1.message.updated",
    } as unknown as JsMsg;

    const indexed = buildIndexableEvent(msg, {
      type: "message.updated",
      armId: "arm-1",
      projectDir: scope.projectDir,
      projectKey: scope.projectKey,
      data: { message: "Project-specific transcript" },
      timestamp: "2026-07-30T12:00:00.000Z",
    });

    expect(indexed.payload).toMatchObject({
      type: "arm_transcript",
      metadata: {
        project_dir: scope.projectDir,
        project_key: scope.projectKey,
      },
    });
  });
});
