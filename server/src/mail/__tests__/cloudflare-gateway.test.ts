import { afterEach, describe, expect, it } from "bun:test";
import { sendCloudflareMessage } from "../cloudflare-gateway";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sendCloudflareMessage", () => {
  it("uses the Cloudflare Email Sending REST API field names", async () => {
    let url = "";
    let payload: Record<string, unknown> | undefined;

    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      url = String(input);
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        success: true,
        result: { delivered: ["human@example.test"], permanent_bounces: [], queued: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }, { preconnect: () => {} }) as typeof fetch;

    const result = await sendCloudflareMessage({
      accountId: "account/id",
      apiToken: "secret",
      from: "brain@example.test",
      to: "human@example.test",
      subject: "Task complete",
      textBody: "Done",
      replyTo: "brain@example.test",
      headers: { "X-Coleo-Thread-Id": "task-123" },
    });

    expect(url).toEndWith("/accounts/account%2Fid/email/sending/send");
    expect(payload?.from).toEqual({ address: "brain@example.test" });
    expect(payload?.reply_to).toBe("brain@example.test");
    expect(payload?.text).toBe("Done");
    expect(result.delivered).toEqual(["human@example.test"]);
  });

  it("surfaces Cloudflare API errors", async () => {
    globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
      success: false,
      errors: [{ code: 1000, message: "Sender domain not verified" }],
      result: null,
    }), { status: 400, headers: { "Content-Type": "application/json" } }), { preconnect: () => {} }) as typeof fetch;

    await expect(sendCloudflareMessage({
      accountId: "account",
      apiToken: "secret",
      from: "brain@example.test",
      to: "human@example.test",
      subject: "Test",
      textBody: "Body",
    })).rejects.toThrow("Sender domain not verified");
  });
});
