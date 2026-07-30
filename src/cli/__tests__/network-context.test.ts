import { afterEach, describe, expect, it } from "bun:test";

import { loadApiConfig } from "../../api/config";
import { getApiConfig } from "../context";

const trackedEnv = [
  "COLEO_API_HOST",
  "COLEO_API_PORT",
  "COLEO_API_URL",
] as const;
const originalEnv = Object.fromEntries(
  trackedEnv.map((key) => [key, process.env[key]]),
) as Record<(typeof trackedEnv)[number], string | undefined>;

afterEach(() => {
  for (const key of trackedEnv) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("shared API network configuration", () => {
  it("configures the server and CLI client from the same host and port", () => {
    delete process.env.COLEO_API_URL;
    process.env.COLEO_API_HOST = "127.0.0.5";
    process.env.COLEO_API_PORT = "18085";

    expect(loadApiConfig()).toMatchObject({ host: "127.0.0.5", port: 18085 });
    expect(getApiConfig().apiUrl).toBe("http://127.0.0.5:18085");
  });

  it("allows a full client URL override without changing server binding", () => {
    process.env.COLEO_API_HOST = "0.0.0.0";
    process.env.COLEO_API_PORT = "18085";
    process.env.COLEO_API_URL = "https://coleo.example";

    expect(loadApiConfig()).toMatchObject({ host: "0.0.0.0", port: 18085 });
    expect(getApiConfig().apiUrl).toBe("https://coleo.example");
  });
});
