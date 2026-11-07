import { expect, test } from "bun:test";
import { nextAvailablePort, planLocalPorts } from "../ops-ports";
import { SETTINGS, applyOperatorEnvironment } from "../operator-config";
import type { ResolvedOperatorConfig, Setting } from "../operator-config";

function defaults(): ResolvedOperatorConfig {
  const config = { values: {}, sources: {}, origins: {}, path: "fixture" } as ResolvedOperatorConfig;
  for (const key of Object.keys(SETTINGS) as Setting[]) {
    config.values[key] = SETTINGS[key][1]; config.sources[key] = "default"; config.origins[key] = "default";
  }
  return config;
}

test("new local installation skips occupied API and both NATS ports", async () => {
  const busy = new Set([8080, 8081, 4222, 8222]);
  const plan = await planLocalPorts(defaults(), undefined, undefined, async port => !busy.has(port));
  expect(plan).toEqual({ host: "127.0.0.1", port: "8082", apiUrl: "http://127.0.0.1:8082",
    natsHost: "127.0.0.1", natsPort: "4223", natsHttpPort: "8223" });
});

test("saved ports survive resume even while services occupy them", async () => {
  const config = defaults();
  for (const key of ["port", "apiUrl", "natsPort", "natsHttpPort"] as const) config.sources[key] = "saved";
  config.sources.natsUrl = "derived";
  const plan = await planLocalPorts(config, undefined, undefined, async () => { throw new Error("Must not scan saved ports"); });
  expect(plan).toEqual({ natsHost: "127.0.0.1" });
});

test("explicit endpoints are not replaced", async () => {
  expect(await planLocalPorts(defaults(), "http://localhost:9000", "nats://remote:4222",
    async () => { throw new Error("Must not scan explicit endpoints"); })).toEqual({});
});

test("a saved API port is reserved before broker allocation", async () => {
  const config = defaults();
  config.values.port = "4222";
  config.sources.port = "saved";
  config.sources.apiUrl = "saved";
  config.values.apiUrl = "http://127.0.0.1:4222";
  // 4222 is free at planning time; the allocator must still not select it for NATS.
  const plan = await planLocalPorts(config, undefined, undefined, async() => true);
  expect(plan.port).toBeUndefined();
  expect(plan.natsPort).toBe("4223");
  expect(plan.natsHttpPort).toBe("8222");
});

test("an explicit server URL port is reserved before broker allocation", async () => {
  const plan = await planLocalPorts(defaults(), "http://127.0.0.1:4222", undefined, async() => true);
  expect(plan.natsPort).toBe("4223");
  expect(plan.natsHttpPort).toBe("8222");
});

test("an explicit monitor port is reserved before NATS allocation", async () => {
  const config = defaults();
  config.values.natsHttpPort = "8223";
  config.sources.natsHttpPort = "saved";
  // Free ports below 8223 are busy; NATS must skip the monitor's fixed port.
  const plan = await planLocalPorts(config, undefined, undefined, async port => port >= 8223);
  expect(plan.natsPort).toBe("8224");
  expect(plan.natsHttpPort).toBeUndefined();
});

test("real socket occupancy is detected and exhausted range fails", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  try { expect(await nextAvailablePort(server.port!, "127.0.0.1")).toBeGreaterThan(server.port!); }
  finally { await server.stop(true); }
  await expect(nextAvailablePort(65535, "127.0.0.1", new Set(), async () => false)).rejects.toThrow("No available port");
});

test("wildcard listeners block loopback port selection", async () => {
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("occupied") });
  try { expect(await nextAvailablePort(server.port!, "127.0.0.1")).toBeGreaterThan(server.port!); }
  finally { await server.stop(true); }
});

test("derived NATS ports reach runtime without disabling local broker bootstrap", () => {
  const original = { ...process.env };
  try {
    delete process.env.COLEO_NATS_URL;
    const config = defaults();
    config.values.natsPort = "4223"; config.values.natsHttpPort = "8223";
    config.values.natsUrl = "nats://127.0.0.1:4223"; config.sources.natsUrl = "derived";
    applyOperatorEnvironment(config);
    expect(process.env.COLEO_NATS_URL).toBeUndefined();
    expect(process.env.COLEO_NATS_PORT).toBe("4223");
    expect(process.env.COLEO_NATS_HTTP_PORT).toBe("8223");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
