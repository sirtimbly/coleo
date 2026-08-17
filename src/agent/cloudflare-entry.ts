#!/usr/bin/env bun

import { loadEnvFile } from "../config/env";
import { resolveNatsUrl } from "../network-config";

export interface CloudflareAgentOptions {
  agentId?: string;
  natsUrl: string;
  maxArms: number;
  heartbeatIntervalMs: number;
  verbose: boolean;
}

export interface CloudflareRuntimeHandlers {
  startAgent(argv: string[]): Promise<void>;
  serveMcp(): Promise<void>;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

export function parseCloudflareAgentOptions(argv: string[]): CloudflareAgentOptions {
  const natsUrl = valueAfter(argv, "--nats-url")
    || resolveNatsUrl();
  return {
    agentId: valueAfter(argv, "--id") || process.env.COLEO_AGENT_ID,
    natsUrl,
    maxArms: positiveInteger(valueAfter(argv, "--max-arms"), 10, "--max-arms"),
    heartbeatIntervalMs: positiveInteger(
      valueAfter(argv, "--heartbeat-interval"),
      30_000,
      "--heartbeat-interval",
    ),
    verbose: argv.includes("--verbose"),
  };
}

async function runAgent(argv: string[]): Promise<void> {
  const { ArmAgent } = await import("./arm-agent");
  const options = parseCloudflareAgentOptions(argv);
  const agent = new ArmAgent({
    agentId: options.agentId,
    natsUrl: options.natsUrl,
    natsToken: process.env.COLEO_NATS_TOKEN,
    coleoDir: process.env.COLEO_DIR || "/home/coleo/runtime/coleo",
    workspaceRoot: process.env.COLEO_AGENT_WORKDIR || process.cwd(),
    maxArms: options.maxArms,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    debug: options.verbose,
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await agent.start();
  const info = agent.getInfo();
  console.log(`Arm Host running: ${info.agentId}`);
  await new Promise(() => {});
}

async function serveMcp(): Promise<void> {
  const { runMcpServer } = await import("../mcp");
  await runMcpServer();
}

const DEFAULT_RUNTIME_HANDLERS: CloudflareRuntimeHandlers = {
  startAgent: runAgent,
  serveMcp,
};

export async function main(
  argv = process.argv.slice(2),
  handlers = DEFAULT_RUNTIME_HANDLERS,
): Promise<void> {
  // R2 restore can provide provider credentials in $COLEO_DIR/.env. Load them
  // before importing either runtime so module-level environment reads and all
  // spawned processes see the complete environment. Explicit container values
  // retain precedence because loadEnvFile only fills missing keys.
  await loadEnvFile();

  if (argv[0] === "mcp" && argv[1] === "serve") {
    await handlers.serveMcp();
    return;
  }
  await handlers.startAgent(argv);
}

if (import.meta.main) {
  await main();
}
