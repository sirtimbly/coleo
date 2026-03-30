import { describe, expect, it } from "bun:test";
import type { Command } from "commander";
import { join } from "path";
import { buildCliProgram } from "../program";

function findCommand(command: Command, path: string[]): Command {
  let current = command;

  for (const segment of path) {
    const next = current.commands.find((candidate) => candidate.name() === segment);
    if (!next) {
      throw new Error(`Command not found: ${path.join(" ")}`);
    }
    current = next;
  }

  return current;
}

describe("CLI program", () => {
  it("registers the full top-level command surface", () => {
    const program = buildCliProgram();

    expect(program.commands.map((command) => command.name())).toEqual([
      "init",
      "serve",
      "brain",
      "arm",
      "activity",
      "mail",
      "imap",
      "mcp",
      "agent",
      "tasks",
      "status",
      "status-reports",
      "config",
      "discoveries",
      "debug",
      "web",
    ]);
  });

  it("shows a CLI-first quick start in root help", () => {
    const proc = Bun.spawnSync([process.execPath, "run", join(process.cwd(), "src/cli/index.ts"), "--help"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BUN_TEST: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const help = Buffer.from(proc.stdout).toString("utf8");

    expect(help).toContain("Run Coleo from the terminal");
    expect(help).toContain("Common workflows:");
    expect(help).toContain("coleo serve start");
    expect(help).toContain('coleo arm spawn --prompt "Pick up the next important task"');
    expect(help).toContain("coleo tasks list");
    expect(help).toContain("coleo mail inbox");
  });

  it("restores -h help shortcuts on host-based commands", () => {
    const program = buildCliProgram();

    const serveHelp = findCommand(program, ["serve"]).helpInformation();
    expect(serveHelp).toContain("-H, --host <host>");
    expect(serveHelp).toContain("-h, --help");

    const webHelp = findCommand(program, ["web"]).helpInformation();
    expect(webHelp).toContain("-H, --host <host>");
    expect(webHelp).toContain("-h, --help");

    const imapServeHelp = findCommand(program, ["imap", "serve"]).helpInformation();
    expect(imapServeHelp).toContain("-H, --host <host>");
    expect(imapServeHelp).toContain("-h, --help");
  });

  it("keeps high-value subcommands discoverable in help", () => {
    const expectations: Array<{ path: string[]; includes: string[] }> = [
      {
        path: ["brain"],
        includes: ["run [options]", "status", "prompt:task", "prompt:context [task-id-or-subject]"],
      },
      {
        path: ["arm"],
        includes: ["spawn [options]", "list [options]", "status <name>", "recover <name>", "watch [options] [name]"],
      },
      {
        path: ["arm", "watch"],
        includes: ["--full-messages", "--no-tools", "--no-system"],
      },
      {
        path: ["activity"],
        includes: ["list [options]", "transcript [options]", "tail [options]", "search [options] <query>"],
      },
      {
        path: ["mail"],
        includes: ["inbox [options]", "send [options] <message>", "read [id]"],
      },
      {
        path: ["tasks"],
        includes: ["list [options]", "discuss [options] <taskId> <message>", "discussions [options] <taskId>"],
      },
      {
        path: ["tasks", "list"],
        includes: ["--json", "--status <status>", "--limit <n>"],
      },
      {
        path: ["status-reports"],
        includes: ["backfill [options]"],
      },
      {
        path: ["discoveries"],
        includes: ["summarize [options]", "list [options]", "resolve [options] <title>", "history [options]"],
      },
      {
        path: ["debug"],
        includes: ["intent [options] <message>", "intent-batch [options]"],
      },
      {
        path: ["web"],
        includes: ["start [options]", "status", "logs [options]", "build"],
      },
    ];

    for (const expectation of expectations) {
      const help = findCommand(buildCliProgram(), expectation.path).helpInformation();
      for (const snippet of expectation.includes) {
        expect(help).toContain(snippet);
      }
    }
  });
});
