import { Command } from "commander";
import { registerActivityCommands } from "./commands/activity";
import { registerAgentCommands } from "./commands/agent";
import { registerArmCommands } from "./commands/arm";
import { registerBrainCommands } from "./commands/brain";
import { registerConfigCommands } from "./commands/config";
import { registerDebugCommands } from "./commands/debug";
import { registerDiscoveriesCommands } from "./commands/discoveries";
import { registerImapCommands } from "./commands/imap";
import { registerInitCommand } from "./commands/init";
import { registerMailCommands } from "./commands/mail";
import { registerMcpCommands } from "./commands/mcp";
import { registerServeCommand } from "./commands/serve";
import { registerStatusReportsCommands } from "./commands/status-reports";
import { registerStatusCommand } from "./commands/status";
import { registerTasksCommands } from "./commands/tasks";
import { registerWebCommand } from "./commands/web";

const CLI_HELP_TEXT = `
Common workflows:
  coleo init
  coleo serve start
  coleo brain start
  coleo status
  coleo arm spawn --prompt "Pick up the next important task"
  coleo arm list
  coleo tasks list
  coleo mail inbox
`;

export function buildCliProgram(): Command {
  const program = new Command();

  program
    .name("coleo")
    .description("Run Coleo from the terminal")
    .version("0.2.0")
    .showSuggestionAfterError()
    .showHelpAfterError();

  program.addHelpText("after", CLI_HELP_TEXT);

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

  return program;
}
