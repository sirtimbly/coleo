import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { formatErrorResponse, HttpError } from "../middleware/error";

describe("public server error diagnostics", () => {
  it("exposes only explicitly supplied diagnostic messages", async () => {
    const app = new Hono();
    app.onError((error, c) => formatErrorResponse(c, error));
    app.get("/private", () => { throw HttpError.internal("sensitive underlying exception"); });
    app.get("/diagnostic", () => {
      throw HttpError.internal("sensitive underlying exception", "Configuration filesystem is read-only.");
    });
    for (const [path, message] of [
      ["/private", "Internal server error"],
      ["/diagnostic", "Configuration filesystem is read-only."],
    ]) {
      const response = await app.request(path!);
      expect(response.status).toBe(500);
      expect((await response.json()).error).toBe(message);
    }
  });
});
