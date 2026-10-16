import type { Command } from "commander";

/** Keep old entry points discoverable while API operations move to the client. */
export function registerClientMigration(
  program: Command, name: string, replacement: string, subcommands: Readonly<Record<string, string>> = {},
): void {
  const message = (target: string): string =>
    `Use coleo-client ${target}. It connects to the server selected by --connection or COLEO_API_URL.`;
  program.command(name)
    .description(`Moved to coleo-client ${replacement}`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[arguments...]")
    .addHelpText("after", `\n${message(replacement)}\nInstall from a checkout: mise run setup:cli\n`)
    .action((args: string[]) => {
      const subcommand = args[0] ?? "";
      console.error(message(Object.hasOwn(subcommands, subcommand) ? subcommands[subcommand]! : replacement));
      console.error("Install from a checkout: mise run setup:cli");
      process.exitCode = 1;
    });
}
