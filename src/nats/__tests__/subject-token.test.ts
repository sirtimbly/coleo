import { describe, expect, it } from "bun:test";
import { subjectToken, decodeSubjectToken } from "../subject-token";
import { TOPICS } from "../types";
import { InMemoryEventStore } from "../in-memory-event-store";
import { parseEventSubject } from "../status-consumer";

describe("entity IDs in NATS subjects", () => {
  it("encodes whitespace, separators and wildcards without changing ordinary IDs", () => {
    expect(subjectToken("arm-1")).toBe("arm-1");
    for (const id of ["Pom Pom", "arm.with.dots", "*", ">", "arm\nname", "Pom%20Pom"]) {
      const token = subjectToken(id);
      expect(token).not.toMatch(/[\s.*>]/);
      expect(decodeSubjectToken(token)).toBe(id);
    }
    expect(subjectToken("Pom Pom")).not.toBe(subjectToken("Pom%20Pom"));
    expect(TOPICS.armEvent("Pom Pom")).toBe("coleo.arm.Pom%20Pom.event");
  });

  it("queries an encoded arm's events using its original ID", async () => {
    const store = new InMemoryEventStore();
    store.initialize();
    await store.publishEvent(`coleo.events.arm.${subjectToken("Pom Pom")}.message.updated`, {
      type: "message.updated", armId: "Pom Pom", timestamp: new Date().toISOString(), data: {},
    });
    expect((await store.getArmEvents("Pom Pom"))[0]?.armId).toBe("Pom Pom");
    expect(await store.getArmEvents("Pom%20Pom")).toEqual([]);
    expect(parseEventSubject("coleo.events.arm.Pom%20Pom.status_changed")?.entityId).toBe("Pom Pom");
  });
});
