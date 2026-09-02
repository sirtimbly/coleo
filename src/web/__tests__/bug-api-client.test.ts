import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { api } from "../src/lib/api";

const createResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => body,
}) as Response;

const createFetchMock = (
  impl: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch => Object.assign(impl, { preconnect: () => {} }) as typeof fetch;

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

describe("web bug API client", () => {
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

  it("serializes tags as repeated query parameters without splitting commas", async () => {
    let requestedUrl = "";
    globalThis.fetch = createFetchMock(async (input) => {
      requestedUrl = String(input);
      return createResponse({ bugs: [], pagination: { limit: 50, offset: 0, total: 0 } });
    });

    await api.listBugs({ tags: ["release,2026", "backend"] });

    const url = new URL(requestedUrl, "http://localhost");
    expect(url.pathname).toBe("/api/bugs");
    expect(url.searchParams.getAll("tags")).toEqual(["release,2026", "backend"]);
  });
});
