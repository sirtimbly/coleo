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
import { registerArmsCommand } from "./commands/arms";
import { registerActivityCommands } from "./commands/activity";
import { registerMailCommands } from "./commands/mail";
import { registerImapCommands } from "./commands/imap";
import { registerMcpCommands } from "./commands/mcp";
import { registerAgentCommands } from "./commands/agent";
import { registerTasksCommands } from "./commands/tasks";
import { registerBugsCommands } from "./commands/bugs";
import { registerStatusCommand } from "./commands/status";
import { registerStatusReportsCommands } from "./commands/status-reports";
import { registerConfigCommands } from "./commands/config";
import { registerDiscoveriesCommands } from "./commands/discoveries";
import { registerDebugCommands } from "./commands/debug";
import { registerWebCommand } from "./commands/web";

import { registerBranchCommands } from "./commands/branch";

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
registerArmsCommand(program);
registerActivityCommands(program);
registerMailCommands(program);
registerImapCommands(program);
registerMcpCommands(program);
registerAgentCommands(program);
registerTasksCommands(program);
registerBugsCommands(program);
registerStatusCommand(program);
registerStatusReportsCommands(program);
registerConfigCommands(program);
registerDiscoveriesCommands(program);
registerDebugCommands(program);
registerWebCommand(program);
registerBranchCommands(program);

await program.parseAsync();
