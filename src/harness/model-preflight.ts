import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStartupTimeout } from "./opencode-startup";
import { ModelCheckError } from "./model-check-error";

const MODEL_CHECK_TIMEOUT_MS = 120_000;

/** Verify native OpenCode generation with the Arm Host's credentials. */
export async function verifySpawnModel(harness: string, provider?: string, model?: string): Promise<void> {
  if (!["opencode", "opencode-api", "opencode-tui"].includes(harness)) return;
  if (!provider || !model) throw new Error("Select a provider and model before spawning an Arm.");
  const directory = await mkdtemp(join(tmpdir(), "coleo-model-check-"));
  let server: Awaited<ReturnType<typeof createOpencodeServer>> | undefined;
  try {
    await withStartupTimeout(async (signal) => {
      server = await createOpencodeServer({
        hostname: "127.0.0.1",
        port: 0,
        signal,
        timeout: 30_000,
        config: {
          model: `${provider}/${model}`,
          // Keep OpenCode's native agent and tool schemas: a custom tool-less
          // agent is rejected by Zen's free tier even when normal generation works.
          // The temporary session never approves tools and has no Coleo MCP access.
          mcp: { coleo: { type: "local", command: ["false"], enabled: false } },
          permission: "ask",
        },
      });
      const client = createOpencodeClient({ baseUrl: server.url });
      const catalog = await client.provider.list({ directory }, { signal, throwOnError: true });
      const selectedProvider = catalog.data?.all.find((entry) => entry.id === provider);
      if (!selectedProvider) {
        const alternatives = catalog.data?.all
          .filter((entry) => catalog.data?.connected.includes(entry.id) && Object.hasOwn(entry.models, model))
          .map((entry) => `${entry.id}/${model}`) ?? [];
        throw new Error(`Provider "${provider}" is not available in this host's current OpenCode catalog. Refresh the provider list and select a current provider.${alternatives.length ? ` Available selections for this model: ${alternatives.join(", ")}.` : ""}`);
      }
      if (!Object.hasOwn(selectedProvider.models, model)) {
        throw new Error(`Model "${model}" is not available for provider "${provider}" in this host's current OpenCode catalog. Refresh the model list and select a current model.`);
      }
      const session = await client.session.create({
        directory,
        title: "Coleo model access check",
        permission: [{ permission: "*", pattern: "*", action: "ask" }],
      }, { signal, throwOnError: true });
      if (!session.data?.id) throw new Error("Model check could not create a temporary session.");
      try {
        const response = await client.session.prompt({
          sessionID: session.data.id,
          directory,
          model: { providerID: provider, modelID: model },
          agent: "build",
          parts: [{ type: "text", text: "Reply with exactly OK. Do not use any tools or inspect any files." }],
        }, { signal, throwOnError: true });
        // Provider rejections can be returned in a successful HTTP response.
        const failure = response.data?.info.error;
        if (failure) {
          const detail = "data" in failure && "message" in failure.data ? failure.data.message : failure.name;
          throw new Error(String(detail));
        }
        if (!response.data?.parts.some((part) => part.type === "text" && part.text.trim())) {
          throw new Error("The selected model did not return a text response.");
        }
      } finally {
        const parameters = { sessionID: session.data.id, directory };
        await client.session.abort(parameters, { signal: AbortSignal.timeout(2000) }).catch(() => {});
        await client.session.delete(parameters, { signal: AbortSignal.timeout(2000) }).catch(() => {});
      }
    }, MODEL_CHECK_TIMEOUT_MS, "Model access check");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The provider rejected the model check.";
    throw new ModelCheckError(provider, model, detail);
  } finally {
    server?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
