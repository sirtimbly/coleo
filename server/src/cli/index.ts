#!/usr/bin/env bun
/**
 * Coleo CLI
 *
 * AI agent orchestrator using the Octopus Model
 */

import { Command } from "commander";
import { VERSION } from "../version";
import { loadEnvFile } from "./context";
import { registerInitCommand } from "./commands/init";
import { registerServeCommand } from "./commands/serve";
import { registerBrainCommands } from "./commands/brain";
import { registerArmCommands } from "./commands/arm";
import { registerImapCommands } from "./commands/imap";
import { registerMcpCommands } from "./commands/mcp";
import { registerAgentCommands } from "./commands/agent";
import { registerStatusReportsCommands } from "./commands/status-reports";
import { registerDiscoveriesCommands } from "./commands/discoveries";
import { registerDebugCommands } from "./commands/debug";

import { registerBranchCommands } from "./commands/branch";
import { registerClientMigration } from "./client-migration";

await loadEnvFile();

const program = new Command();
program
  .name("coleo")
  .description("AI agent orchestrator using the Octopus Model")
  .version(VERSION);

// Register all command modules
registerInitCommand(program);
registerServeCommand(program);
registerBrainCommands(program);
registerImapCommands(program);
registerMcpCommands(program);
registerStatusReportsCommands(program);
registerDebugCommands(program);
registerBranchCommands(program);

// Local diagnostics retain their operator implementation. Domain operations now
// name the API-only client explicitly rather than falling back to local state.
const legacy = new Command();
registerArmCommands(legacy);
registerDiscoveriesCommands(legacy);
registerAgentCommands(legacy);
const arm = legacy.commands.find(command => command.name() === "arm");
if (arm) {
  const target = program.command("arm").description("Local arm logs and API-client migration commands");
  const moved = arm.commands.filter(command => command.name() !== "logs").map(command => command.name());
  for (const command of arm.commands.filter(command => command.name() === "logs")) target.addCommand(command);
  for (const name of moved) registerClientMigration(target, name, `arms ${name}`);
}
const discoveries = legacy.commands.find(command => command.name() === "discoveries");
if (discoveries) {
  const target = program.command("discoveries").description("Local summarizer diagnostic and API-client migration commands");
  for (const command of discoveries.commands.filter(command => command.name() === "summarize")) target.addCommand(command);
  for (const name of ["list", "resolve", "history"]) registerClientMigration(target, name, `discoveries ${name}`);
}
const agent = legacy.commands.find(command => command.name() === "agent");
if (agent) {
  const target = program.command("agent").description("Legacy foreground Arm Host; use coleo-agent for lifecycle");
  for (const command of agent.commands.filter(command => command.name() !== "status")) target.addCommand(command);
  registerClientMigration(target, "status", "agents");
}
for (const name of ["tasks", "bugs", "mail", "config", "activity", "status"]) {
  registerClientMigration(program, name, name);
}
registerClientMigration(program, "inbox", "inbox", { views: "views", validate: "validate" });
registerClientMigration(program, "arms", "arms list --watch");
registerClientMigration(program, "tui", "tui");
registerClientMigration(program, "web", "web");

await program.parseAsync();
