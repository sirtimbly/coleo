import { describe, expect, it } from "bun:test";

import { createRandomId } from "../src/lib/utils";

describe("createRandomId", () => {
  it("creates distinct 128-bit hexadecimal IDs without randomUUID", () => {
    const first = createRandomId("panel");
    const second = createRandomId("panel");

    expect(first).toMatch(/^panel-[0-9a-f]{32}$/);
    expect(second).toMatch(/^panel-[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });
});
