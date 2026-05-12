import { afterEach, describe, expect, it } from "bun:test";
import { normalizePostmarkInbound, sendPostmarkMessage } from "../postmark-gateway";

const createFetchMock = (
  impl: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch => {
  const mock = Object.assign(impl, { preconnect: () => {} });
  return mock as typeof fetch;
};

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

  it("falls back when email fields are malformed", () => {
    const message = normalizePostmarkInbound({
      From: "not-an-email",
      To: " ",
      Subject: "   ",
      TextBody: 1234,
      HtmlBody: "   ",
      MessageID: "   ",
      Headers: [
        { Name: "  ", Value: "hello" },
        { Name: "X-Valid", Value: " ok " },
        { Name: "X-Invalid", Value: 42 },
      ],
    });

    expect(message.from).toBe("unknown@postmark.local");
    expect(message.to).toBe("brain@coleo.local");
    expect(message.subject).toBe("(no subject)");
    expect(message.body).toBe("");
    expect(message.headers["x-postmark-message-id"]).toBeUndefined();
    expect(message.headers["x-valid"]).toBe("ok");
    expect(message.headers["x-invalid"]).toBeUndefined();
  });

  it("throws for non-object payload", () => {
    expect(() => normalizePostmarkInbound("invalid")).toThrow("Inbound payload must be an object");
  });
});

describe("sendPostmarkMessage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes conversation headers to Postmark", async () => {
    let payload: Record<string, unknown> | undefined;

    globalThis.fetch = createFetchMock(async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ MessageID: "postmark-123", SubmittedAt: "2026-04-20T00:00:00Z" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    await sendPostmarkMessage({
      apiToken: "token",
      from: "brain@example.test",
      to: "human@example.test",
      subject: "Re: Task",
      textBody: "Done",
      headers: {
        "X-Coleo-Thread-Id": "task-123",
        "In-Reply-To": "<message@example.test>",
      },
    });

    expect(payload?.Headers).toEqual([
      { Name: "X-Coleo-Thread-Id", Value: "task-123" },
      { Name: "In-Reply-To", Value: "<message@example.test>" },
    ]);
  });
});
