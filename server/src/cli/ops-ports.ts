import { isPortAvailable } from "./init-environment";
import type { OperatorValues, ResolvedOperatorConfig } from "./operator-config";

export async function nextAvailablePort(start: number, host: string, reserved = new Set<number>(),
  available = isPortAvailable): Promise<number> {
  for (let port = start; port <= 65535; port++) {
    if (!reserved.has(port) && await available(port, host)) {
      reserved.add(port);
      return port;
    }
  }
  throw new Error(`No available port at or above ${start} on ${host}`);
}

/** Only allocate unset endpoints. Saved installations keep their ports on resume. */
export async function planLocalPorts(config: ResolvedOperatorConfig, explicitServer?: string,
  externalNats?: string, available = isPortAvailable): Promise<Partial<OperatorValues>> {
  const { values, sources } = config;
  const result: Partial<OperatorValues> = {};
  const host = sources.host === "default" ? "127.0.0.1" : values.host;
  const reserved = new Set<number>();
  if (!explicitServer && sources.apiUrl === "default" && sources.port === "default") {
    result.port = String(await nextAvailablePort(8080, host, reserved, available));
    const clientHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
    result.apiUrl = `http://${clientHost}:${result.port}`;
    result.host = host;
  } else {
    // Reserve fixed API endpoints before allocating anything else, so broker
    // scanning cannot hand out the API's port while the API is still stopped.
    const explicitPort = explicitServer ? new URL(explicitServer).port : sources.port !== "default" ? values.port : "";
    if (Number(explicitPort)) reserved.add(Number(explicitPort));
  }
  if (!externalNats && ["default", "derived"].includes(sources.natsUrl)) {
    for (const key of ["natsPort", "natsHttpPort"] as const) {
      if (sources[key] !== "default") reserved.add(Number(values[key]));
    }
    for (const key of ["natsPort", "natsHttpPort"] as const) {
      if (sources[key] === "default") {
        result[key] = String(await nextAvailablePort(Number(values[key]), values.natsHost, reserved, available));
      } else reserved.add(Number(values[key]));
    }
    result.natsHost = values.natsHost;
  }
  return result;
}
