# Agent Harnesses

Octopai needs to interface with various AI coding agents, each with their own proprietary CLI/TUI. Rather than depending on specific APIs, we treat these tools as **interactive terminal applications** and communicate via keystrokes and text parsing.

## The Problem

Most AI coding agents are distributed as proprietary client applications:

| Agent | Interface | MCP Support | API Access |
|-------|-----------|-------------|------------|
| OpenCode | TUI (terminal) | Yes | No |
| Claude Code | TUI (terminal) | Yes | Limited |
| Codex CLI | TUI (terminal) | No | OpenAI API |
| Roo | TUI (terminal) | Yes | No |
| Kilo | TUI (terminal) | Unknown | No |
| Aider | CLI (interactive) | No | Multiple APIs |
| Gemini CLI | TUI (terminal) | No | Google API |
| Cursor | GUI (Electron) | Partial | No |

**Key insight**: The common denominator is the **interactive terminal**. Every agent can be controlled by sending keystrokes and reading terminal output.

## Harness Architecture

A harness is an adapter that translates Octopai's commands into agent-specific interactions.

```
┌─────────────────────────────────────────────────────────────┐
│                    HARNESS ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Octopai Brain                                               │
│       │                                                      │
│       │ Unified Interface                                    │
│       ▼                                                      │
│  ┌─────────────┐                                             │
│  │   Harness   │ ◄── Abstract interface                      │
│  │   Manager   │                                             │
│  └─────────────┘                                             │
│       │                                                      │
│       ├──────────────┬──────────────┬──────────────┐         │
│       ▼              ▼              ▼              ▼         │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐   │
│  │OpenCode │    │ Claude  │    │  Codex  │    │  Aider  │   │
│  │ Harness │    │ Harness │    │ Harness │    │ Harness │   │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘   │
│       │              │              │              │         │
│       ▼              ▼              ▼              ▼         │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐   │
│  │   PTY   │    │   PTY   │    │   PTY   │    │   PTY   │   │
│  │ Session │    │ Session │    │ Session │    │ Session │   │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Harness Interface

Every harness implements this interface:

```typescript
interface AgentHarness {
  // Metadata
  name: string;                    // e.g., "opencode", "claude-code"
  version: string;
  capabilities: HarnessCapabilities;
  
  // Lifecycle
  spawn(config: SpawnConfig): Promise<HarnessSession>;
  kill(session: HarnessSession): Promise<void>;
  
  // Communication
  sendPrompt(session: HarnessSession, prompt: string): Promise<void>;
  waitForResponse(session: HarnessSession, timeout?: number): Promise<string>;
  waitForIdle(session: HarnessSession, timeout?: number): Promise<void>;
  
  // State detection
  getState(session: HarnessSession): Promise<AgentState>;
  isProcessing(session: HarnessSession): Promise<boolean>;
  
  // Special actions
  interrupt(session: HarnessSession): Promise<void>;
  compact(session: HarnessSession): Promise<void>;  // If supported
  
  // MCP (if supported)
  hasMCP(): boolean;
  getMCPEndpoint?(session: HarnessSession): string;
}

interface HarnessCapabilities {
  mcp: boolean;                    // Supports MCP protocol
  streaming: boolean;              // Can stream responses
  interrupt: boolean;              // Can interrupt mid-response
  compact: boolean;                // Can compact/summarize context
  multiTurn: boolean;              // Maintains conversation context
  fileEditing: boolean;            // Can edit files directly
  commandExecution: boolean;       // Can run shell commands
}

interface SpawnConfig {
  workdir: string;
  env: Record<string, string>;
  headless: boolean;
  mcpServers?: string[];           // MCP servers to connect
}

type AgentState = 
  | "initializing"
  | "idle"                         // Waiting for input
  | "processing"                   // Thinking/generating
  | "executing"                    // Running tools/commands
  | "waiting_approval"             // Asking user for confirmation
  | "error"
  | "dead";
```

## PTY Session Management

Each agent runs in a pseudo-terminal (PTY) for realistic terminal interaction:

```typescript
import { spawn } from "node-pty";

interface PTYSession {
  pty: IPty;
  buffer: string;                  // Accumulated output
  lineBuffer: string[];            // Line-by-line history
  onData: (data: string) => void;
  onExit: (code: number) => void;
}

class PTYManager {
  async spawn(command: string, args: string[], config: SpawnConfig): Promise<PTYSession> {
    const pty = spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: config.workdir,
      env: { ...process.env, ...config.env },
    });
    
    const session: PTYSession = {
      pty,
      buffer: "",
      lineBuffer: [],
      onData: () => {},
      onExit: () => {},
    };
    
    pty.onData((data) => {
      session.buffer += data;
      // Parse into lines, handle ANSI escape codes
      const lines = parseTerminalOutput(data);
      session.lineBuffer.push(...lines);
      session.onData(data);
    });
    
    pty.onExit(({ exitCode }) => {
      session.onExit(exitCode);
    });
    
    return session;
  }
  
  write(session: PTYSession, text: string): void {
    session.pty.write(text);
  }
  
  sendKey(session: PTYSession, key: TerminalKey): void {
    session.pty.write(KEY_SEQUENCES[key]);
  }
  
  resize(session: PTYSession, cols: number, rows: number): void {
    session.pty.resize(cols, rows);
  }
  
  kill(session: PTYSession): void {
    session.pty.kill();
  }
}

// Common terminal key sequences
const KEY_SEQUENCES = {
  ENTER: "\r",
  TAB: "\t",
  ESCAPE: "\x1b",
  CTRL_C: "\x03",
  CTRL_D: "\x04",
  CTRL_L: "\x0c",
  CTRL_Z: "\x1a",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
  BACKSPACE: "\x7f",
};
```

## Example Harness: OpenCode

```typescript
class OpenCodeHarness implements AgentHarness {
  name = "opencode";
  version = "1.0.0";
  capabilities = {
    mcp: true,
    streaming: true,
    interrupt: true,
    compact: true,
    multiTurn: true,
    fileEditing: true,
    commandExecution: true,
  };
  
  private ptyManager = new PTYManager();
  
  async spawn(config: SpawnConfig): Promise<HarnessSession> {
    const pty = await this.ptyManager.spawn("opencode", [], config);
    
    // Wait for initial prompt
    await this.waitForPattern(pty, /^>/m, 30000);
    
    return { id: generateId(), pty, harness: this };
  }
  
  async sendPrompt(session: HarnessSession, prompt: string): Promise<void> {
    // OpenCode uses simple text input
    this.ptyManager.write(session.pty, prompt);
    this.ptyManager.sendKey(session.pty, "ENTER");
  }
  
  async waitForResponse(session: HarnessSession, timeout = 300000): Promise<string> {
    // Wait for the prompt to reappear, indicating response complete
    const startIndex = session.pty.buffer.length;
    await this.waitForPattern(session.pty, /^>/m, timeout);
    return session.pty.buffer.slice(startIndex);
  }
  
  async waitForIdle(session: HarnessSession, timeout = 60000): Promise<void> {
    // Wait for no output for 2 seconds
    await this.waitForQuiet(session.pty, 2000, timeout);
  }
  
  async getState(session: HarnessSession): Promise<AgentState> {
    const recentOutput = session.pty.buffer.slice(-500);
    
    if (recentOutput.includes("Error:")) return "error";
    if (recentOutput.includes("[Y/n]") || recentOutput.includes("(yes/no)")) {
      return "waiting_approval";
    }
    if (recentOutput.match(/^>/m)) return "idle";
    return "processing";
  }
  
  async interrupt(session: HarnessSession): Promise<void> {
    this.ptyManager.sendKey(session.pty, "CTRL_C");
  }
  
  async compact(session: HarnessSession): Promise<void> {
    // OpenCode supports /compact command
    await this.sendPrompt(session, "/compact");
    await this.waitForIdle(session);
  }
  
  hasMCP(): boolean {
    return true;
  }
  
  getMCPEndpoint(session: HarnessSession): string {
    // OpenCode exposes MCP on a local socket
    return `unix:/tmp/opencode-${session.id}.sock`;
  }
  
  // Helper methods
  private async waitForPattern(pty: PTYSession, pattern: RegExp, timeout: number): Promise<void> {
    // Implementation
  }
  
  private async waitForQuiet(pty: PTYSession, quietMs: number, timeout: number): Promise<void> {
    // Implementation
  }
}
```

## Example Harness: Claude Code

```typescript
class ClaudeCodeHarness implements AgentHarness {
  name = "claude-code";
  version = "1.0.0";
  capabilities = {
    mcp: true,
    streaming: true,
    interrupt: true,
    compact: true,
    multiTurn: true,
    fileEditing: true,
    commandExecution: true,
  };
  
  async spawn(config: SpawnConfig): Promise<HarnessSession> {
    const pty = await this.ptyManager.spawn("claude", [], config);
    
    // Claude Code has a different startup sequence
    await this.waitForPattern(pty, /Claude Code/i, 10000);
    await this.waitForPattern(pty, />/m, 30000);
    
    return { id: generateId(), pty, harness: this };
  }
  
  async sendPrompt(session: HarnessSession, prompt: string): Promise<void> {
    // Claude Code may need special handling for multi-line prompts
    const lines = prompt.split("\n");
    for (const line of lines) {
      this.ptyManager.write(session.pty, line);
      if (lines.indexOf(line) < lines.length - 1) {
        // Shift+Enter for newline without submit
        this.ptyManager.write(session.pty, "\x1b[13;2u");
      }
    }
    this.ptyManager.sendKey(session.pty, "ENTER");
  }
  
  async getState(session: HarnessSession): Promise<AgentState> {
    const recentOutput = session.pty.buffer.slice(-500);
    
    // Claude Code specific patterns
    if (recentOutput.includes("Do you want to")) return "waiting_approval";
    if (recentOutput.includes("Thinking...")) return "processing";
    if (recentOutput.includes("Running:")) return "executing";
    if (recentOutput.match(/>\s*$/)) return "idle";
    return "processing";
  }
  
  async compact(session: HarnessSession): Promise<void> {
    // Claude Code uses /clear or similar
    await this.sendPrompt(session, "/clear");
    await this.waitForIdle(session);
  }
}
```

## Example Harness: Aider

```typescript
class AiderHarness implements AgentHarness {
  name = "aider";
  version = "1.0.0";
  capabilities = {
    mcp: false,                    // Aider doesn't support MCP
    streaming: true,
    interrupt: true,
    compact: false,
    multiTurn: true,
    fileEditing: true,
    commandExecution: true,
  };
  
  async spawn(config: SpawnConfig): Promise<HarnessSession> {
    // Aider takes file arguments
    const args = ["--yes-always"];  // Auto-confirm file changes
    
    const pty = await this.ptyManager.spawn("aider", args, config);
    await this.waitForPattern(pty, /aider>/i, 30000);
    
    return { id: generateId(), pty, harness: this };
  }
  
  async sendPrompt(session: HarnessSession, prompt: string): Promise<void> {
    this.ptyManager.write(session.pty, prompt);
    this.ptyManager.sendKey(session.pty, "ENTER");
  }
  
  async getState(session: HarnessSession): Promise<AgentState> {
    const recentOutput = session.pty.buffer.slice(-500);
    
    if (recentOutput.includes("aider>")) return "idle";
    if (recentOutput.includes("Commit? [y/n]")) return "waiting_approval";
    return "processing";
  }
  
  hasMCP(): boolean {
    return false;
  }
}
```

## Harness Registry

```typescript
class HarnessRegistry {
  private harnesses = new Map<string, () => AgentHarness>();
  
  register(name: string, factory: () => AgentHarness): void {
    this.harnesses.set(name, factory);
  }
  
  get(name: string): AgentHarness {
    const factory = this.harnesses.get(name);
    if (!factory) {
      throw new Error(`Unknown harness: ${name}`);
    }
    return factory();
  }
  
  list(): string[] {
    return Array.from(this.harnesses.keys());
  }
}

// Default registry
const registry = new HarnessRegistry();
registry.register("opencode", () => new OpenCodeHarness());
registry.register("claude-code", () => new ClaudeCodeHarness());
registry.register("aider", () => new AiderHarness());
registry.register("codex", () => new CodexHarness());
registry.register("roo", () => new RooHarness());
registry.register("kilo", () => new KiloHarness());
registry.register("gemini", () => new GeminiHarness());
```

## Harness Test Suite

Every harness must pass a standard test suite to ensure compatibility:

```typescript
interface HarnessTestSuite {
  name: string;
  tests: HarnessTest[];
}

interface HarnessTest {
  name: string;
  run: (harness: AgentHarness) => Promise<TestResult>;
  timeout: number;
  required: boolean;              // Fail suite if this fails
}

const STANDARD_TESTS: HarnessTest[] = [
  {
    name: "spawn_and_idle",
    required: true,
    timeout: 60000,
    run: async (harness) => {
      const session = await harness.spawn({ workdir: "/tmp/test", env: {}, headless: true });
      const state = await harness.getState(session);
      await harness.kill(session);
      return { pass: state === "idle", details: `State: ${state}` };
    },
  },
  {
    name: "simple_prompt",
    required: true,
    timeout: 120000,
    run: async (harness) => {
      const session = await harness.spawn({ workdir: "/tmp/test", env: {}, headless: true });
      await harness.sendPrompt(session, "What is 2 + 2?");
      const response = await harness.waitForResponse(session);
      await harness.kill(session);
      return { pass: response.includes("4"), details: response.slice(0, 200) };
    },
  },
  {
    name: "file_creation",
    required: true,
    timeout: 180000,
    run: async (harness) => {
      const testDir = await createTempDir();
      const session = await harness.spawn({ workdir: testDir, env: {}, headless: true });
      await harness.sendPrompt(session, "Create a file called hello.txt with the content 'Hello World'");
      await harness.waitForIdle(session);
      await harness.kill(session);
      
      const fileExists = await exists(join(testDir, "hello.txt"));
      const content = fileExists ? await readFile(join(testDir, "hello.txt"), "utf-8") : "";
      return { pass: content.includes("Hello"), details: content };
    },
  },
  {
    name: "interrupt",
    required: false,
    timeout: 60000,
    run: async (harness) => {
      if (!harness.capabilities.interrupt) {
        return { pass: true, details: "Skipped: not supported" };
      }
      const session = await harness.spawn({ workdir: "/tmp/test", env: {}, headless: true });
      await harness.sendPrompt(session, "Count from 1 to 1000000 slowly");
      await sleep(2000);
      await harness.interrupt(session);
      const state = await harness.getState(session);
      await harness.kill(session);
      return { pass: state === "idle", details: `State after interrupt: ${state}` };
    },
  },
  {
    name: "state_detection",
    required: true,
    timeout: 120000,
    run: async (harness) => {
      const session = await harness.spawn({ workdir: "/tmp/test", env: {}, headless: true });
      
      // Should be idle initially
      let state = await harness.getState(session);
      if (state !== "idle") {
        return { pass: false, details: `Expected idle, got ${state}` };
      }
      
      // Should be processing after prompt
      await harness.sendPrompt(session, "Write a haiku about programming");
      await sleep(500);
      state = await harness.getState(session);
      if (state !== "processing" && state !== "executing") {
        return { pass: false, details: `Expected processing, got ${state}` };
      }
      
      await harness.waitForIdle(session);
      state = await harness.getState(session);
      await harness.kill(session);
      return { pass: state === "idle", details: `Final state: ${state}` };
    },
  },
  {
    name: "mcp_connection",
    required: false,
    timeout: 60000,
    run: async (harness) => {
      if (!harness.hasMCP()) {
        return { pass: true, details: "Skipped: MCP not supported" };
      }
      const session = await harness.spawn({ 
        workdir: "/tmp/test", 
        env: {}, 
        headless: true,
        mcpServers: ["test-server"],
      });
      const endpoint = harness.getMCPEndpoint!(session);
      // Try to connect to MCP endpoint
      const connected = await testMCPConnection(endpoint);
      await harness.kill(session);
      return { pass: connected, details: `Endpoint: ${endpoint}` };
    },
  },
];

// Run tests for a harness
async function testHarness(harnessName: string): Promise<TestReport> {
  const harness = registry.get(harnessName);
  const results: TestResult[] = [];
  
  for (const test of STANDARD_TESTS) {
    console.log(`Running ${test.name}...`);
    try {
      const result = await Promise.race([
        test.run(harness),
        sleep(test.timeout).then(() => ({ pass: false, details: "Timeout" })),
      ]);
      results.push({ ...result, name: test.name });
    } catch (error) {
      results.push({ pass: false, name: test.name, details: String(error) });
    }
  }
  
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass && STANDARD_TESTS.find(t => t.name === r.name)?.required);
  
  return {
    harness: harnessName,
    passed,
    total: results.length,
    compatible: failed.length === 0,
    results,
  };
}
```

## Planned Harness Support

| Agent | Priority | Status | Notes |
|-------|----------|--------|-------|
| OpenCode | High | Planned | MCP native, good DX |
| Claude Code | High | Planned | Popular, MCP support |
| Aider | High | Planned | Multiple LLM backends |
| Codex CLI | Medium | Planned | OpenAI official |
| Roo | Medium | Planned | MCP support |
| Gemini CLI | Medium | Planned | Google's offering |
| Kilo | Low | Planned | Newer, needs research |
| Cursor | Low | Deferred | GUI-based, harder to automate |

## Terminal Output Parsing

Handling ANSI escape codes and terminal control sequences:

```typescript
// Strip ANSI escape codes for text analysis
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// Parse terminal output into structured lines
function parseTerminalOutput(raw: string): TerminalLine[] {
  const stripped = stripAnsi(raw);
  return stripped.split("\n").map((line, index) => ({
    text: line,
    raw: raw.split("\n")[index] || "",
    timestamp: new Date(),
  }));
}

// Detect common UI patterns
interface UIPatterns {
  prompt: RegExp;                  // Input prompt
  thinking: RegExp;                // Processing indicator
  approval: RegExp;                // Confirmation request
  error: RegExp;                   // Error message
  success: RegExp;                 // Success message
}

const OPENCODE_PATTERNS: UIPatterns = {
  prompt: /^>\s*$/m,
  thinking: /thinking|processing/i,
  approval: /\[Y\/n\]|\(yes\/no\)/i,
  error: /^Error:|^Failed:/m,
  success: /^Done|^Completed/m,
};
```

## Future: Visual Harnesses

For GUI-based agents like Cursor, consider:

```typescript
interface VisualHarness extends AgentHarness {
  // Additional methods for GUI automation
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  findElement(selector: string): Promise<Element | null>;
}

// Could use Playwright or similar for automation
// Lower priority - focus on terminal-based agents first
```
