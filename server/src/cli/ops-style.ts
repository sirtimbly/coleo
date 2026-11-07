import boxen from "boxen";
import chalk from "chalk";
import { inboxColorEnabled } from "./inbox/terminal-theme";

type Tone = "info" | "success" | "warning";
interface OutputTerminal { isTTY?: boolean; columns?: number }
const accents = { info: "cyan", success: "green", warning: "yellow" } as const;
const icons = { info: "🐙", success: "✅", warning: "⚠️" } as const;

export function instructionPanel(title: string, lines: string[], tone: Tone = "info",
  terminal: OutputTerminal = process.stderr): string {
  if (!terminal.isTTY || process.env.TERM === "dumb" || (terminal.columns ?? 80) < 36) {
    return [title, ...lines].join("\n");
  }
  const color = inboxColorEnabled("auto", { isTTY: terminal.isTTY });
  const ink = new chalk.Instance({ level: color ? 1 : 0 });
  return "\n" + boxen([ink[accents[tone]].bold(`${icons[tone]}  ${title}`), "", ...lines].join("\n"), {
    borderStyle: "round", borderColor: color ? accents[tone] : undefined,
    padding: { top: 1, bottom: 1, left: 2, right: 2 },
    width: Math.min(88, (terminal.columns ?? 80) - 2),
  }) + "\n";
}

/** Commands sit outside borders, without hard wrapping or shell prompt prefixes. */
export function instructionCommands(label: string, commands: string[], terminal: OutputTerminal = process.stderr): string {
  const ink = new chalk.Instance({ level: inboxColorEnabled("auto", { isTTY: terminal.isTTY }) ? 1 : 0 });
  return `\n${ink.bold(label)}\n\n${commands.map(command => ink.cyan(command)).join("\n\n")}\n`;
}

export function setupStep(name: string): string {
  if (!process.stderr.isTTY || process.env.TERM === "dumb") return `Setup: ${name}\n`;
  const ink = new chalk.Instance({ level: inboxColorEnabled("auto", { isTTY: true }) ? 1 : 0 });
  return `\n${ink.cyan("◆")}  ${ink.bold(name.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase()))}\n`;
}
