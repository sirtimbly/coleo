import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { api } from "../src/lib/api";

const createResponse = (body: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => body,
  }) as Response;

const createFetchMock = (
  impl: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch => {
  const mock = Object.assign(impl, { preconnect: () => {} });
  return mock as typeof fetch;
};

class LocalStorageMock implements Storage {
  #store = new Map<string, string>();

  get length(): number {
    return this.#store.size;
  }

  clear(): void {
    this.#store.clear();
  }

  getItem(key: string): string | null {
    return this.#store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#store.set(key, value);
  }
}

describe("web mail API client", () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new LocalStorageMock(),
    });
    api.clearApiKey();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    api.clearApiKey();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("requests inbox mail with the same query shape MailPage uses", async () => {
    let requestedUrl = "";

    globalThis.fetch = createFetchMock(async (input) => {
      requestedUrl = String(input);
      return createResponse({ messages: [], pagination: { total: 0, unread: 0 } });
    });

    await api.listInbox({ limit: 50, offset: 10 });

    expect(requestedUrl).toBe("/api/mail/inbox?limit=50&offset=10");
  });

  it("sends mark-read to the dedicated read endpoint with POST", async () => {
    let requestUrl = "";
    let requestMethod = "";

    globalThis.fetch = createFetchMock(async (input, init) => {
      requestUrl = String(input);
      requestMethod = init?.method ?? "";
      return createResponse({ success: true });
    });

    await api.markMailRead("message-123");

    expect(requestUrl).toBe("/api/mail/inbox/message-123/read");
    expect(requestMethod).toBe("POST");
  });

  it("sends archive to the dedicated archive endpoint with POST", async () => {
    let requestUrl = "";
    let requestMethod = "";

    globalThis.fetch = createFetchMock(async (input, init) => {
      requestUrl = String(input);
      requestMethod = init?.method ?? "";
      return createResponse({ success: true });
    });

    await api.archiveMail("message-123");

    expect(requestUrl).toBe("/api/mail/inbox/message-123/archive");
    expect(requestMethod).toBe("POST");
  });

  it("posts send-mail payload as JSON and includes the stored API key", async () => {
    let requestInit: RequestInit | undefined;

    api.setApiKey("test-api-key");
    globalThis.fetch = createFetchMock(async (_input, init) => {
      requestInit = init;
      return createResponse({ message: { id: "mail-1" } });
    });

    await api.sendMail({
      from: "from@example.test",
      to: "to@example.test",
      subject: "Subject",
      body: "Body",
      headers: { "x-test": "1" },
    });

    const headers = new Headers(requestInit?.headers);

    expect(requestInit?.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-API-Key")).toBe("test-api-key");
    expect(requestInit?.body).toBe(
      JSON.stringify({
        from: "from@example.test",
        to: "to@example.test",
        subject: "Subject",
        body: "Body",
        headers: { "x-test": "1" },
      }),
    );
  });

  it("posts brain replies with mail thread identity", async () => {
    let requestInit: RequestInit | undefined;

    globalThis.fetch = createFetchMock(async (_input, init) => {
      requestInit = init;
      return createResponse({ sent: true, messageId: "mail-1", subject: "Re: Subject" });
    });

    await api.sendBrainMessage({
      message: "Follow up",
      subject: "Re: Subject",
      inReplyTo: "<brain-message@example.test>",
      threadId: "task-123",
    });

    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.body).toBe(
      JSON.stringify({
        message: "Follow up",
        subject: "Re: Subject",
        inReplyTo: "<brain-message@example.test>",
        threadId: "task-123",
      }),
    );
  });
});
