import { mkdir, readFile, writeFile, rename, open, unlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { getServiceStatus } from "../daemon";
import { VERSION } from "../version";
import { getCliEntrypoint } from "./entrypoint";
import { readOperatorConfig, saveOperatorConfig, resolveOperatorConfig, ensureAgentId } from "./operator-config";
import { checkCentralHealth } from "./ops-health";
import { discoverOpsWorkspace } from "./ops-workspace";
import { ask, choose, chooseMany, confirmAction } from "./ops-prompts";
import { prepareCheckoutWeb, shellQuote } from "./ops-web";
import { planLocalPorts, nextAvailablePort } from "./ops-ports";
import { instructionPanel, instructionCommands, setupStep } from "./ops-style";
import { reportHealthProgress } from "./ops-output";
import type { OpsHealth } from "./ops-health";

export { ask } from "./ops-prompts";

export type SetupClient = "cli" | "tui" | "web" | "macos";
export interface SetupInput {
  schemaVersion: 1;
  role: "local" | "client" | "agent";
  clients: SetupClient[];
  workspace: string;
  server?: string;
  connection: string;
  natsUrl?: string;
  provider?: string;
  model?: string;
}
export interface OpsOptions {
  dir?: string; role?: string; client?: string; clients?: string; workspace?: string; server?: string;
  connection?: string; natsUrl?: string; provider?: string; model?: string;
  config?: string; resume?: boolean; dryRun?: boolean; nonInteractive?: boolean;
  json?: boolean; timeout: number; prefix?: string; release?: string;
  wait?: boolean;
}
interface Journal {
  schemaVersion: 1; input: SetupInput; startedAt: string; steps: Record<string, "running" | "complete" | "failed">;
}
export interface SetupResult extends OpsHealth {
  nextCommands: string[];
  steps?: Journal["steps"];
  failedStep?: string;
  startedServices?: string[];
  runtime?: string;
  server?: string;
  clients?: SetupClient[];
  preview?: boolean;
}
export class SetupFailure extends Error {
  constructor(message: string, readonly result: SetupResult, readonly cancelled = false) {
    super(message);
  }
}
export function normalizeSetupClients(value: unknown): SetupClient[] {
  if (!Array.isArray(value) || value.some(client => !["cli", "tui", "web", "macos"].includes(client))) {
    throw new Error("Choose clients cli, tui, web, or macos; the CLI is required");
  }
  if (value.includes("macos") && process.platform !== "darwin") throw new Error("The Swift client requires macOS");
  return (["cli", "tui", "web", "macos"] as const).filter(client => client === "cli" || value.includes(client));
}
export function validateSetupInput(value: unknown): SetupInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Setup input must be an object");
  const data = value as Record<string, unknown>;
  const keys = ["schemaVersion", "role", "client", "clients", "workspace", "server", "connection", "natsUrl", "provider", "model"];
  if (Object.keys(data).some(key => !keys.includes(key))) throw new Error("Unknown setup field; credentials belong in environment variables, not setup JSON");
  if (data.schemaVersion !== 1 || !["local", "client", "agent"].includes(String(data.role))) throw new Error("Choose role local, client, or agent");
  // Migrate older journals/configs; even a previous "none" selection now includes CLI.
  const clients = normalizeSetupClients(data.clients ?? (data.client && data.client !== "none" ? [data.client] : []));
  for (const key of keys.filter(key => key !== "schemaVersion" && key !== "clients")) {
    if (data[key] !== undefined && (typeof data[key] !== "string" || /[\r\n\0]/.test(data[key] as string))) throw new Error(`Invalid ${key}`);
  }
  if (!data.workspace || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(String(data.connection))) throw new Error("Workspace and a valid connection name are required");
  for (const key of ["server", "natsUrl"]) {
    if (!data[key]) continue;
    const url = new URL(String(data[key]));
    if (!(key === "server" ? ["http:", "https:"] : ["nats:", "tls:", "ws:", "wss:"]).includes(url.protocol)
      || url.username || url.password || url.search || url.hash || (key === "server" && url.pathname !== "/")) throw new Error(`Invalid ${key}: use an origin without credentials`);
  }
  if (data.role !== "local" && !data.server) throw new Error("Remote roles require --server");
  if (data.role === "agent" && !data.natsUrl) throw new Error("Arm Host setup requires --nats-url");
  const { client: _legacyClient, ...rest } = data;
  return { ...rest, clients, workspace: resolve(String(data.workspace)) } as unknown as SetupInput;
}

export async function selectSetupClients(initial: SetupClient[], signal?: AbortSignal): Promise<SetupClient[]> {
  const selected = new Set(normalizeSetupClients(initial));
  const optional = [
    { id: "tui" as const, label: "Python/Textual terminal UI" },
    { id: "web" as const, label: "Web browser client" },
    ...(process.platform === "darwin" ? [{ id: "macos" as const, label: "Swift/macOS app" }] : []),
  ];
  return normalizeSetupClients(await chooseMany<SetupClient>("Clients to install", [
    { value: "cli", name: "CLI", checked: true, disabled: "required" },
    ...optional.map(client => ({ value: client.id, name: client.label, checked: selected.has(client.id) })),
  ], signal));
}
async function saveJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
export function opsDirectory(options: OpsOptions): string {
  return discoverOpsWorkspace(options).directory;
}
export async function runBounded(command: string[], signal: AbortSignal, input?: string,
  options: { allowFailure?: boolean; timeoutMs?: number } = {}): Promise<string> {
  signal.throwIfAborted();
  const child = Bun.spawn(command, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe", env: process.env });
  let forced: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { child.kill(); forced ??= setTimeout(() => child.kill("SIGKILL"), 5000); };
  signal.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, options.timeoutMs ?? 300_000);
  try {
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    signal.throwIfAborted();
    if (code !== 0 && !options.allowFailure) throw new Error(`${command[0]} failed (exit ${code}); inspect component logs`);
    return stdout;
  } finally { clearTimeout(timeout); clearTimeout(forced); signal.removeEventListener("abort", stop); }
}
export function executable(name: string, options: OpsOptions): string | undefined {
  // Only an explicit installation prefix outranks the user's PATH. In
  // particular, old ~/.local wrappers must not shadow bun-linked commands.
  const onPath = Bun.which(name, { PATH: process.env.PATH });
  if (options.prefix) {
    return Bun.which(join(options.prefix, "bin", name)) || onPath || undefined;
  }
  return onPath || Bun.which(join(homedir(), ".local", "bin", name)) || undefined;
}
async function installClient(client: SetupClient, options: OpsOptions, signal: AbortSignal): Promise<string | undefined> {
  const installer = executable("coleo-install", options);
  const command = client === "web" ? "coleo-web" : client === "macos" ? undefined : "coleo-client";
  if (client === "web" && process.env.COLEO_WEB_EXECUTABLE) {
    const configured = Bun.which(process.env.COLEO_WEB_EXECUTABLE);
    if (!configured) throw new Error("COLEO_WEB_EXECUTABLE is not executable");
    return configured;
  }
  if (command && executable(command, options) && client !== "tui") return client === "web" ? executable(command, options) : undefined;
  if (client === "tui" && executable("coleo-client", options)) {
    // The Python client owns capability detection. A uv/source installation has
    // no release-installer receipt, and API failure does not mean TUI is absent.
    try {
      const result = JSON.parse(await runBounded([executable("coleo-client", options)!, "doctor", "--json"], signal,
        undefined, { allowFailure: true, timeoutMs: 10_000 })) as {
          schemaVersion?: number; checks?: Array<{ name: string; available?: boolean }>;
        };
      if (result.schemaVersion === 1 && result.checks?.some(check => check.name === "tui" && check.available === true)) return;
    } catch { signal.throwIfAborted(); }
  }
  if (client === "tui" || client === "macos") {
    const receiptPath = join(options.prefix || join(homedir(), ".local"), "lib/coleo/current/receipt.json");
    try {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
        schemaVersion: number; packages: Record<string, { path: string; roles: string[] }>;
      };
      const installed = receipt.packages[client === "tui" ? "client" : "macos"];
      if (receipt.schemaVersion === 1 && installed?.roles.includes(client)
        && (client === "tui" ? executable("coleo-client", options)
          : await stat(join(installed.path, "ColeoInbox.app")).then(info => info.isDirectory()).catch(() => false))) return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot inspect installer receipt; repair the installation before setup"); }
  }
  if (!installer && client === "web") {
    const launcher = await prepareCheckoutWeb(opsDirectory(options), async root => {
      try { await runBounded([process.execPath, "run", "--cwd", root, "web:build"], signal); }
      catch { signal.throwIfAborted(); throw new Error(`Web build failed. Run bun run web:build in ${root} to see the build diagnostics, then resume.`); }
    });
    if (launcher) return launcher;
  }
  if (!installer) throw new Error(`The ${client === "cli" ? "CLI" : client} component could not be verified, and coleo-install is not on PATH. Install the component first, or rerun init and change the optional client selection.`);
  await runBounded([installer, "install", client === "cli" ? "client" : client,
    "--version", options.release || VERSION, ...(options.prefix ? ["--prefix", options.prefix] : [])], signal);
  return client === "web" ? executable("coleo-web", options) : undefined;
}
async function installOperators(input: SetupInput, options: OpsOptions, signal: AbortSignal): Promise<void> {
  if (input.role === "client") return;
  const installer = executable("coleo-install", options);
  if (!installer) return; // Source/npm distributions already contain operator entrypoints.
  for (const component of input.role === "local" ? ["server", "agent"] : ["agent"]) {
    if (executable(`coleo-${component}`, options)) continue;
    await runBounded([installer, "install", component, "--version", options.release || VERSION,
      ...(options.prefix ? ["--prefix", options.prefix] : [])], signal);
  }
}
export async function setup(options: OpsOptions, signal: AbortSignal): Promise<SetupResult> {
  const question = (label: string, fallback = "", hidden = false) => ask(label, fallback, hidden, signal);
  const interactive = !options.nonInteractive && process.stdin.isTTY && !options.json;
  if (!interactive && !options.nonInteractive && !options.dryRun) throw new Error("Use --non-interactive with complete inputs outside a terminal");
  let directory = opsDirectory(options);
  let journalPath = join(directory, "setup.json");
  let previous: Journal | undefined;
  try {
    previous = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
    if (previous.schemaVersion !== 1) throw new Error("Unsupported setup journal");
  } catch (error) {
    if (options.resume || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fromFile = options.config ? validateSetupInput(JSON.parse(await readFile(options.config, "utf8"))) : undefined;
  const selected: Partial<SetupInput> = fromFile ?? (previous ? validateSetupInput(previous.input) : {});
  const role = options.role || selected.role || (interactive ? await choose("What does this machine do?", [
    { value: "local", name: "Run everything here", description: "API, Brain, Arm Host, and clients on this machine" },
    { value: "client", name: "Connect to an existing server", description: "Use an existing Coleo workspace" },
    { value: "agent", name: "Add an Arm Host", description: "Run coding agents for an existing server" },
  ], "local", signal) : "local");
  if (options.client && options.clients) throw new Error("Use --clients, not both --client and --clients");
  const explicitClients = options.clients ?? options.client;
  const defaults = normalizeSetupClients(explicitClients !== undefined ? explicitClients.split(",").map(value => value.trim()) : selected.clients ?? []);
  const clients = interactive && explicitClients === undefined ? await selectSetupClients(defaults, signal) : defaults;
  const defaultWorkspace = discoverOpsWorkspace(options).workspace;
  const workspace = options.workspace || selected.workspace || (interactive && role !== "client" ? await question("Repository directory", defaultWorkspace) : defaultWorkspace);
  const server = options.server || selected.server || (interactive && role !== "local" ? await question("Server origin") : undefined);
  const natsUrl = options.natsUrl || selected.natsUrl || (interactive && role === "agent" ? await question("NATS URL") : undefined);
  const input = validateSetupInput({ ...selected, schemaVersion: 1, role, clients, workspace, server, natsUrl,
    connection: options.connection || selected.connection || "local", provider: options.provider || selected.provider,
    model: options.model || selected.model });
  if (!options.resume) {
    directory = opsDirectory({ ...options, workspace: input.workspace });
    journalPath = join(directory, "setup.json");
  }
  process.env.COLEO_DIR = directory;
  const resolved = await resolveOperatorConfig({}, {}, input.workspace);
  const localPorts = role === "local"
    ? await planLocalPorts(resolved, options.server || fromFile?.server, input.natsUrl) : {};
  if (localPorts.apiUrl) input.server = localPorts.apiUrl;
  input.server ||= resolved.values.apiUrl || `http://127.0.0.1:${resolved.values.port}`;
  if (role !== "client" && !(await stat(input.workspace)).isDirectory()) throw new Error("Workspace must be a directory");
  // The API and Brain resolve the repository independently of the ops process cwd.
  if (role !== "client") process.env.COLEO_PROJECT_DIR = input.workspace;
  if (interactive && role === "local") {
    input.provider ||= await question("Brain provider", "openai");
    input.model ||= await question("Brain model (blank keeps configured/default model)");
  }
  const nextCommands = [
    `coleo-ops --dir ${JSON.stringify(directory)} status`,
    `coleo-ops --dir ${JSON.stringify(directory)} init --resume`,
  ];
  if (options.dryRun) return { schemaVersion: 1, ok: true, checks: [{ name: "plan", status: "pass", checkedAt: null,
    detail: `${role}; clients=${clients.join(",")}; runtime=${directory}; workspace=${input.workspace}; API=${input.server}; NATS=${input.natsUrl || `nats://${localPorts.natsHost || resolved.values.natsHost}:${localPorts.natsPort || resolved.values.natsPort}`}; NATS monitor=${localPorts.natsHttpPort || resolved.values.natsHttpPort}` }], nextCommands, preview: true };
  let key = resolved.values.apiKey;
  if (role !== "local" && resolved.sources.apiKey === "saved"
    && resolved.values.apiUrl.replace(/\/$/, "") !== input.server.replace(/\/$/, "")) key = "";
  if (!key && role !== "local" && interactive) key = await question("API key", "", true);
  if (!key && role === "local") key = crypto.randomUUID() + crypto.randomUUID();
  if (!key) throw new Error("Set COLEO_API_KEY or run interactively");
  let token = resolved.values.natsToken;
  if (role === "agent" && !token && interactive) token = await question("NATS token (blank for no token)", "", true);
  let modelKey = process.env.COLEO_BRAIN_API_KEY || process.env.OPENAI_API_KEY;
  if (role === "local" && !modelKey && interactive) modelKey = await question("Brain API key (blank keeps configured credential)", "", true);
  if (interactive) {
    process.stderr.write(instructionPanel("Ready to set up Coleo", [
      `Role:       ${role}`, `Workspace:  ${input.workspace}`, `Runtime:    ${directory}`,
      "", `API:        ${input.server}`,
      ...(role === "local" ? [`NATS:       ${input.natsUrl || resolved.values.natsUrl.replace(/:\d+$/, `:${localPorts.natsPort || resolved.values.natsPort}`)}`,
        `Monitor:    ${localPorts.natsHttpPort || resolved.values.natsHttpPort}`] : []),
      `Clients:    ${clients.join(", ")} (CLI required)`, "",
      "Setup may download components and start API/Brain/host processes.",
      "Brain polling can call your model provider.", "",
      "Configuration details: coleo-ops config show --show-origin",
    ]) + "\n");
    if (!await confirmAction("Apply this setup?", true, signal)) throw new DOMException("Setup cancelled before apply", "AbortError");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "setup.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error(`Setup lock exists: ${lockPath}. Check for another setup process before removing a stale lock.`); });
  const journal: Journal = { schemaVersion: 1, input, startedAt: new Date().toISOString(), steps: {} };
  const step = async (name: string, action: () => Promise<void>) => {
    signal.throwIfAborted();
    journal.steps[name] = "running"; await saveJson(journalPath, journal);
    process.stderr.write(setupStep(name));
    try { await action(); journal.steps[name] = "complete"; }
    catch (error) { journal.steps[name] = "failed"; throw error; }
    finally { await saveJson(journalPath, journal); }
  };
  const operator = (component: "server" | "agent", args: string[]) => {
    const installed = executable(`coleo-${component}`, options);
    return runBounded([...(installed ? [installed] : [process.execPath, getCliEntrypoint(component)]),
      "--dir", directory, "--json", ...args], signal);
  };
  let health: OpsHealth = { schemaVersion: 1, ok: false, checks: [] };
  const startedServices: string[] = [];
  let webExecutable: string | undefined;
  try {
    await lock.writeFile(String(process.pid));
    await saveJson(journalPath, journal);
    await step("components", async () => {
      await installOperators(input, options, signal);
      for (const client of clients) {
        process.stderr.write(`  Checking ${client} client…\n`);
        const installed = await installClient(client, options, signal);
        if (client === "web") webExecutable = installed;
      }
    });
    if (role !== "client") {
      await step("runtime", async () => { await operator(role === "local" ? "server" : "agent", ["initialize"]); });
      await step("operator_configuration", async () => {
        const saved = await readOperatorConfig();
        await saveOperatorConfig({ ...saved, ...localPorts, apiKey: key, apiUrl: input.server, workspace: input.workspace,
          ...(role === "local" ? { port: new URL(input.server!).port || (new URL(input.server!).protocol === "https:" ? "443" : "80") } : {}),
          ...(role === "local" && resolved.sources.host === "default" ? { host: "127.0.0.1" } : {}),
          ...(input.natsUrl ? { natsUrl: input.natsUrl, natsToken: token } : {}) });
        const effective = await resolveOperatorConfig();
        for (const [field, expected, variable] of [
          ["apiUrl", input.server, "COLEO_API_URL"], ["workspace", input.workspace, "COLEO_AGENT_WORKDIR"],
          ["port", role === "local" ? new URL(input.server!).port || (new URL(input.server!).protocol === "https:" ? "443" : "80") : undefined, "COLEO_API_PORT"],
          ["natsUrl", input.natsUrl, "COLEO_NATS_URL"],
        ] as const) {
          if (expected && effective.values[field] !== expected) throw new Error(`${variable} overrides the requested setup setting; resolve the override and resume`);
        }
        await ensureAgentId(effective);
      });
    }
    // Remote connection metadata belongs to ops; credentials stay in environment/client stores.
    await step("connection", async () => {
      await saveJson(join(directory, "target.json"), { schemaVersion: 1, server: input.server, role, clients, connection: input.connection, webExecutable });
    });
    if (role === "local") {
      await step("api", async () => {
        if (!(await getServiceStatus("server")).running) { await operator("server", ["start"]); startedServices.push("API"); }
      });
      await step("api_identity", async () => {
        const response = await fetch(new URL("/api/status", input.server), { headers: { "X-API-Key": key },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error(`API authentication failed (HTTP ${response.status})`);
        const status = await response.json() as { cwd?: string };
        if (status.cwd !== input.workspace) throw new Error("The API serves another workspace. Select its runtime directory or stop it before applying this setup.");
        if (!resolved.values.apiKey) {
          const rejected = await fetch(new URL("/api/status", input.server), { headers: { "X-API-Key": crypto.randomUUID() },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
          if (rejected.status !== 401 && rejected.status !== 403) throw new Error("New local API did not reject an incorrect credential");
        }
      });
      await step("brain_configuration", async () => {
        const updates = { ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}), ...(modelKey ? { apiKey: modelKey } : {}) };
        if (Object.keys(updates).length) {
          const response = await fetch(new URL("/api/config/brain", input.server), { method: "PATCH", headers: { "X-API-Key": key, "Content-Type": "application/json" },
            body: JSON.stringify(updates), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
          if (!response.ok) throw new Error(`Brain configuration failed (HTTP ${response.status})`);
        }
      });
      await step("brain", async () => {
        if (!(await getServiceStatus("brain")).running) { await operator("server", ["brain", "start"]); startedServices.push("Brain"); }
      });
    }
    if (role !== "client") await step("host", async () => {
      if (!Bun.which("opencode")) throw new Error("Install and configure OpenCode on this Arm Host, then resume");
      if (!(await getServiceStatus("agent")).running) { await operator("agent", ["start"]); startedServices.push("Arm Host"); }
    });
    await step("client_connection", async () => {
      const cli = executable("coleo-client", options);
      if (!cli) throw new Error("coleo-client is missing");
      const saved = JSON.parse(await runBounded([cli, "connections", "--json"], signal)) as { connections?: Array<{ name: string; server: string }> };
      const existing = saved.connections?.find(connection => connection.name === input.connection);
      if (existing && existing.server.replace(/\/$/, "") !== input.server!.replace(/\/$/, "")) {
        throw new Error(`Connection ${input.connection} points at another server; choose --connection with a new name`);
      }
      await runBounded([cli, "connect", input.server!, "--name", input.connection, "--key-stdin"], signal, key + "\n");
    });
    for (const client of clients.filter(client => client === "web" || client === "macos")) await step(`${client}_handoff`, async () => {
      const webPort = client === "web" ? await nextAvailablePort(3000, "127.0.0.1") : 3000;
      process.stderr.write(instructionPanel(client === "web" ? "Connect your web client" : "Connect Coleo Workbench", [
        ...(client === "web" ? ["1. Run the command below in another terminal.",
          `2. Open http://127.0.0.1:${webPort} and load the workspace.`]
          : [`Open Coleo Workbench and add ${input.server} in Connections.`, "Enter the API key and load the workspace."]),
        ...(role === "local" ? ["", "API key location:", join(directory, "operator.json"), "Field: values.apiKey — copy it into your selected client."] : []),
        "", "Return here to confirm when the workspace has loaded.",
      ]) + "\n");
      if (client === "web") process.stderr.write(instructionCommands("Run in another terminal:", [
        `${webExecutable ? `COLEO_WEB_EXECUTABLE=${shellQuote(webExecutable)} ` : ""}coleo-client --connection ${shellQuote(input.connection)} web --port ${webPort}`,
      ]));
      if (!interactive || !await confirmAction(`Have you connected and loaded the workspace in the ${client} client?`, false, signal)) {
        throw new Error(`${client} handoff pending. Complete its connection, then resume interactively.`);
      }
    });
    await step("central_readiness", async () => {
      health = await checkCentralHealth({ url: input.server!, key, wait: true, timeout: options.timeout,
        since: journal.startedAt, agentId: role === "client" ? undefined : (await resolveOperatorConfig()).values.id,
        signal, progress: options.json ? undefined : reportHealthProgress });
      if (!health.ok) throw new Error("Central readiness incomplete; inspect coleo-ops doctor --wait and resume setup");
    });
    return { ...health, nextCommands: [nextCommands[0]!], runtime: directory, server: input.server, clients, startedServices };
  } catch (error) {
    const failedStep = Object.keys(journal.steps).find(name => journal.steps[name] === "failed" || journal.steps[name] === "running");
    const next = [nextCommands[1]!];
    if (["api", "brain", "host", "central_readiness"].some(name => name in journal.steps)) {
      next.unshift(`coleo-ops --dir ${JSON.stringify(directory)} doctor --wait`);
    }
    throw new SetupFailure(error instanceof Error ? error.message : "Setup failed", {
      ...health, ok: false, nextCommands: next, steps: journal.steps, failedStep, startedServices, runtime: directory,
    },
      signal.aborted || error instanceof Error && error.name === "AbortError");
  } finally { await lock.close(); await unlink(lockPath); }
}
export function reportHealth(result: OpsHealth): void {
  for (const check of result.checks) process.stderr.write(`${check.status.padEnd(7)} ${check.name}: ${check.detail}\n`);
}
