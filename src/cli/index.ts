#!/usr/bin/env bun
/**
 * Coleo CLI
 *
 * AI agent orchestrator using the Octopus Model
 */

import { Command } from "commander";
import { loadEnvFile } from "./context";
import { registerInitCommand } from "./commands/init";
import { registerServeCommand } from "./commands/serve";
import { registerBrainCommands } from "./commands/brain";
import { registerArmCommands } from "./commands/arm";
import { registerActivityCommands } from "./commands/activity";
import { registerMailCommands } from "./commands/mail";
import { registerImapCommands } from "./commands/imap";
import { registerMcpCommands } from "./commands/mcp";
import { registerAgentCommands } from "./commands/agent";
import { registerTasksCommands } from "./commands/tasks";
import { registerStatusCommand } from "./commands/status";
import { registerStatusReportsCommands } from "./commands/status-reports";
import { registerConfigCommands } from "./commands/config";
import { registerDiscoveriesCommands } from "./commands/discoveries";
import { registerDebugCommands } from "./commands/debug";
import { registerWebCommand } from "./commands/web";

await loadEnvFile();

const program = new Command();
program
  .name("coleo")
  .description("AI agent orchestrator using the Octopus Model")
  .version("0.2.0");

// Register all command modules
registerInitCommand(program);
registerServeCommand(program);
registerBrainCommands(program);
registerArmCommands(program);
registerActivityCommands(program);
registerMailCommands(program);
registerImapCommands(program);
registerMcpCommands(program);
registerAgentCommands(program);
registerTasksCommands(program);
registerStatusCommand(program);
registerStatusReportsCommands(program);
registerConfigCommands(program);
registerDiscoveriesCommands(program);
registerDebugCommands(program);
registerWebCommand(program);

await program.parseAsync();
