#!/usr/bin/env bun

import { ArmAgent } from "./arm-agent";
import { runMcpServer } from "../mcp";

export interface CloudflareAgentOptions {
  agentId?: string;
  natsUrl: string;
  maxArms: number;
  heartbeatIntervalMs: number;
  verbose: boolean;
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
    || process.env.COLEO_NATS_URL
    || "nats://127.0.0.1:4222";
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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "mcp" && argv[1] === "serve") {
    await runMcpServer();
    return;
  }
  await runAgent(argv);
}

if (import.meta.main) {
  await main();
}
