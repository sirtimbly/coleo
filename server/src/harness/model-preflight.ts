import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStartupTimeout } from "./opencode-startup";
import { ModelCheckError } from "./model-check-error";
import { startModelCheckServer } from "./opencode-v2-server";
import { waitForNativeReply } from "./opencode-v2-client";

const MODEL_CHECK_TIMEOUT_MS = 120_000;

/** Verify native OpenCode V2 generation with the Arm Host's credentials. */
export async function verifySpawnModel(harness: string, provider?: string, model?: string): Promise<void> {
  if (!["opencode", "opencode-api", "opencode-tui"].includes(harness)) return;
  if (!provider || !model) throw new Error("Select a provider and model before spawning an Arm.");
  const directory = await mkdtemp(join(tmpdir(), "coleo-model-check-"));
  let server: Awaited<ReturnType<typeof startModelCheckServer>> | undefined;
  try {
    // Infrastructure failures must not be relabeled as provider-login failures.
    server = await startModelCheckServer(directory);
    const client = server.client;
    try {
      await withStartupTimeout(async signal => {
        const catalog = await client.model.list({ location: { directory } }, { signal });
        if (!catalog.data.some(entry => entry.providerID === provider && entry.id === model && entry.enabled)) {
          throw new Error(`Model "${provider}/${model}" is not enabled in this host's OpenCode catalog. Refresh the model list and select an enabled model.`);
        }
        const session = await client.session.create({ location: { directory }, title: "Coleo model access check",
          agent: "build", model: { providerID: provider, id: model },
          permissions: [{ action: "*", resource: "*", effect: "ask" }],
        }, { signal });
        try {
          await client.session.prompt({ sessionID: session.id,
            text: "Reply with exactly OK. Do not use any tools or inspect any files." }, { signal });
          const response = await waitForNativeReply(client, session.id, signal);
          if (!response.parts.some(part => part.type === "text" && part.text.trim())) {
            throw new Error("The selected model did not return a text response.");
          }
        } finally {
          await client.session.interrupt({ sessionID: session.id }, { signal: AbortSignal.timeout(2000) }).catch(() => {});
          await client.session.remove({ sessionID: session.id }, { signal: AbortSignal.timeout(2000) }).catch(() => {});
        }
      }, MODEL_CHECK_TIMEOUT_MS, "Model access check");
    } catch (error) {
      throw new ModelCheckError(provider, model, error instanceof Error ? error.message : "The provider rejected the model check.");
    }
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
