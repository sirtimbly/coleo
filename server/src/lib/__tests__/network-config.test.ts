import { describe, expect, it } from "bun:test";

import {
  resolveApiHost,
  resolveApiKey,
  resolveApiPort,
  resolveApiUrl,
  resolveNatsHost,
  resolveNatsHttpPort,
  resolveNatsPort,
  resolveNatsUrl,
} from "../../network-config";

describe("network configuration", () => {
  it("derives API server and client settings from the same host and port variables", () => {
    const env = { COLEO_API_HOST: "127.0.0.2", COLEO_API_PORT: "18080" };

    expect(resolveApiHost(env)).toBe("127.0.0.2");
    expect(resolveApiPort(env)).toBe(18080);
    expect(resolveApiUrl(env)).toBe("http://127.0.0.2:18080");
  });

  it("uses an explicit API URL as the client override", () => {
    expect(resolveApiUrl({
      COLEO_API_HOST: "127.0.0.2",
      COLEO_API_PORT: "18080",
      COLEO_API_URL: "https://coleo.example/",
    })).toBe("https://coleo.example");
  });

  it("normalizes the legacy API token as the shared API key", () => {
    expect(resolveApiKey({ COLEO_API_TOKEN: "co_legacy" })).toBe("co_legacy");
    expect(resolveApiKey({ COLEO_API_KEY: "co_current", COLEO_API_TOKEN: "co_legacy" })).toBe("co_current");
  });

  it("derives NATS settings from one host and port contract", () => {
    const env = {
      COLEO_NATS_HOST: "127.0.0.3",
      COLEO_NATS_PORT: "14222",
      COLEO_NATS_HTTP_PORT: "18222",
    };

    expect(resolveNatsHost(env)).toBe("127.0.0.3");
    expect(resolveNatsPort(env)).toBe(14222);
    expect(resolveNatsHttpPort(env)).toBe(18222);
    expect(resolveNatsUrl(env)).toBe("nats://127.0.0.3:14222");
  });

  it("uses explicit NATS URLs for remote deployments", () => {
    expect(resolveNatsUrl({
      COLEO_NATS_HOST: "127.0.0.3",
      COLEO_NATS_PORT: "14222",
      COLEO_NATS_URL: "tls://nats.example:4222",
    })).toBe("tls://nats.example:4222");
  });
});
