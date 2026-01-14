# CLI Reference

Complete reference for the `octopai` command-line interface.

## Global Options

```bash
octopai [command] [options]

Options:
  -V, --version  Output version number
  -h, --help     Display help
```

## Commands

### init

Initialize Octopai in your home directory.

```bash
octopai init [options]

Options:
  -d, --dir <path>  Custom directory (default: ~/.octopai)
```

**Example:**
```bash
# Default location
octopai init

# Custom location
octopai init --dir ~/my-octopai
```

---

### brain

Manage the Octopai brain.

#### brain run

Run the brain polling loop in the foreground.

```bash
octopai brain run [options]

Options:
  -i, --interval <ms>  Poll interval in milliseconds (default: 30000)
  -v, --verbose        Verbose output
  --once               Run a single poll cycle and exit
```

**Examples:**
```bash
# Normal operation
octopai brain run

# Faster polling for development
octopai brain run --interval 5000

# Single poll for testing
octopai brain run --once
```

#### brain status

Show brain status.

```bash
octopai brain status
```

**Output:**
```
Brain Status:
  Status: running
  Last poll: 2024-01-15 10:30:00
  Poll interval: 30000ms
  Active arms: 3
  Pending tasks: 2
  Completed today: 5
```

---

### arm

Manage arms (AI agents).

#### arm spawn

Spawn a new arm.

```bash
octopai arm spawn [options]

Options:
  -n, --name <name>       Arm name/ID (required)
  -a, --agent <agent>     Agent type: opencode, claude-code, aider (default: opencode)
  -w, --workdir <path>    Working directory (default: current directory)
  -t, --terminal <type>   Terminal: auto, ghostty, iterm2, terminal, wezterm, kitty, tmux, headless
  -p, --prompt <prompt>   Initial prompt/task for the agent
  --headless              Run in headless mode (no terminal window)
```

**Examples:**
```bash
# Basic spawn
octopai arm spawn --name explorer --agent opencode

# With specific terminal
octopai arm spawn -n ui-worker -a opencode -t ghostty

# Headless (for containers/SSH)
octopai arm spawn -n worker --headless

# With initial task
octopai arm spawn -n fixer -p "Find and fix all TypeScript errors"
```

#### arm list

List all registered arms.

```bash
octopai arm list
```

**Output:**
```
Arms:
  ● explorer (opencode) - working [Current task description]
  ◐ ui-worker (opencode) - busy
  ○ fixer (opencode) - idle
```

Status indicators:
- `●` - Running/idle
- `◐` - Busy
- `○` - Stopped/starting

#### arm kill

Kill an arm.

```bash
octopai arm kill <name>
```

**Example:**
```bash
octopai arm kill explorer
```

---

### mail

View and send mail.

#### mail inbox

List messages in the inbox.

```bash
octopai mail inbox [options]

Options:
  -n, --count <n>  Number of messages to show (default: 10)
```

**Output:**
```
Inbox:
  ● [2024-01-15] Task completed: Add dark mode toggle
    [2024-01-14] Discovery: Found unused dependencies
    [2024-01-14] Request: Need approval for package update
```

#### mail send

Send a message to the brain.

```bash
octopai mail send <message> [options]

Options:
  -s, --subject <subject>  Message subject
```

**Examples:**
```bash
# Simple task
octopai mail send "Add user authentication to the API"

# With custom subject
octopai mail send "We need OAuth support" -s "Feature: OAuth"
```

#### mail read

Read a specific message.

```bash
octopai mail read <id>
```

**Example:**
```bash
octopai mail read abc123
```

**Output:**
```
From: explorer@octopai.local
To: human@local
Subject: Task completed: Add dark mode toggle
Date: 2024-01-15 10:30:00
---
I've implemented the dark mode toggle in the settings page.

Changes made:
- Added ThemeContext provider
- Created DarkModeToggle component
- Updated CSS variables for dark theme

Files modified:
- src/contexts/ThemeContext.tsx
- src/components/settings/DarkModeToggle.tsx
- src/styles/themes.css
```

---

### mcp

MCP server commands.

#### mcp serve

Run the MCP server (used internally by arms).

```bash
octopai mcp serve
```

This command is typically not run directly - it's invoked by arms when they connect.

---

### status

Show overall Octopai status.

```bash
octopai status
```

**Output:**
```
Octopai Status
Directory: ~/.octopai

Brain: running (last poll: 10:30:00)
Arms: 3
  - explorer: working
  - ui-worker: idle
  - fixer: busy
Inbox: 2 unread
Tasks: 3 pending, 1 in progress
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OCTOPAI_DIR` | Octopai data directory | `~/.octopai` |
| `OCTOPAI_API_KEY` | API key for Observatory | (none) |
| `ANTHROPIC_API_KEY` | For Claude-based agents | (none) |
| `OPENAI_API_KEY` | For GPT-based agents | (none) |

## Configuration File

Configuration is stored in `~/.octopai/config.toml`:

```toml
version = 1

[brain]
poll_interval_ms = 30000
max_arms = 10

[mail]
from_address = "brain@octopai.local"
digest_schedule = "daily"

[terminal]
emulator = "auto"

# Optional: Gitea integration
# [gitea]
# url = "http://localhost:3000"
# token = "your-token-here"
```

## Shell Aliases

Add these to your `.bashrc` or `.zshrc` for convenience:

```bash
alias oc="bun run ~/octopai/src/cli/index.ts"
alias brain="oc brain run"
alias spawn="oc tentacle spawn"
alias status="oc status"
alias inbox="oc mail inbox"
```
