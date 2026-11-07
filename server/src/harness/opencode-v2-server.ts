import { OpenCode } from "@opencode/client";
import { nextAvailablePort } from "../cli/ops-ports";
import { waitForOpenCodeServer, stopFailedOpenCodeProcess } from "./opencode-startup";
import { openCodeHeaders } from "./opencode-v2-client";

/** Private server: never attach to or stop the developer's shared OpenCode service. */
export async function startModelCheckServer(directory: string) {
  const port = await nextAvailablePort(19400, "127.0.0.1");
  const password = crypto.randomUUID();
  const headers = openCodeHeaders({ OPENCODE_PASSWORD: password });
  const child = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
      mcp: { servers: { coleo: { type: "local", command: ["false"], disabled: true } } },
    }) },
    stdout: "ignore", stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  try { await waitForOpenCodeServer(url, 30_000, child, 2, headers); }
  catch (error) {
    await stopFailedOpenCodeProcess(child);
    throw new Error(`OpenCode V2 could not start on this Arm Host: ${error instanceof Error ? error.message : error}. Check the host's OpenCode installation; model access was not tested.`);
  }
  return { client: OpenCode.make({ baseUrl: url, headers }), close: () => stopFailedOpenCodeProcess(child) };
}
