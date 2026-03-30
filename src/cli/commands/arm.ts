import { Command } from "commander";
import { join } from "path";
import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import { spawnArm, killArm } from "../../arm";
import { generateArmName, generateArmNames, getNameGeneratorStats } from "../arm-names";
import {
  expandPath,
  getApiConfig,
  getColeoDir,
  getSubcommandArgs,
  isApiRunning,
} from "../context";
import { prompt, promptSelect, promptYN, loadArmTemplates } from "../helpers/prompts";

function normalizeTemplateName(value: string): string {
  return value.trim().replace(/\.toml$/i, "");
}

type ArmDisplayState = "Idle" | "Busy" | "Stuck";
const TERMINAL_WIDTH_SAFETY = 2;
const WATCH_MESSAGE_TRUNCATE_LENGTH = 500;
const WATCH_AUX_FETCH_TIMEOUT_MS = 5000;
const WATCH_MESSAGES_FETCH_TIMEOUT_MS = 12000;

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function displayWidth(value: string): number {
  return Array.from(value).length;
}

function truncateToWidth(value: string, max: number): string {
  if (max <= 0) return "";
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  if (max <= 1) return chars.slice(0, max).join("");
  return `${chars.slice(0, max - 1).join("")}…`;
}

function padToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  const len = displayWidth(value);
  if (len >= width) return truncateToWidth(value, width);
  return value + " ".repeat(width - len);
}

function fitToWidth(value: string, columns: number): string {
  const safeColumns = Math.max(0, columns - TERMINAL_WIDTH_SAFETY);
  if (safeColumns <= 0) return "";
  const plain = stripAnsi(value);
  if (displayWidth(plain) <= safeColumns) return value;
  return truncateToWidth(plain, safeColumns);
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return "n/a";
  const safeMs = Math.max(0, durationMs);
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

function formatAgeFromSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "n/a";
  return formatDuration(seconds * 1000);
}

function classifyArmDisplayState(armStatus: string, monitorState?: string): ArmDisplayState {
  const status = armStatus.toLowerCase();
  const hm = (monitorState || "").toLowerCase();

  if (
    status === "error" ||
    hm === "hung" ||
    hm === "recoverable" ||
    hm === "stopped" ||
    hm === "looping" ||
    hm === "silent" ||
    hm === "error" ||
    hm === "unknown"
  ) {
    return "Stuck";
  }

  if (
    status === "busy" ||
    status === "running" ||
    status === "starting" ||
    hm === "active" ||
    hm === "busy" ||
    hm === "productive" ||
    hm === "waiting_permission" ||
    hm === "starting"
  ) {
    return "Busy";
  }

  return "Idle";
}

function formatStatusIndicator(state: ArmDisplayState, color: boolean): string {
  const text = `● ${state}`;
  if (!color) return text;

  if (state === "Idle") return `\u001b[32m${text}\u001b[0m`;
  if (state === "Busy") return `\u001b[33m${text}\u001b[0m`;
  return `\u001b[31m${text}\u001b[0m`;
}

type RowInput = {
  name: string;
  lifetime: string;
  health: string;
  task: string;
  statusIndicator: string;
};

export function buildAlignedArmLines(rows: RowInput[], columns: number): string[] {
  const safeColumns = Math.max(20, columns - TERMINAL_WIDTH_SAFETY);
  const statusWidth = Math.max(...rows.map((row) => displayWidth(stripAnsi(row.statusIndicator))), 0);
  const columnGapCount = 4;

  let nameWidth = Math.min(
    28,
    Math.max(10, ...rows.map((row) => displayWidth(row.name)))
  );
  let lifetimeWidth = Math.min(
    10,
    Math.max(4, ...rows.map((row) => displayWidth(row.lifetime)))
  );
  let healthWidth = Math.min(
    20,
    Math.max(8, ...rows.map((row) => displayWidth(row.health)))
  );

  const minTaskWidth = 6;
  let taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + columnGapCount);

  while (taskWidth < minTaskWidth && nameWidth > 10) {
    nameWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + columnGapCount);
  }
  while (taskWidth < minTaskWidth && healthWidth > 8) {
    healthWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + columnGapCount);
  }
  while (taskWidth < minTaskWidth && lifetimeWidth > 4) {
    lifetimeWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + columnGapCount);
  }
  while (taskWidth < minTaskWidth && nameWidth > 6) {
    nameWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + columnGapCount);
  }
  while (taskWidth < minTaskWidth && healthWidth > 4) {
    healthWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + columnGapCount);
  }
  while (taskWidth < minTaskWidth && lifetimeWidth > 3) {
    lifetimeWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + columnGapCount);
  }

  nameWidth = Math.max(6, nameWidth);
  lifetimeWidth = Math.max(3, lifetimeWidth);
  healthWidth = Math.max(4, healthWidth);

  taskWidth = Math.max(0, taskWidth);

  return rows.map((row) => {
    const nameCell = padToWidth(truncateToWidth(row.name, nameWidth), nameWidth);
    const lifetimeCell = padToWidth(truncateToWidth(row.lifetime, lifetimeWidth), lifetimeWidth);
    const healthCell = padToWidth(truncateToWidth(row.health, healthWidth), healthWidth);
    const taskCell = padToWidth(truncateToWidth(row.task, taskWidth), taskWidth);
    return `${nameCell} ${lifetimeCell} ${healthCell} ${taskCell} ${row.statusIndicator}`;
  });
}

function renderLines(lines: string[], previousLineCount: number): number {
  if (!process.stdout.isTTY) {
    for (const line of lines) {
      console.log(stripAnsi(line));
    }
    return lines.length;
  }

  if (previousLineCount > 0) {
    moveCursor(process.stdout, 0, -previousLineCount);
  }

  const totalLines = Math.max(lines.length, previousLineCount);
  for (let i = 0; i < totalLines; i++) {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(fitToWidth(lines[i] ?? "", process.stdout.columns ?? 120));
    process.stdout.write("\n");
  }

  return lines.length;
}

function enterFullscreenTui(): void {
  if (!process.stdout.isTTY) {
    return;
  }

  process.stdout.write("\u001b[?1049h");
  process.stdout.write("\u001b[?25l");
  process.stdout.write("\u001b[2J\u001b[H");
}

function exitFullscreenTui(): void {
  if (!process.stdout.isTTY) {
    return;
  }

  process.stdout.write("\u001b[?25h");
  process.stdout.write("\u001b[?1049l");
}

function renderFullscreenLines(lines: string[]): void {
  if (!process.stdout.isTTY) {
    for (const line of lines) {
      console.log(stripAnsi(line));
    }
    return;
  }

  const columns = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? Math.max(lines.length, 1);
  const visibleLines = lines.slice(0, rows);

  process.stdout.write("\u001b[2J\u001b[H");
  for (let i = 0; i < rows; i++) {
    const line = visibleLines[i] ?? "";
    process.stdout.write(fitToWidth(line, columns));
    if (i < rows - 1) {
      process.stdout.write("\n");
    }
  }
}

function createWatchTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

export interface WatchMessagePart {
  type: string;
  text?: string;
  tool?: string;
  toolName?: string;
  name?: string;
  state?: unknown;
}

function getWatchMessageDate(timeValue: unknown): Date | null {
  if (timeValue === undefined || timeValue === null) {
    return null;
  }

  let raw: unknown = timeValue;
  if (typeof timeValue === "object") {
    const timeObj = timeValue as Record<string, unknown>;
    raw =
      timeObj.completed ??
      timeObj.created ??
      timeObj.updated ??
      timeObj.end ??
      timeObj.start;
  }

  let date: Date | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
    date = new Date(ms);
  } else if (typeof raw === "string") {
    if (/^\d+$/.test(raw)) {
      const parsed = Number.parseInt(raw, 10);
      const ms = parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
      date = new Date(ms);
    } else {
      date = new Date(raw);
    }
  }

  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

export function formatWatchMessageTimestamp(
  timeValue: unknown,
  options?: { locale?: string; timeZone?: string },
): string | null {
  if (timeValue === undefined || timeValue === null) {
    return null;
  }

  let raw: unknown = timeValue;
  if (typeof timeValue === "object") {
    const timeObj = timeValue as Record<string, unknown>;
    raw =
      timeObj.completed ??
      timeObj.created ??
      timeObj.updated ??
      timeObj.end ??
      timeObj.start;
  }

  const date = getWatchMessageDate(raw);
  if (!date) {
    return null;
  }

  return date.toLocaleString(options?.locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: options?.timeZone,
  });
}

function getWatchToolStatus(state: unknown): string | undefined {
  if (typeof state === "string" && state.trim()) {
    return state.trim();
  }

  if (state && typeof state === "object") {
    const status = (state as { status?: unknown }).status;
    if (typeof status === "string" && status.trim()) {
      return status.trim();
    }
  }

  return undefined;
}

export function getRenderableWatchMessageLines(
  parts: WatchMessagePart[],
  options?: { tools?: boolean; truncateMessages?: boolean },
): string[] {
  const showTools = options?.tools !== false;
  const truncateMessages = options?.truncateMessages !== false;
  const lines: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      lines.push(
        truncateMessages && part.text.length > WATCH_MESSAGE_TRUNCATE_LENGTH
          ? `${part.text.slice(0, WATCH_MESSAGE_TRUNCATE_LENGTH)}\n... (truncated, press x in watch to show full text)`
          : part.text,
      );
      continue;
    }

    if (
      showTools &&
      (part.type === "tool-invocation" || part.type === "tool")
    ) {
      const toolName = part.toolName || part.tool || part.name;
      if (!toolName) {
        continue;
      }

      const status = getWatchToolStatus(part.state);
      lines.push(`🔧 Tool: ${toolName}${status ? ` [${status}]` : ""}`);
    }
  }

  return lines;
}

interface WatchMessage {
  info: { role: string; id: string; time?: unknown };
  parts: WatchMessagePart[];
}

interface WatchArmStatusPayload {
  arm: {
    id: string;
    name: string;
    status: string;
    harness?: string;
    provider?: string | null;
    model?: string | null;
    sessionId?: string | null;
    currentTaskSubject?: string | null;
    currentBugTitle?: string | null;
    runtime?: {
      state: string;
      reason: string;
      secondsSinceOutput: number | null;
      secondsSinceActivity: number | null;
      secondsSinceHeartbeat: number | null;
    };
  };
}

interface WatchArmListEntry {
  id: string;
  name: string;
  status: string;
  currentTaskSubject?: string | null;
  runtime?: {
    state?: string | null;
    secondsSinceOutput?: number | null;
  };
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface WatchStuckRequest {
  id: number;
  reason?: string | null;
  requestedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

function getWatchArmDisplayName(arm: WatchArmListEntry): string {
  if (arm.name && arm.name !== arm.id) {
    return `${arm.name} (${arm.id})`;
  }
  return arm.name || arm.id;
}

export function formatWatchArmSelectionOption(
  arm: WatchArmListEntry,
  options?: { color?: boolean; columns?: number },
): string {
  const runtimeState = arm.runtime?.state || "unknown";
  const displayState = classifyArmDisplayState(arm.status, runtimeState);
  const statusIndicator = formatStatusIndicator(displayState, options?.color === true);
  const taskText = arm.currentTaskSubject || "no current task";

  return fitToWidth(
    `${getWatchArmDisplayName(arm)} | ${statusIndicator} | ${runtimeState} | ${taskText}`,
    options?.columns ?? 120,
  );
}

export async function resolveWatchArmName(
  name: string | undefined,
  options?: {
    apiUrl?: string;
    headers?: Record<string, string>;
    fetchImpl?: FetchLike;
    interactive?: boolean;
    color?: boolean;
    columns?: number;
    selectPrompt?: (text: string, values: string[]) => Promise<string>;
  },
): Promise<string> {
  const trimmedName = name?.trim();
  if (trimmedName) {
    return trimmedName;
  }

  const { apiUrl, headers } = options?.apiUrl && options?.headers
    ? { apiUrl: options.apiUrl, headers: options.headers }
    : getApiConfig();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(`${apiUrl}/api/arms`, { headers });
  if (!response.ok) {
    throw new Error("Failed to fetch active arms from API.");
  }

  const payload = await response.json() as { arms?: WatchArmListEntry[] };
  const arms = payload.arms || [];
  if (arms.length === 0) {
    throw new Error("No active arms to watch.");
  }

  if (options?.interactive === false) {
    if (arms.length === 1) {
      return arms[0]?.name || arms[0]?.id || "";
    }
    throw new Error("Multiple active arms found. Pass a name or run from a TTY to choose one.");
  }

  const labels = arms.map((arm) =>
    formatWatchArmSelectionOption(arm, {
      color: options?.color,
      columns: options?.columns,
    }),
  );
  const selectPromptFn = options?.selectPrompt ?? promptSelect;
  const selected = await selectPromptFn("Select an active arm to watch:", labels);
  const selectedIndex = labels.indexOf(selected);
  const selectedArm = selectedIndex >= 0 ? arms[selectedIndex] : arms[0];

  if (!selectedArm) {
    throw new Error("No active arms to watch.");
  }

  return selectedArm.name || selectedArm.id;
}

function formatWatchMessageBlock(
  msg: WatchMessage,
  options?: { tools?: boolean; system?: boolean; truncateMessages?: boolean },
): string[] {
  if (msg.info.role === "system" && options?.system === false) {
    return [];
  }

  const lines = getRenderableWatchMessageLines(msg.parts, {
    tools: options?.tools,
    truncateMessages: options?.truncateMessages,
  });
  if (lines.length === 0) {
    return [];
  }

  const roleLabel =
    msg.info.role === "assistant"
      ? "Assistant"
      : msg.info.role === "user"
        ? "User"
        : msg.info.role === "system"
          ? "System"
          : msg.info.role;
  const timestamp = formatWatchMessageTimestamp(msg.info.time);

  return [
    "─".repeat(60),
    timestamp ? `${roleLabel}  ${timestamp}` : roleLabel,
    "",
    ...lines,
    "",
  ];
}

function summarizeWatchActivity(
  messages: WatchMessage[],
  options?: { tools?: boolean; system?: boolean },
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) {
      continue;
    }
    const lines = getRenderableWatchMessageLines(msg.parts, {
      tools: options?.tools,
    });
    if (msg.info.role === "system" && options?.system === false) {
      continue;
    }
    if (lines.length === 0) {
      continue;
    }

    const preview = truncateToWidth(lines[0] || "", 70);
    const timestamp = formatWatchMessageTimestamp(msg.info.time);
    const role =
      msg.info.role === "assistant"
        ? "assistant"
        : msg.info.role === "user"
          ? "user"
          : msg.info.role;
    return `${role}${timestamp ? ` @ ${timestamp}` : ""} · ${preview}`;
  }

  return "No renderable activity yet";
}

function getLatestWatchMessageAgeSeconds(messages: WatchMessage[]): number | null {
  let latestTimeMs: number | null = null;

  for (const msg of messages) {
    const date = getWatchMessageDate(msg.info.time);
    if (!date) {
      continue;
    }
    const timeMs = date.getTime();
    if (latestTimeMs === null || timeMs > latestTimeMs) {
      latestTimeMs = timeMs;
    }
  }

  if (latestTimeMs === null) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - latestTimeMs) / 1000));
}

function getFreshestAgeSeconds(...values: Array<number | null | undefined>): number | null {
  const numericValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numericValues.length === 0) {
    return null;
  }
  return Math.min(...numericValues);
}

export function getWatchActivityAgeSeconds(input: {
  arm: WatchArmStatusPayload["arm"] | null;
  messages: WatchMessage[];
}): number | null {
  return getFreshestAgeSeconds(
    input.arm?.runtime?.secondsSinceActivity,
    input.arm?.runtime?.secondsSinceOutput,
    getLatestWatchMessageAgeSeconds(input.messages),
  );
}

export function settleWatchRefreshNotice(
  notice: string | null,
  options?: { succeeded?: boolean },
): string | null {
  if (
    notice !== "Refreshing..." &&
    !(typeof notice === "string" && notice.startsWith("Reloading messages with "))
  ) {
    return notice;
  }

  if (options?.succeeded === false) {
    return null;
  }

  return null;
}

export function getWatchFocusLine(input: {
  arm: WatchArmStatusPayload["arm"] | null;
  messages: WatchMessage[];
  showTools: boolean;
  showSystem: boolean;
}): string {
  const task = input.arm?.currentTaskSubject?.trim();
  const bug = input.arm?.currentBugTitle?.trim();
  if (task || bug) {
    return `Task ${task || "none"} | Bug ${bug || "none"}`;
  }

  const recent = summarizeWatchActivity(input.messages, {
    tools: input.showTools,
    system: input.showSystem,
  });
  if (recent !== "No renderable activity yet") {
    return `Focus inferred from recent activity | ${recent}`;
  }

  return "Task not yet recorded | Bug not yet recorded";
}

function buildWatchTuiLines(input: {
  name: string;
  arm: WatchArmStatusPayload["arm"] | null;
  stuckRequest: WatchStuckRequest | null;
  messages: WatchMessage[];
  showTools: boolean;
  showSystem: boolean;
  truncateMessages: boolean;
  interruptNext: boolean;
  composing: boolean;
  draft: string;
  notice: string | null;
  error: string | null;
  columns: number;
  rows: number;
}): string[] {
  const arm = input.arm;
  const runtime = arm?.runtime;
  const freshestActivitySeconds = getWatchActivityAgeSeconds({
    arm,
    messages: input.messages,
  });
  const topLines = [
    fitToWidth(
      `Arm ${input.name} | db ${arm?.status || "unknown"} | runtime ${runtime?.state || "unknown"} | last output ${formatAgeFromSeconds(runtime?.secondsSinceOutput)}`,
      input.columns,
    ),
    fitToWidth(
      getWatchFocusLine({
        arm,
        messages: input.messages,
        showTools: input.showTools,
        showSystem: input.showSystem,
      }),
      input.columns,
    ),
    fitToWidth(
      `Recent ${summarizeWatchActivity(input.messages, { tools: input.showTools, system: input.showSystem })}`,
      input.columns,
    ),
    fitToWidth(
      input.stuckRequest
        ? `Stuck requested ${formatWatchMessageTimestamp(input.stuckRequest.updatedAt) || input.stuckRequest.updatedAt}${input.stuckRequest.reason ? ` · ${truncateToWidth(input.stuckRequest.reason, 60)}` : ""}`
        : `Session ${arm?.sessionId || "n/a"} | heartbeat ${formatAgeFromSeconds(runtime?.secondsSinceHeartbeat)} | activity ${formatAgeFromSeconds(freshestActivitySeconds)}`,
      input.columns,
    ),
    "═".repeat(Math.max(20, (input.columns || 80) - TERMINAL_WIDTH_SAFETY)),
  ];

  const messageLines = input.messages.flatMap((msg) =>
    formatWatchMessageBlock(msg, {
      tools: input.showTools,
      system: input.showSystem,
      truncateMessages: input.truncateMessages,
    }),
  );

  const bottomLines = input.composing
    ? [
        "═".repeat(Math.max(20, (input.columns || 80) - TERMINAL_WIDTH_SAFETY)),
        fitToWidth(
          `Message> ${input.draft || ""}`,
          input.columns,
        ),
        fitToWidth(
          `Enter send | Esc cancel | i toggle interrupt (${input.interruptNext ? "on" : "off"}) | x toggle messages | q quit`,
          input.columns,
        ),
      ]
    : [
        "═".repeat(Math.max(20, (input.columns || 80) - TERMINAL_WIDTH_SAFETY)),
        fitToWidth(
          input.notice || input.error || "m message | i toggle interrupt | x toggle messages | s mark stuck | r refresh | q quit",
          input.columns,
        ),
        fitToWidth(
          `Interrupt before send: ${input.interruptNext ? "on" : "off"} | Message bodies: ${input.truncateMessages ? "truncated" : "full"}`,
          input.columns,
        ),
      ];

  const availableBodyRows = Math.max(
    5,
    (input.rows || 30) - topLines.length - bottomLines.length,
  );
  const visibleBody = messageLines.slice(-availableBodyRows);

  return [...topLines, ...visibleBody, ...bottomLines];
}

export function registerArmCommands(program: Command): void {

  const armCmd = program.command("arm").description("Spawn, inspect, and control arms");

  armCmd
    .command("spawn")
    .description("Spawn a new arm (interactive if no arguments provided)")
    .option("-n, --name <name>", "Arm name/ID (auto-generates a sci-fi name if not provided)")
    .option("-w, --workdir <path>", "Working directory", process.cwd())
    .option(
      "-t, --terminal <terminal>",
      "Terminal emulator (ghostty, iterm2, terminal, tmux). If not specified, uses headless API server.",
    )
    .option("-p, --prompt <prompt>", "Initial prompt/task for the agent")
    .option(
      "--harness <harness>",
      "Harness type (opencode-api, opencode-tui, opencode). Default: opencode-tui if terminal specified, otherwise opencode-api.",
    )
    .option("--provider <provider>", "AI provider (e.g., anthropic, openai, opencode-zen)")
    .option("--model <model>", "Model name (e.g., gpt-5.1-codex-mini)")
    .option("--template <name>", "Use a template from ~/.coleo/arms/")
    .option("--recover", "Prefer reattach/recovery for an existing arm before falling back to a restart")
    .option("--watch", "Watch the arm's conversation in real-time after spawning")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const armAgent = "opencode";
      const armDomain = "general";
      const subcommandArgs = getSubcommandArgs(["arm", "spawn"]);
      const interactive = subcommandArgs.length === 0;

      let armName = (options.name || "").trim();
      let armWorkdir = options.workdir || process.cwd();
      let armProvider = options.provider;
      let armModel = options.model;
      let armTemplate = normalizeTemplateName(options.template || "");

      if (!interactive && !armName) {
        armName = generateArmName();
        console.log(`No --name provided. Generated arm name: ${armName}`);
      }

      if (interactive) {
        console.log("\n=== Arm Configuration ===\n");

        const suggestedName = armName || generateArmName();
        const templates = await loadArmTemplates(join(coleoDir, "arms"));
        let templateProvider: string | undefined;
        let templateModel: string | undefined;

        let useTemplate = false;
        if (templates.length > 0) {
          useTemplate = await promptYN("Would you like to use an arm template?", true);
          if (useTemplate) {
            const templateNames = templates.map((t) => `${t.file} - ${t.description}`);
            templateNames.push("Custom arm (no template)");
            const selected = await promptSelect("Select a template:", templateNames);
            const selectedIdx = templateNames.indexOf(selected);
            if (selectedIdx >= 0 && selectedIdx < templates.length) {
              const selectedTemplate = templates[selectedIdx];
              if (selectedTemplate) {
                armTemplate = normalizeTemplateName(selectedTemplate.file);
                templateProvider = selectedTemplate.provider;
                templateModel = selectedTemplate.model;
              }
            }
          }
        }

        const customName = await prompt(`Arm name [${suggestedName}]: `);
        armName = customName.trim() || suggestedName;

        const workdir = await prompt(`Working directory [${process.cwd()}]: `);
        if (workdir.trim()) {
          armWorkdir = workdir;
        }

        const templateModelSummary = [
          templateProvider,
          templateModel,
        ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" / ");

        const providerModelQuestion = templateModelSummary
          ? `Configure provider/model? (template default: ${templateModelSummary})`
          : "Configure provider/model?";

        const hasProvider = await promptYN(providerModelQuestion, false);
        if (hasProvider) {
          const providerPrompt = templateProvider
            ? `Provider [${templateProvider}]: `
            : "Provider (anthropic, openai, github-copilot, opencode-zen): ";
          const provider = await prompt(providerPrompt);
          const providerValue = provider.trim();
          armProvider = providerValue || templateProvider;

          const modelPrompt = templateModel
            ? `Model [${templateModel}]: `
            : "Model [optional]: ";
          const model = await prompt(modelPrompt);
          const modelValue = model.trim();
          armModel = modelValue || templateModel;
        }

        console.log("\n=== Spawning Arm ===");
        console.log(`  Name: ${armName}`);
        if (armTemplate) {
          console.log(`  Template: ${armTemplate}.toml`);
        }
        console.log(`  Workdir: ${armWorkdir}`);
        const summaryProvider = armProvider || templateProvider;
        const summaryModel = armModel || templateModel;
        if (summaryProvider) {
          const providerSuffix = armProvider ? "" : " (template default)";
          console.log(`  Provider: ${summaryProvider}${providerSuffix}`);
          if (summaryModel) {
            const modelSuffix = armModel ? "" : " (template default)";
            console.log(`  Model: ${summaryModel}${modelSuffix}`);
          }
        }
        console.log("");
      }

      if (!armName) {
        armName = generateArmName();
      }

      if (options.terminal && !options.harness) {
        console.log(`Using opencode-tui harness for visible terminal with API control...`);

        const { apiUrl, headers } = getApiConfig();
        if (!await isApiRunning()) {
          console.error("API server is not running.");
          console.error(`Expected at: ${apiUrl}`);
          console.error("");
          console.error("The opencode-tui harness requires the API server for arm tracking.");
          console.error("Start the API server: coleo serve");
          process.exit(1);
        }

        const existsRes = await fetch(`${apiUrl}/api/arms/${armName}`, { headers });
        const armExists = existsRes.ok;

        if (armExists) {
          const existingArm = await existsRes.json() as { arm: { status: string } };
          if (existingArm.arm.status !== "stopped") {
            console.error(`Arm ${armName} already exists with status: ${existingArm.arm.status}`);
            console.error("Use 'coleo arm kill <name>' first, or choose a different name.");
            process.exit(1);
          }
          console.log(`Restarting stopped arm: ${armName}`);
        } else {
        const createPayload: Record<string, unknown> = {
          name: armName,
          status: "starting",
          provider: armProvider,
          model: armModel,
        };
        if (armTemplate) {
          createPayload.template = armTemplate;
        } else {
          createPayload.domain = armDomain;
        }
        createPayload.harness = "opencode-tui";

        const createRes = await fetch(`${apiUrl}/api/arms`, {
          method: "POST",
          headers,
          body: JSON.stringify(createPayload),
        });

          if (!createRes.ok) {
            const err = await createRes.json().catch(() => ({}));
            console.error(`Failed to create arm: ${(err as { error?: string }).error || createRes.statusText}`);
            process.exit(1);
          }
        }

        const spawnRes = await fetch(`${apiUrl}/api/arms/${armName}/spawn`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            workdir: expandPath(armWorkdir),
            provider: armProvider,
            model: armModel,
            initialPrompt: options.prompt,
            harness: "opencode-tui",
            terminal: options.terminal,
            recover: options.recover || false,
          }),
        });

        // Always read response as text first, then parse
        const rawResponse = await spawnRes.text();
        
        if (!spawnRes.ok) {
          try {
            const err = JSON.parse(rawResponse);
            console.error(`Failed to spawn arm: ${(err as { error?: string }).error || spawnRes.statusText}`);
          } catch {
            console.error(`Failed to spawn arm: ${spawnRes.statusText}`);
          }
          process.exit(1);
        }

        const result = JSON.parse(rawResponse) as { 
          spawned: boolean;
          distributed?: boolean;
          sessionId?: string;
          pid?: number;
          port?: number;
          provider?: string;
          model?: string;
        };
        console.log(`Arm spawned with opencode-tui harness in ${options.terminal}:`);
        console.log(`  ID: ${armName}`);
        const resolvedProvider = result.provider || armProvider;
        const resolvedModel = result.model || armModel;
        if (resolvedProvider || resolvedModel) {
          console.log(
            `  Model: ${resolvedProvider ? resolvedProvider + "/" : ""}${resolvedModel || "default"}`,
          );
        }
        console.log(`  Status: ${result.spawned ? "idle" : "unknown"}`);
        console.log(`  PID: ${result.pid || "unknown"}`);
        console.log("");
        console.log("The arm is now running in a visible terminal window.");
        console.log("You can interact with it directly or via the API.");
        return;
      }

      if (options.terminal && options.harness === "opencode") {
        const arm = await spawnArm({
          coleoDir,
          name: armName,
          agent: armAgent,
          workdir: expandPath(armWorkdir),
          terminal: options.terminal,
          initialPrompt: options.prompt,
          headless: false,
          provider: armProvider,
          model: armModel,
          domain: armDomain,
        });

        console.log(`Arm spawned in terminal (legacy mode): ${arm.id}`);
        if (arm.provider || arm.model) {
          console.log(`  Model: ${arm.provider ? arm.provider + "/" : ""}${arm.model || "default"}`);
        }
        console.log(`  Status: ${arm.status}`);
        console.log(`  PID: ${arm.pid || "unknown"}`);
        return;
      }

      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running.");
        console.error(`Expected at: ${apiUrl}`);
        console.error("");
        console.error("Options:");
        console.error("  1. Start the API server: coleo serve");
        console.error("  2. Use terminal mode: coleo arm spawn --name <name> --terminal ghostty");
        process.exit(1);
      }

      const existsRes = await fetch(`${apiUrl}/api/arms/${armName}`, { headers });
      const armExists = existsRes.ok;

      if (armExists) {
        const existingArm = await existsRes.json() as { arm: { status: string } };
        if (existingArm.arm.status !== "stopped") {
          console.error(`Arm ${armName} already exists with status: ${existingArm.arm.status}`);
          console.error("Use 'coleo arm kill <name>' first, or choose a different name.");
          process.exit(1);
        }
        console.log(`Restarting stopped arm: ${armName}`);
      } else {
        const harnessType = options.harness || "opencode-api";
        const createPayload: Record<string, unknown> = {
          name: armName,
          status: "starting",
          provider: armProvider,
          model: armModel,
        };
        if (armTemplate) {
          createPayload.template = armTemplate;
        } else {
          createPayload.domain = armDomain;
        }
        if (options.harness || !armTemplate) {
          createPayload.harness = harnessType;
        }

        const createRes = await fetch(`${apiUrl}/api/arms`, {
          method: "POST",
          headers,
          body: JSON.stringify(createPayload),
        });

        if (!createRes.ok) {
          const err = await createRes.json().catch(() => ({}));
          console.error(`Failed to create arm: ${(err as { error?: string }).error || createRes.statusText}`);
          process.exit(1);
        }
      }

      const spawnRes = await fetch(`${apiUrl}/api/arms/${armName}/spawn`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workdir: expandPath(armWorkdir),
          provider: armProvider,
          model: armModel,
          initialPrompt: options.prompt,
          recover: options.recover || false,
        }),
      });

      // Always read response as text first, then parse
      const rawResponse = await spawnRes.text();
      
      if (!spawnRes.ok) {
        let errorMessage = spawnRes.statusText;
        try {
          const err = JSON.parse(rawResponse);
          errorMessage = (err as { error?: string }).error || spawnRes.statusText;
          console.error(`Spawn response error body:`, JSON.stringify(err, null, 2));
        } catch {
          console.error(`Spawn response text:`, rawResponse);
        }
        console.error(`Failed to spawn arm: ${errorMessage}`);
        process.exit(1);
      }
      
      // Debug: Log raw response
      console.log(`Raw spawn response:`, rawResponse);

      const result = JSON.parse(rawResponse) as { 
        spawned: boolean;
        distributed?: boolean;
        agentId?: string;
        host?: string;
        sessionId?: string; 
        pid?: number;
        port?: number;
        provider?: string;
        model?: string;
      };

      console.log(`Arm spawned via API: ${armName}`);
      console.log(`  Full response:`, JSON.stringify(result, null, 2));
      const resolvedProvider = result.provider || armProvider;
      const resolvedModel = result.model || armModel;
      if (resolvedProvider || resolvedModel) {
        console.log(`  Model: ${resolvedProvider ? resolvedProvider + "/" : ""}${resolvedModel || "default"}`);
      }
      if (result.distributed) {
        console.log(`  Type: Distributed (via agent ${result.agentId})`);
        console.log(`  Host: ${result.host}`);
        console.log(`  Port: ${result.port}`);
        console.log(`  PID: ${result.pid || "unknown"}`);
        console.log("  Note: Distributed arms don't have direct session access");
      } else {
        console.log(`  Session: ${result.sessionId}`);
        console.log(`  PID: ${result.pid || "unknown"}`);
      }
      console.log("");
      console.log("The arm is running in the API server process.");

      if (options.watch) {
        const isLocalAgent = !result.agentId || 
          result.host === "127.0.0.1" || 
          result.host?.includes("localhost") ||
          result.host?.includes("Timothys-MacBook");
        
        if (result.distributed && !isLocalAgent) {
          console.log("\n⚠️  Cannot watch distributed arm directly.");
          console.log(`The arm is running on remote agent ${result.host}:${result.port}`);
          console.log(`Use: octopai arm tail ${armName}`);
          console.log(`Or:  octopai arm status ${armName}`);
        } else {
          console.log("\n");
          await watchArm(armName, { history: "0" });
        }
      } else {
        console.log(`Watch events: coleo arm tail ${armName}`);
        console.log(`View status:  coleo arm status ${armName}`);
        console.log(`View todos:   coleo arm todos ${armName}`);
      }
    });

  armCmd
    .command("names")
    .description("Generate sample sci-fi arm names (inspired by Children of Time/Ruin)")
    .option("-c, --count <number>", "Number of names to generate", "10")
    .option("--stats", "Show name generator statistics")
    .action(async (options) => {
      if (options.stats) {
        const stats = getNameGeneratorStats();
        console.log("\n=== Arm Name Generator ===");
        console.log("Inspired by Adrian Tchaikovsky's 'Children of Time' series\n");
        console.log(`Prefixes:          ${stats.prefixes}`);
        console.log(`Suffixes:          ${stats.suffixes}`);
        console.log(`Epithets:          ${stats.epithets}`);
        console.log(`Classic names:     ${stats.classics}`);
        console.log(`Base combinations: ${stats.baseCombinations.toLocaleString()}`);
        console.log(`With epithets:     ${stats.withEpithets.toLocaleString()}`);
        console.log(`Total unique:      ${stats.total.toLocaleString()}`);
        console.log("");
      }

      const count = Math.min(Math.max(1, parseInt(options.count) || 10), 100);
      const names = generateArmNames(count);

      console.log(`\n=== ${count} Arm Name Suggestions ===\n`);
      names.forEach((name, i) => {
        console.log(`  ${(i + 1).toString().padStart(2)}. ${name}`);
      });
      console.log("");
    });

  armCmd
    .command("list")
    .description("List all arms")
    .option("--all", "Include stopped arms (hidden by default)")
    .option("--once", "Print one snapshot and exit (disable live updates)")
    .option("-i, --interval <ms>", "Refresh interval for live mode", "2000")
    .action(async (options: { all?: boolean; once?: boolean; interval?: string }) => {
      const { apiUrl, headers } = getApiConfig();
      const refreshInterval = Math.max(250, parseInt(options.interval || "2000", 10) || 2000);
      const liveMode = process.stdout.isTTY && !options.once;
      const useColor = Boolean(process.stdout.isTTY);

      const renderSnapshot = async (): Promise<string[]> => {
        if (!(await isApiRunning())) {
          return ["API server is not running."];
        }

        const res = await fetch(`${apiUrl}/api/arms${options.all ? "?includeAll=true" : ""}`, {
          headers,
        });
        if (!res.ok) {
          return ["Failed to fetch arms from API."];
        }

        const payload = await res.json() as {
          arms?: Array<{
            id: string;
            name: string;
            status: string;
            currentTaskSubject?: string | null;
            createdAt?: string;
            runtime?: {
              state: string;
              secondsSinceOutput: number | null;
            };
          }>;
        };

        const arms = payload.arms || [];
        if (arms.length === 0) {
          return [options.all ? "No arms registered." : "No active arms."];
        }

        const rows: RowInput[] = arms.map((arm) => {
          const runtimeState = arm.runtime?.state || "unknown";
          const displayState = classifyArmDisplayState(arm.status, runtimeState);
          const statusIndicator = formatStatusIndicator(displayState, useColor);
          const healthLabel = runtimeState.toLowerCase();
          const taskText = arm.currentTaskSubject || "-";
          return {
            name: `🐙 ${arm.name || arm.id}`,
            lifetime: `📡 ${formatAgeFromSeconds(arm.runtime?.secondsSinceOutput)}`,
            health: `📈 ${healthLabel}`,
            task: `☑️ ${taskText}`,
            statusIndicator,
          };
        });

        return buildAlignedArmLines(rows, process.stdout.columns ?? 120);
      };

      let lastRenderedLines = 0;
      let keepRunning = true;
      const stopLiveMode = () => {
        keepRunning = false;
      };

      if (liveMode) {
        process.once("SIGINT", stopLiveMode);
        process.once("SIGTERM", stopLiveMode);
      }

      try {
        do {
          const lines = await renderSnapshot();
          if (liveMode) {
            lastRenderedLines = renderLines(lines, lastRenderedLines);
          } else {
            for (const line of lines) {
              console.log(process.stdout.isTTY ? line : stripAnsi(line));
            }
          }

          if (!liveMode) break;
          if (!keepRunning) break;
          await new Promise((resolve) => setTimeout(resolve, refreshInterval));
        } while (keepRunning);
      } finally {
        if (liveMode) {
          process.stdout.write("\n");
        }
      }
    });

  armCmd
    .command("kill <name>")
    .description("Kill an arm")
    .action(async (name) => {
      const coleoDir = getColeoDir();
      const { apiUrl, headers } = getApiConfig();

      if (await isApiRunning()) {
        const killRes = await fetch(`${apiUrl}/api/arms/${name}/kill`, {
          method: "POST",
          headers,
        });

        if (killRes.ok) {
          console.log(`Arm ${name} killed via API.`);
          return;
        }
      }

      const success = await killArm(coleoDir, name);

      if (success) {
        console.log(`Arm ${name} killed.`);
      } else {
        console.log(`Failed to kill arm ${name}.`);
      }
    });

  armCmd
    .command("prompt <name> <message>")
    .description("Send a prompt to a running arm")
    .option("-i, --interrupt", "Send escape key twice before prompt to cancel/interrupt current work")
    .action(async (name, message, options: { interrupt?: boolean }) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }

      const armData = await armRes.json() as { arm: { status: string } };
      if (armData.arm.status !== "idle" && armData.arm.status !== "busy") {
        console.error(`Arm ${name} is not running (status: ${armData.arm.status})`);
        console.error("Start the arm first with: coleo arm spawn --name " + name);
        process.exit(1);
      }

      const promptRes = await fetch(`${apiUrl}/api/arms/${name}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: message, interrupt: options.interrupt }),
      });

      if (!promptRes.ok) {
        const err = await promptRes.json().catch(() => ({}));
        console.error(`Failed to send prompt: ${(err as { error?: string }).error || promptRes.statusText}`);
        process.exit(1);
      }

      console.log(`Prompt sent to arm ${name}${options.interrupt ? " (interrupted first)" : ""}`);
      console.log(`(Arm is now ${armData.arm.status === "idle" ? "busy" : "processing"})`);
    });

  armCmd
    .command("tail [name]")
    .description("Watch real-time events from arm(s)")
    .option("-a, --all", "Show events from all arms (default if no name given)")
    .option("-f, --filter <types>", "Filter event types (comma-separated, e.g. 'status,tool')")
    .action(async (name?: string, options?: { all?: boolean; filter?: string }) => {
      const { apiUrl, headers } = getApiConfig();
      const apiKey = headers["X-API-Key"] || "";

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      if (name && !options?.all) {
        const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
        if (!armRes.ok) {
          console.error(`Arm not found: ${name}`);
          process.exit(1);
        }
      }

      const filterTypes = options?.filter?.split(",").map((t) => t.trim()) || [];
      const showAll = !name || options?.all;

      console.log(`Tailing events${showAll ? " from all arms" : ` from ${name}`}...`);
      console.log("Press Ctrl+C to stop\n");

      const wsUrl = apiUrl.replace(/^http/, "ws") + "/ws";
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", apiKey }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === "auth") {
            if (msg.success) {
              ws.send(JSON.stringify({ type: "subscribe", channel: "arm-events" }));
            } else {
              console.error("Authentication failed:", msg.error);
              process.exit(1);
            }
            return;
          }

          if (msg.type === "subscribed") {
            console.log(`Connected and subscribed to ${msg.channel}`);
            return;
          }

          if (msg.channel === "arm-events") {
            const armId = msg.data?.armId;
            const eventType = msg.event?.replace("arm.", "") || "unknown";

            if (!showAll && armId !== name) return;
            if (filterTypes.length > 0 && !filterTypes.some((t) => eventType.includes(t))) return;

            const timestamp = new Date(msg.timestamp).toLocaleTimeString();
            const armLabel = armId ? `[${armId}]` : "";

            let prefix = "";
            if (eventType.includes("status")) prefix = "📊";
            else if (eventType.includes("tool") || eventType.includes("part-tool")) prefix = "🔧";
            else if (eventType.includes("message")) prefix = "💬";
            else if (eventType.includes("file")) prefix = "📄";
            else if (eventType.includes("todo")) prefix = "✅";
            else prefix = "📡";

            const formatValue = (val: unknown): string => {
              if (val === null || val === undefined) return "unknown";
              if (typeof val === "string") return val;
              if (typeof val === "number" || typeof val === "boolean") return String(val);
              if (typeof val === "object") {
                const obj = val as Record<string, unknown>;
                if (obj.status) return String(obj.status);
                if (obj.name) return String(obj.name);
                if (obj.id) return String(obj.id);
                return JSON.stringify(val);
              }
              return String(val);
            };

            let details = "";
            const data = msg.data || {};

            if (eventType === "status") {
              const statusVal = typeof data.status === "object" && data.status !== null
                ? (data.status as Record<string, unknown>).status || data.status
                : data.status;
              details = `status=${formatValue(statusVal)}`;
              if (data.title) details += ` title="${formatValue(data.title)}"`;
            } else if (eventType.includes("part-tool")) {
              details = `tool=${formatValue(data.toolName || data.name)}`;
              if (data.state) details += ` state=${formatValue(data.state)}`;
              else if (data.status) details += ` status=${formatValue(data.status)}`;
            } else if (eventType.includes("message")) {
              details = `role=${formatValue(data.role)}`;
              if (data.id) details += ` id=${formatValue(data.id)}`;
            } else if (eventType.includes("file")) {
              details = `path=${formatValue(data.path)}`;
            } else if (eventType.includes("todo")) {
              if (data.content) details = `"${formatValue(data.content)}"`;
              if (data.status) details += ` [${formatValue(data.status)}]`;
            } else {
              const keys = Object.keys(data).filter((k) => k !== "armId" && k !== "sessionId").slice(0, 3);
              details = keys.map((k) => `${k}=${formatValue(data[k])}`).join(" ");
            }

            console.log(`${timestamp} ${prefix} ${armLabel} ${eventType}: ${details}`);
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
      };

      ws.onclose = () => {
        console.log("\nConnection closed");
        process.exit(0);
      };

      process.on("SIGINT", () => {
        console.log("\nStopping...");
        ws.close();
        process.exit(0);
      });

      await new Promise(() => {});
    });

  /**
   * Watch an arm's conversation in real-time
   */
  async function watchArm(
    name: string,
    options?: { tools?: boolean; system?: boolean; history?: string; verbose?: boolean; fullMessages?: boolean }
  ): Promise<void> {
    const { apiUrl, headers } = getApiConfig();
    const showTools = options?.tools !== false;
    const showSystem = options?.system !== false;
    let truncateMessages = options?.fullMessages !== true;
    const historyCount = parseInt(options?.history || "2", 10);
    const verbose = options?.verbose === true;

    if (!(await isApiRunning())) {
      console.error("API server is not running. Start it with: coleo serve");
      process.exit(1);
    }

    const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
    if (!armRes.ok) {
      console.error(`Arm not found: ${name}`);
      process.exit(1);
    }

    const interactiveTui = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    const loadArmStatus = async (): Promise<WatchArmStatusPayload> => {
      const res = await fetch(`${apiUrl}/api/arms/${name}`, {
        headers,
        signal: createWatchTimeoutSignal(WATCH_AUX_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch arm: ${res.statusText}`);
      }
      return await res.json() as WatchArmStatusPayload;
    };

    const loadMessages = async (limit: number, requestedTruncateMessages = truncateMessages) => {
      try {
        const res = await fetch(
          `${apiUrl}/api/arms/${name}/messages?limit=${limit}&fullText=${requestedTruncateMessages ? "false" : "true"}`,
          {
            headers,
            signal: createWatchTimeoutSignal(WATCH_MESSAGES_FETCH_TIMEOUT_MS),
          },
        );
        if (!res.ok) {
          throw new Error(`Failed to fetch messages: ${res.statusText}`);
        }
        return await res.json() as {
          messages: WatchMessage[];
          sessionId?: string;
          error?: string;
        };
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError")
        ) {
          throw new Error(
            `Timed out loading ${requestedTruncateMessages ? "truncated" : "full-text"} messages`,
          );
        }
        throw err;
      }
    };
    const loadStuckRequest = async (): Promise<WatchStuckRequest | null> => {
      const res = await fetch(`${apiUrl}/api/arms/${name}/stuck`, {
        headers,
        signal: createWatchTimeoutSignal(WATCH_AUX_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch stuck request: ${res.statusText}`);
      }
      const payload = await res.json() as { request?: WatchStuckRequest | null };
      return payload.request || null;
    };

    const sendWatchPrompt = async (promptText: string, interrupt: boolean): Promise<void> => {
      const res = await fetch(`${apiUrl}/api/arms/${name}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: promptText,
          interrupt,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || res.statusText);
      }
    };

    const requestManualStuck = async (): Promise<void> => {
      const res = await fetch(`${apiUrl}/api/arms/${name}/stuck`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          requestedBy: "watch",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || res.statusText);
      }
    };

    if (!interactiveTui) {
      console.log(`Watching arm: ${name}`);
      console.log("Press Ctrl+C to stop\n");

      let running = true;
      let lastRenderedLineCount = 0;
      const stop = () => {
        if (!running) return;
        running = false;
        console.log("\nStopping...");
      };

      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      while (running) {
        try {
          const [armPayload, messagePayload, stuckRequest] = await Promise.all([
            loadArmStatus(),
            loadMessages(Math.max(historyCount * 4, 20)),
            loadStuckRequest(),
          ]);
          const lines = buildWatchTuiLines({
            name,
            arm: armPayload.arm,
            stuckRequest,
            messages: messagePayload.messages,
            showTools,
            showSystem,
            truncateMessages,
            interruptNext: false,
            composing: false,
            draft: "",
            notice: null,
            error: verbose ? messagePayload.error || null : null,
            columns: process.stdout.columns ?? 120,
            rows: process.stdout.rows ?? 40,
          });
          lastRenderedLineCount = renderLines(lines, lastRenderedLineCount);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[watch] ${message}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      return;
    }

    let running = true;
    let currentArm: WatchArmStatusPayload["arm"] | null = null;
    let currentMessages: WatchMessage[] = [];
    let currentStuckRequest: WatchStuckRequest | null = null;
    let notice: string | null = null;
    let errorMessage: string | null = null;
    let interruptNext = false;
    let composing = false;
    let draft = "";
    let fetching = false;
    let forceRefresh = true;
    let lastPollAt = 0;
    let activeSessionId: string | null = null;
    let seededHistory = false;
    let pendingTruncateMessages: boolean | null = null;
    const seenMessageSignatures = new Map<string, string>();

    const render = () => {
      const lines = buildWatchTuiLines({
        name,
        arm: currentArm,
        stuckRequest: currentStuckRequest,
        messages: currentMessages,
        showTools,
        showSystem,
        truncateMessages,
        interruptNext,
        composing,
        draft,
        notice,
        error: errorMessage,
        columns: process.stdout.columns ?? 120,
        rows: process.stdout.rows ?? 40,
      });
      renderFullscreenLines(lines);
    };

    const stop = () => {
      if (!running) return;
      running = false;
      notice = "Stopping...";
      render();
    };

    const refreshSnapshot = async () => {
      if (fetching) return;
      fetching = true;
      const requestedTruncateMessages = pendingTruncateMessages ?? truncateMessages;
      try {
        const [armPayload, messagePayload, stuckRequest] = await Promise.all([
          loadArmStatus(),
          loadMessages(Math.max(historyCount * 4, 50), requestedTruncateMessages),
          loadStuckRequest(),
        ]);
        currentArm = armPayload.arm;

        if (messagePayload.sessionId && messagePayload.sessionId !== activeSessionId) {
          activeSessionId = messagePayload.sessionId;
          seededHistory = false;
          seenMessageSignatures.clear();
          currentMessages = [];
        }

        if (!seededHistory) {
          currentMessages =
            historyCount > 0
              ? messagePayload.messages.slice(-historyCount)
              : [];
          for (const msg of messagePayload.messages) {
            seenMessageSignatures.set(msg.info.id, JSON.stringify(msg.parts));
          }
          seededHistory = true;
        } else {
          for (const msg of messagePayload.messages) {
            const signature = JSON.stringify(msg.parts);
            const previous = seenMessageSignatures.get(msg.info.id);
            if (previous !== signature) {
              const existingIndex = currentMessages.findIndex(
                (candidate) => candidate.info.id === msg.info.id,
              );
              if (existingIndex >= 0) {
                currentMessages[existingIndex] = msg;
              } else {
                currentMessages.push(msg);
              }
            }
            seenMessageSignatures.set(msg.info.id, signature);
          }
          currentMessages = currentMessages.slice(-100);
        }

        currentStuckRequest = stuckRequest;
        truncateMessages = requestedTruncateMessages;
        pendingTruncateMessages = null;
        notice = settleWatchRefreshNotice(notice, { succeeded: true });
        errorMessage = verbose ? messagePayload.error || null : null;
        lastPollAt = Date.now();
      } catch (err) {
        pendingTruncateMessages = null;
        notice = settleWatchRefreshNotice(notice, { succeeded: false });
        errorMessage = err instanceof Error ? err.message : String(err);
      } finally {
        fetching = false;
        render();
      }
    };

    emitKeypressEvents(process.stdin);
    enterFullscreenTui();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();

    const onKeypress = async (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === "c") {
        stop();
        return;
      }

      if (!running) {
        return;
      }

      if (composing) {
        if (key.name === "return") {
          const promptText = draft.trim();
          if (!promptText) {
            notice = "Message cancelled";
            composing = false;
            draft = "";
            render();
            return;
          }

          try {
            notice = `Sending message${interruptNext ? " with interrupt" : ""}...`;
            render();
            await sendWatchPrompt(promptText, interruptNext);
            notice = `Message sent${interruptNext ? " with interrupt" : ""}`;
            composing = false;
            draft = "";
            interruptNext = false;
            forceRefresh = true;
          } catch (err) {
            errorMessage = err instanceof Error ? err.message : String(err);
          }
          render();
          return;
        }

        if (key.name === "escape") {
          composing = false;
          draft = "";
          notice = "Message cancelled";
          render();
          return;
        }

        if (key.name === "backspace") {
          draft = draft.slice(0, -1);
          render();
          return;
        }

        if (!key.ctrl && !key.meta && key.name === "i") {
          interruptNext = !interruptNext;
          render();
          return;
        }

        if (!key.ctrl && !key.meta && key.name === "x") {
          pendingTruncateMessages = !(pendingTruncateMessages ?? truncateMessages);
          forceRefresh = true;
          notice = `Reloading messages with ${(pendingTruncateMessages ?? truncateMessages) ? "truncation" : "full text"}...`;
          render();
          return;
        }

        if (!key.ctrl && !key.meta && str) {
          draft += str;
          render();
        }
        return;
      }

      if (!key.ctrl && !key.meta && key.name === "q") {
        stop();
        return;
      }

      if (!key.ctrl && !key.meta && key.name === "m") {
        composing = true;
        draft = "";
        notice = null;
        render();
        return;
      }

      if (!key.ctrl && !key.meta && key.name === "i") {
        interruptNext = !interruptNext;
        notice = `Interrupt before send ${interruptNext ? "enabled" : "disabled"}`;
        render();
        return;
      }

      if (!key.ctrl && !key.meta && key.name === "x") {
        pendingTruncateMessages = !(pendingTruncateMessages ?? truncateMessages);
        forceRefresh = true;
        notice = `Reloading messages with ${(pendingTruncateMessages ?? truncateMessages) ? "truncation" : "full text"}...`;
        render();
        return;
      }

      if (!key.ctrl && !key.meta && key.name === "s") {
        try {
          notice = "Marking arm as stuck for brain follow-up...";
          render();
          await requestManualStuck();
          notice = "Arm marked as stuck; brain will handle it on the next poll";
          forceRefresh = true;
        } catch (err) {
          errorMessage = err instanceof Error ? err.message : String(err);
        }
        render();
        return;
      }

      if (!key.ctrl && !key.meta && key.name === "r") {
        notice = "Refreshing...";
        forceRefresh = true;
        render();
      }
    };

    process.stdin.on("keypress", onKeypress);
    process.once("SIGTERM", stop);

    try {
      await refreshSnapshot();

      while (running) {
        if (forceRefresh || Date.now() - lastPollAt >= 2000) {
          forceRefresh = false;
          await refreshSnapshot();
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode?.(false);
      process.removeListener("SIGTERM", stop);
      exitFullscreenTui();
      process.stdout.write("\n");
    }
  }

  armCmd
    .command("watch [name]")
    .description("Watch an arm's conversation in real-time (shows message text as it streams)")
    .option("--no-tools", "Hide tool invocations")
    .option("--no-system", "Hide system messages")
    .option("--full-messages", "Show full message text without truncation")
    .option("-n, --history <count>", "Show last N messages on connect", "2")
    .option("-v, --verbose", "Show all SSE events for debugging")
    .action(async (name, options?: { tools?: boolean; system?: boolean; history?: string; verbose?: boolean; fullMessages?: boolean }) => {
      try {
        const resolvedName = await resolveWatchArmName(name, {
          interactive: Boolean(process.stdout.isTTY && process.stdin.isTTY),
          color: Boolean(process.stdout.isTTY),
          columns: process.stdout.columns ?? 120,
        });
        await watchArm(resolvedName, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exit(1);
      }
    });

  armCmd
    .command("todos <name>")
    .description("Show the todo list for an arm")
    .action(async (name) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }

      const todosRes = await fetch(`${apiUrl}/api/arms/${name}/todos`, { headers });
      const todosRaw = await todosRes.text();
      
      if (!todosRes.ok) {
        try {
          const err = JSON.parse(todosRaw);
          console.error(`Failed to get todos: ${(err as { error?: string }).error || todosRes.statusText}`);
        } catch {
          console.error(`Failed to get todos: ${todosRes.statusText}`);
        }
        process.exit(1);
      }

      const data = JSON.parse(todosRaw) as { todos: Array<{ content: string; status: string; priority?: string }> };
      const todos = data.todos || [];

      if (todos.length === 0) {
        console.log(`No todos for arm: ${name}`);
        return;
      }

      console.log(`Todos for arm: ${name}`);
      console.log("=".repeat(50));

      for (const todo of todos) {
        const statusIcon = todo.status === "completed"
          ? "✓"
          : todo.status === "in_progress"
            ? "→"
            : todo.status === "cancelled"
              ? "✗"
              : "○";
        const priority = todo.priority ? ` [${todo.priority}]` : "";
        console.log(`  ${statusIcon} ${todo.content}${priority}`);
      }
    });

  armCmd
    .command("status <name>")
    .description("Show detailed status for an arm")
    .action(async (name) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }

      const armData = await armRes.json() as {
        arm: {
          status: string;
          harness: string;
          domain?: string;
          provider?: string;
          model?: string;
          host?: string;
          agentId?: string;
          pid?: number;
          port?: number;
          sessionId?: string;
          workdir?: string;
          currentTaskSubject?: string;
          currentBugTitle?: string;
          runtime?: {
            state: string;
            reason: string;
            hasRuntime: boolean;
            hasSession: boolean;
            canRecover: boolean;
            lastActivityAt: string | null;
            lastHeartbeatAt: string | null;
            lastOutputAt: string | null;
            secondsSinceActivity: number | null;
            secondsSinceHeartbeat: number | null;
            secondsSinceOutput: number | null;
            signals: {
              dbStatus: string;
              hasPid: boolean;
              hasPort: boolean;
              hasSessionId: boolean;
              hasAgentId: boolean;
              hasWorkdir: boolean;
              hasAssignedTask: boolean;
              distributed: boolean;
            };
          };
        };
      };

      console.log(`Status for arm: ${name}`);
      console.log("=".repeat(50));
      console.log(`  Database status: ${armData.arm.status}`);
      console.log(`  Harness: ${armData.arm.harness || "unknown"}`);
      if (armData.arm.domain) console.log(`  Domain: ${armData.arm.domain}`);
      if (armData.arm.provider || armData.arm.model) {
        console.log(`  Model: ${armData.arm.provider ? armData.arm.provider + "/" : ""}${armData.arm.model || "default"}`);
      }
      if (armData.arm.workdir) console.log(`  Workdir: ${armData.arm.workdir}`);
      if (armData.arm.host || armData.arm.agentId) {
        console.log(`  Runtime host: ${armData.arm.host || "unknown"}${armData.arm.agentId ? ` (${armData.arm.agentId})` : ""}`);
      }
      if (armData.arm.pid || armData.arm.port) {
        console.log(`  Process: ${armData.arm.port ? `:${armData.arm.port}` : "no port"}${armData.arm.pid ? ` · pid ${armData.arm.pid}` : ""}`);
      }
      if (armData.arm.sessionId) {
        console.log(`  Session ID: ${armData.arm.sessionId}`);
      }
      if (armData.arm.currentTaskSubject || armData.arm.currentBugTitle) {
        console.log(`  Assignment: ${armData.arm.currentBugTitle || armData.arm.currentTaskSubject}`);
      }

      if (armData.arm.runtime) {
        console.log("");
        console.log("Runtime summary:");
        console.log(`  State: ${armData.arm.runtime.state}`);
        console.log(`  Reason: ${armData.arm.runtime.reason}`);
        console.log(`  Last output: ${formatAgeFromSeconds(armData.arm.runtime.secondsSinceOutput)}`);
        console.log(`  Last heartbeat: ${formatAgeFromSeconds(armData.arm.runtime.secondsSinceHeartbeat)}`);
        console.log(`  Last activity: ${formatAgeFromSeconds(armData.arm.runtime.secondsSinceActivity)}`);
        console.log(`  Can recover: ${armData.arm.runtime.canRecover ? "yes" : "no"}`);

        console.log("");
        console.log("Signals:");
        console.log(`  status=${armData.arm.runtime.signals.dbStatus}`);
        console.log(`  pid=${armData.arm.runtime.signals.hasPid ? "yes" : "no"}`);
        console.log(`  port=${armData.arm.runtime.signals.hasPort ? "yes" : "no"}`);
        console.log(`  session=${armData.arm.runtime.signals.hasSessionId ? "yes" : "no"}`);
        console.log(`  agent=${armData.arm.runtime.signals.hasAgentId ? "yes" : "no"}`);
        console.log(`  workdir=${armData.arm.runtime.signals.hasWorkdir ? "yes" : "no"}`);
        console.log(`  task=${armData.arm.runtime.signals.hasAssignedTask ? "yes" : "no"}`);
      }
    });

  armCmd
    .command("recover <name>")
    .description("Recover or restart an arm using its persisted runtime metadata")
    .action(async (name) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const res = await fetch(`${apiUrl}/api/arms/${name}/recover`, {
        method: "POST",
        headers,
      });

      const raw = await res.text();
      if (!res.ok) {
        try {
          const err = JSON.parse(raw);
          console.error(`Failed to recover arm: ${(err as { error?: string }).error || res.statusText}`);
        } catch {
          console.error(`Failed to recover arm: ${res.statusText}`);
        }
        process.exit(1);
      }

      const result = JSON.parse(raw) as {
        recoveryMode?: string;
        distributed?: boolean;
        host?: string;
        agentId?: string;
        pid?: number;
        port?: number;
        sessionId?: string;
      };

      console.log(`Recovered arm: ${name}`);
      console.log(`  Mode: ${result.recoveryMode || "restarted"}`);
      if (result.distributed) {
        console.log(`  Host: ${result.host || result.agentId || "unknown"}`);
      }
      if (result.port || result.pid) {
        console.log(`  Process: ${result.port ? `:${result.port}` : "no port"}${result.pid ? ` · pid ${result.pid}` : ""}`);
      }
      if (result.sessionId) {
        console.log(`  Session: ${result.sessionId}`);
      }
    });

  armCmd
    .command("remove <name>")
    .description("Remove a stopped arm from the database")
    .action(async (name) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }

      const armData = await armRes.json() as { arm: { status: string } };
      if (armData.arm.status !== "stopped") {
        console.error(`Cannot remove arm with status: ${armData.arm.status}`);
        console.error("Kill the arm first with: coleo arm kill " + name);
        process.exit(1);
      }

      const deleteRes = await fetch(`${apiUrl}/api/arms/${name}`, {
        method: "DELETE",
        headers,
      });

      if (deleteRes.ok) {
        console.log(`Arm ${name} removed from database.`);
      } else {
        const err = await deleteRes.json().catch(() => ({}));
        console.error(`Failed to remove arm: ${(err as { error?: string }).error || deleteRes.statusText}`);
        process.exit(1);
      }
    });

  armCmd
    .command("cleanup")
    .description("Remove all stopped arms from the database")
    .action(async () => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armsRes = await fetch(`${apiUrl}/api/arms`, { headers });
      if (!armsRes.ok) {
        console.error("Failed to fetch arms");
        process.exit(1);
      }

      const armsData = await armsRes.json() as { arms: Array<{ id: string; status: string }> };
      const stoppedArms = armsData.arms.filter((a) => a.status === "stopped");

      if (stoppedArms.length === 0) {
        console.log("No stopped arms to clean up.");
        return;
      }

      console.log(`Removing ${stoppedArms.length} stopped arm(s)...`);

      for (const arm of stoppedArms) {
        const deleteRes = await fetch(`${apiUrl}/api/arms/${arm.id}`, {
          method: "DELETE",
          headers,
        });

        if (deleteRes.ok) {
          console.log(`  Removed: ${arm.id}`);
        } else {
          console.log(`  Failed to remove: ${arm.id}`);
        }
      }

      console.log("Cleanup complete.");
    });

  armCmd
    .command("logs <name>")
    .description("Tail the log file for an arm (Ctrl+C to exit)")
    .option("-n, --lines <n>", "Number of initial lines to show", "100")
    .action(async (name, options) => {
      const coleoDir = getColeoDir();
      const logPath = join(coleoDir, "logs", `${name}.log`);

      const { existsSync } = await import("fs");

      if (!existsSync(logPath)) {
        console.error(`Log file not found: ${logPath}`);
        console.error("Arm may not have been spawned yet, or logs are stored elsewhere.");
        process.exit(1);
      }

      console.log(`Tailing logs for arm: ${name}`);
      console.log(`Log file: ${logPath}`);
      console.log("=".repeat(60));
      console.log("(Ctrl+C to exit)");
      console.log("=".repeat(60));

      const { spawn } = await import("child_process");
      const tail = spawn("tail", ["-n", options.lines, "-f", logPath], {
        stdio: "inherit",
        cwd: process.cwd(),
      });

      tail.on("error", (err) => {
        console.error(`Failed to tail log: ${err}`);
        process.exit(1);
      });

      process.on("SIGINT", () => {
        tail.kill("SIGINT");
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        tail.kill("SIGTERM");
        process.exit(0);
      });
    });
}
