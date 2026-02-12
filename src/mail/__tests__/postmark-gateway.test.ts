import { describe, expect, it } from "bun:test";
import { normalizePostmarkInbound } from "../postmark-gateway";

describe("normalizePostmarkInbound", () => {
  it("normalizes a minimal payload", () => {
    const message = normalizePostmarkInbound({
      From: "sender@example.com",
      To: "brain@example.com",
      Subject: "Hello",
      TextBody: "Ping",
      MessageID: "abc-123",
    });

    expect(message.from).toBe("sender@example.com");
    expect(message.to).toBe("brain@example.com");
    expect(message.subject).toBe("Hello");
    expect(message.body).toBe("Ping");
    expect(message.headers["x-mail-provider"]).toBe("postmark");
    expect(message.headers["x-postmark-message-id"]).toBe("abc-123");
  });

  it("falls back to nested address objects and html body", () => {
    const message = normalizePostmarkInbound({
      FromFull: { Email: "nested@example.com" },
      ToFull: [{ Email: "brain@coleo.local" }],
      HtmlBody: "<p>HTML body</p>",
      Headers: [
        { Name: "X-Test", Value: "true" },
      ],
    });

    expect(message.from).toBe("nested@example.com");
    expect(message.to).toBe("brain@coleo.local");
    expect(message.subject).toBe("(no subject)");
    expect(message.body).toBe("<p>HTML body</p>");
    expect(message.headers["x-test"]).toBe("true");
  });

  it("throws for non-object payload", () => {
    expect(() => normalizePostmarkInbound("invalid")).toThrow("Inbound payload must be an object");
  });
});
