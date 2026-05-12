import { Command } from "commander";
import { runArmsDashboardTui } from "../tui/arms-dashboard";

export function registerArmsCommand(program: Command): void {
  program
    .command("arms")
    .description("Open the live arms dashboard")
    .action(async () => {
      await runArmsDashboardTui();
    });
}
