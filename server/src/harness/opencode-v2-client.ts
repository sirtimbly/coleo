import { OpenCode } from "@opencode/client";
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";
import type { HarnessPromptPart } from "./prompt-parts";

export function openCodeHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const password = env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD;
  return password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {};
}

export interface Message {
  id: string;
  sessionID: string;
  role: string;
  time: { created: number; completed?: number };
  error?: { message: string };
}
export type Part = { type: "text"; text: string } | { type: "reasoning"; text: string }
  | { type: "tool"; tool: string; state: unknown };
export interface NormalizedMessage { info: Message; parts: Part[] }
interface SessionRequest { path: { id: string }; signal?: AbortSignal }
interface PromptRequest extends SessionRequest {
  body: { parts: HarnessPromptPart[]; noReply?: boolean; model?: { providerID: string; modelID: string } };
}
const result = <T>(data: T): { data: T; error?: never } => ({ data });

/** Preserve Coleo's message envelope at its boundary, using only native V2 HTTP calls. */
export function normalizeOpenCodeMessage(message: SessionMessageInfo, sessionID: string): NormalizedMessage {
  const parts: Part[] = [];
  if (message.type === "assistant") {
    for (const content of message.content) {
      if (content.type === "text" || content.type === "reasoning") parts.push({ type: content.type, text: content.text });
      else if (content.type === "tool") parts.push({ type: "tool", tool: content.name, state: content.state });
    }
  } else if (message.type === "user") parts.push({ type: "text", text: message.text });
  return { info: { id: message.id, sessionID, role: message.type,
    time: { created: message.time.created, ...("completed" in message.time ? { completed: message.time.completed } : {}) },
    ...(message.type === "assistant" && message.error ? { error: { message: message.error.message } } : {}),
  }, parts };
}

export async function waitForNativeReply(client: OpenCodeClient, sessionID: string, signal: AbortSignal): Promise<NormalizedMessage> {
  await client.experimental.session.wait({ sessionID }, { signal });
  const messages = await client.message.list({ sessionID, type: "assistant", order: "desc", limit: 1 }, { signal });
  const message = messages.data[0];
  if (!message) throw new Error("The selected model did not return an assistant response.");
  const normalized = normalizeOpenCodeMessage(message, sessionID);
  if (normalized.info.error) throw new Error(normalized.info.error.message);
  return normalized;
}

export function createOpencodeClient(options: { baseUrl: string; directory?: string; headers?: Record<string, string> }) {
  const client = OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers ?? openCodeHeaders() });
  const submit = async ({ path, body, signal }: PromptRequest) => {
    if (body.model) await client.session.switchModel({ sessionID: path.id,
      model: { providerID: body.model.providerID, id: body.model.modelID } }, { signal });
    await client.session.prompt({ sessionID: path.id,
      text: body.parts.filter(part => part.type === "text").map(part => part.text).join("\n"),
      files: body.parts.filter(part => part.type === "file").map(part => ({ uri: part.url, name: part.filename })),
    }, { signal });
    return result(true);
  };
  return {
    native: client,
    session: {
      list: async (options: { signal?: AbortSignal } = {}) => {
        const response = await client.session.list({}, options);
        return result(response.data);
      },
      create: async (request: { body: { title: string }; signal?: AbortSignal }) => result(await client.session.create({
        title: request.body.title, location: { directory: options.directory || process.cwd() },
      }, { signal: request.signal })),
      delete: async ({ path, signal }: SessionRequest) => result(await client.session.remove({ sessionID: path.id }, { signal })),
      promptAsync: submit,
      prompt: async (request: PromptRequest) => {
        await submit(request);
        return result(await waitForNativeReply(client, request.path.id, request.signal || AbortSignal.timeout(300_000)));
      },
      messages: async ({ path, signal }: SessionRequest) => {
        const response = await client.message.list({ sessionID: path.id, order: "desc", limit: 100 }, { signal });
        return result(response.data.toReversed().map(message => normalizeOpenCodeMessage(message, path.id)));
      },
      // OpenCode V2 has no legacy todo HTTP resource. Tools can still publish task updates through MCP.
      todo: async (_request: SessionRequest) => result([] as unknown[]),
      status: async (_request: object = {}) => {
        const active = await client.session.active();
        return result(Object.fromEntries(Object.keys(active).map(id => [id, { type: "busy" }])));
      },
      abort: async ({ path, signal }: SessionRequest) => result(await client.session.interrupt({ sessionID: path.id }, { signal })),
      command: async ({ path, body }: SessionRequest & { body: { command: string; arguments: string } }) => {
        if (body.command === "compact") return result(await client.session.compact({ sessionID: path.id }));
        return result(await client.session.command({ sessionID: path.id, name: body.command, text: body.arguments }));
      },
    },
    postSessionIdPermissionsPermissionId: async (request: {
      path: { id: string; permissionID: string }; body: { response: "once" | "always" | "reject" }; query?: object;
    }) => result(await client.permission.reply({ sessionID: request.path.id,
      requestID: request.path.permissionID, decision: request.body.response })),
  };
}
export type OpencodeClient = ReturnType<typeof createOpencodeClient>;
