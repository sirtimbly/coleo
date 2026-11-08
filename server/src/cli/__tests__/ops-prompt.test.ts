import { expect, test } from "bun:test";
import { spawn } from "bun-pty";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IPty } from "bun-pty";

function terminal(command: string[], cwd: string): {
  pty: IPty; output: () => string; waitForPrompt: (label: string) => Promise<string>; exited: Promise<number>;
} {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("COLEO_") && !key.startsWith("OPENAI_")) env[key] = value;
  }
  const pty = spawn(process.execPath, command, { cwd, env, name: "xterm", cols: 240, rows: 40 });
  let output = "";
  pty.onData(data => { output += data; });
  const exited = new Promise<number>(resolve => pty.onExit(event => resolve(event.exitCode)));
  const waitForPrompt = (label: string) => new Promise<string>((resolve, reject) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => { subscription.dispose(); clearTimeout(quiet); reject(new Error(`No prompt: ${label}`)); }, 4000);
    const update = () => {
      if (!output.includes(label)) return;
      clearTimeout(quiet);
      // Wait for readline's redraw, not merely the first write of the label.
      quiet = setTimeout(() => {
        clearTimeout(deadline); subscription.dispose();
        const cleared = output.lastIndexOf("\x1b[0J");
        resolve(output.slice(cleared < 0 ? 0 : cleared + 4).replace(/\x1b\[[\d;]*[A-Za-z]/g, ""));
      }, 100);
    };
    const subscription = pty.onData(update);
    update();
  });
  return { pty, output: () => output, waitForPrompt, exited };
}

test("interactive init keeps each question visible after readline redraw", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coleo-prompt-"));
  const session = terminal([resolve(import.meta.dir, "../ops.ts"), "init", "--dry-run"], cwd);
  try {
    for (const [label, answer] of [
      ["What does this machine do?", ""],
      ["Clients to install", ""],
      ["Repository directory", ""],
      ["Brain provider", ""],
      ["Brain model (blank keeps configured/default model)", ""],
    ]) {
      expect(await session.waitForPrompt(label!)).toContain(label!);
      session.pty.write(`${answer}\r`);
    }
    expect(await session.exited).toBe(0);
    expect(session.output()).toContain("pass    plan:");
  } finally { session.pty.kill(); await rm(cwd, { recursive: true, force: true }); }
}, 10_000);

test("client checklist supports multiple selections and cannot deselect CLI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coleo-client-checklist-"));
  const script = join(cwd, "checklist.ts");
  await writeFile(script, `import { selectSetupClients } from ${JSON.stringify(resolve(import.meta.dir, "../ops-setup.ts"))};
console.log("Selected=" + JSON.stringify(await selectSetupClients(["cli"])));`);
  const session = terminal([script], cwd);
  try {
    const label = "Clients to install";
    await session.waitForPrompt(label);
    const clean = () => session.output().replace(/\x1b\[[\d;?]*[A-Za-z]/g, "");
    expect(clean()).toMatch(/\[x\]\s+CLI.*required/);
    // CLI starts focused and locked. Then select the two optional clients.
    session.pty.write(" \x1b[B \x1b[B ");
    await session.waitForPrompt(label);
    expect(clean()).toContain("[x] Python/Textual terminal UI");
    expect(clean()).toContain("[x] Web browser client");
    session.pty.write("ii");
    await session.waitForPrompt(label);
    expect(clean()).not.toMatch(/\[ \]\s+CLI/);
    session.pty.write("\r");
    expect(await session.exited).toBe(0);
    expect(session.output()).toContain('Selected=["cli","tui","web"]');
  } finally { session.pty.kill(); await rm(cwd, { recursive: true, force: true }); }
}, 10_000);

test("hidden credential prompt remains visible without echoing the credential", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coleo-secret-prompt-"));
  const script = join(cwd, "prompt.ts");
  await writeFile(script, `import { ask } from ${JSON.stringify(resolve(import.meta.dir, "../ops-setup.ts"))};
const key = await ask("API key", "", true);
console.log(key === "test-private-key" ? "Credential accepted" : "Wrong input");`);
  const session = terminal([script], cwd);
  try {
    expect(await session.waitForPrompt("API key")).toContain("API key");
    session.pty.write("test-private-key\r");
    expect(await session.exited).toBe(0);
    expect(session.output()).toContain("Credential accepted");
    expect(session.output()).not.toContain("test-private-key");
  } finally { session.pty.kill(); await rm(cwd, { recursive: true, force: true }); }
}, 10_000);

test("Ctrl-C at an interactive question cancels instead of leaving init waiting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coleo-cancel-prompt-"));
  const session = terminal([resolve(import.meta.dir, "../ops.ts"), "init", "--dry-run"], cwd);
  try {
    expect(await session.waitForPrompt("What does this machine do?")).toContain("What does this machine do?");
    session.pty.write("\x03");
    expect(await session.exited).toBe(130);
  } finally { session.pty.kill(); await rm(cwd, { recursive: true, force: true }); }
}, 5000);
