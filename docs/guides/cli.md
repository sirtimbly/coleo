# CLI Reference

Complete reference for the `coleo` command-line interface.

## Installation

The CLI is published to npm as `coleo` and runs using the Bun runtime.

```bash
# Requires Bun v1.1+
bun install -g coleo
```

## Global Options

```bash
coleo [command] [options]

Options:
  -V, --version  Output version number
  -h, --help     Display help
```

## Commands

### init

Initialize Coleo in your home directory.

```bash
coleo init [options]

Options:
  -d, --dir &lt;path&gt;  Custom directory (default: ~/.coleo)
  --preset &lt;name&gt;   Load a preset configuration (fullstack, split-stack, full-team)
```

**Examples:**
```bash
# Default initialization
coleo init

# With split-stack preset
coleo init --preset split-stack

# Custom directory
coleo init --dir ~/my-coleo
```

**What happens:**
1. Creates directory structure (`~/.coleo/`)
2. Copies arm templates to `~/.coleo/arms/`
3. Creates `config.toml`
4. Initializes maildir directories

**After initialization:**
```bash
# List configured arms
coleo config arms

# Load a different preset
coleo config load full-team

# Edit an arm configuration
vim ~/.coleo/arms/my-arm.toml
```

---

### brain

Manage the Coleo brain.

#### brain run

Run the brain polling loop in the foreground.

```bash
coleo brain run [options]

Options:
  -i, --interval <ms>  Poll interval in milliseconds (default: 30000)
  -v, --verbose        Verbose output
  --once               Run a single poll cycle and exit
```

**Examples:**
```bash
# Normal operation
coleo brain run

# Faster polling for development
coleo brain run --interval 5000

# Single poll for testing
coleo brain run --once
```

#### brain status

Show brain status.

```bash
coleo brain status
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

Spawn a new arm. Runs interactively if no arguments provided.

```bash
coleo arm spawn [options]

Options:
  -n, --name <name>       Arm name/ID (auto-generates a sci-fi name if not provided)
  -w, --workdir <path>    Working directory (default: current directory)
  -t, --terminal <type>   Terminal emulator: ghostty, iterm2, terminal, tmux (uses opencode-tui)
  -p, --prompt <prompt>   Initial prompt/task for the agent
  --harness <harness>     Harness: opencode-api, opencode-tui, opencode
  --provider <provider>   AI provider (e.g., anthropic, openai, github-copilot, opencode-zen)
  --model <model>         Model name (e.g., gpt-5.1-codex-mini)
  --template <name>       Use a template from ~/.coleo/arms/
  --recover               Attempt to recover an existing OpenCode server
  --watch                 Watch the arm's conversation in real-time after spawning
```

**Interactive Mode (no arguments):**

When run without `--name`, you'll be prompted interactively:

```bash
coleo arm spawn

=== Arm Configuration ===

Arm name [Varek-9]:
Working directory [/Users/user/project]:
Provider [optional]: anthropic
Model [optional]: claude-sonnet-4

=== Spawning Arm ===
  Name: Varek-9
  Workdir: /Users/user/project
  Provider: anthropic
  Model: claude-sonnet-4
```

**Examples:**
```bash
# Basic spawn
coleo arm spawn --name explorer --harness opencode-api

# With provider/model
coleo arm spawn -n my-arm --provider anthropic --model claude-opus-4

# In terminal window
coleo arm spawn -n worker --terminal ghostty
```

#### arm list

List all registered arms.

```bash
coleo arm list
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
coleo arm kill <name>
```

**Example:**
```bash
coleo arm kill explorer
```

#### arm prompt

Send a prompt/message to a running arm.

```bash
coleo arm prompt &lt;name&gt; &lt;message&gt; [options]
```


**Examples:**
```bash
# Send a task to an arm
coleo arm prompt explorer "Please add error handling to the API routes"

# Interrupt current work and send new instructions
coleo arm prompt explorer "Stop what you're doing and fix the critical bug in auth.ts" --interrupt
```

**Notes:**
- The arm must be running (status: idle or busy)
- Without `--interrupt`, the message is queued after current work
- With `--interrupt`, two ESC keys are sent first to cancel any in-progress operation, then the new prompt is sent

#### arm logs

View recent logs from an arm.

```bash
coleo arm logs &lt;name&gt; [options]
```


**Example:**
```bash
# View last 50 lines
coleo arm logs explorer

# View last 100 lines
coleo arm logs explorer -n 100
```

---

### mail

View and send mail.

#### mail inbox

List messages in the inbox.

```bash
coleo mail inbox [options]

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
coleo mail send <message> [options]

Options:
  -s, --subject <subject>  Message subject
```


**Examples:**
```bash
# Simple task
coleo mail send "Add user authentication to the API"

# With custom subject
coleo mail send "We need OAuth support" -s "Feature: OAuth"
```

#### mail read

Read a specific message.

```bash
coleo mail read &lt;id&gt;
```

**Example:**
```bash
coleo mail read abc123
```

**Output:**
```text
From: explorer@coleo.local
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

### imap


IMAP server commands for accessing Coleo mail with any email client.

#### imap serve

Start the IMAP server.

```bash
coleo imap serve [options]

Options:
  -p, --port &lt;port&gt;          IMAP server port (default: 1143)
  -h, --host &lt;host&gt;          IMAP server host (default: 127.0.0.1)
  -u, --username &lt;username&gt;  IMAP username (default: coleo)
  --password &lt;password&gt;      IMAP password (auto-generated if not provided)
```

**Examples:**
```bash
# Start with defaults
coleo imap serve

# Custom port
coleo imap serve --port 993

# Allow external connections (use with caution)
coleo imap serve --host 0.0.0.0
```

**Output:**
```
Starting IMAP server...
  Host: 127.0.0.1
  Port: 1143
  Username: coleo
  Password: abc123...

Connect with your email client using:
  Server: 127.0.0.1
  Port: 1143
  Security: None (local only)
  Username: coleo
  Password: abc123...
```

**Configuring Email Clients:**

For Apple Mail:
1. Add new account → Other Mail Account
2. Server: 127.0.0.1, Port: 1143
3. Connection Security: None
4. Username: coleo
5. Password: (from output above)

For Thunderbird:
1. Settings → Account Settings → Account Actions → Add Mail Account
2. Manual config: IMAP, Server: 127.0.0.1:1143, SSL: None
3. Username: coleo
4. Password: (from output above)

#### imap password

Show or reset the IMAP password.

```bash
coleo imap password [options]

Options:
  -r, --reset  Generate a new password
```

**Examples:**
```bash
# Show current password
coleo imap password

# Reset password
coleo imap password --reset
```

**Available Mailboxes:**
- `INBOX` - Messages from arms and brain
- `SENT` - Messages you've sent
- `DRAFTS` - Draft messages
- `ARCHIVE` - Archived messages

---

### mcp

MCP server commands.

#### mcp serve

Run the MCP server (used internally by arms).

```bash
coleo mcp serve
```

This command is typically not run directly - it's invoked by arms when they connect.

---

### status

Show overall Coleo status.

```bash
coleo status
```

**Output:**
```
Coleo Status
Directory: ~/.coleo

Brain: running (last poll: 10:30:00)
Arms: 3
  - explorer: working
  - ui-worker: idle
  - fixer: busy
Inbox: 2 unread
Tasks: 3 pending, 1 in progress
```

---

## config

Manage Coleo configuration, including arm templates and presets.

#### config presets

List available arm configuration presets.

```bash
coleo config presets
```

**Output:**
```
Available Presets:

  fullstack
    Single generalist arm for small projects

  split-stack
    Frontend + backend specialist arms

  full-team
    Full team: frontend, backend, testing, docs, architect

Usage: coleo init --preset <name>
       coleo config load <name>
```

#### config load &lt;preset&gt;

Load an arm configuration preset into `~/.coleo/arms/`.

```bash
coleo config load <preset>
```

**Presets:**
- `fullstack` - Single generalist arm
- `split-stack` - Frontend + backend
- `full-team` - All specialists

**Example:**
```bash
coleo config load split-stack
```

#### config arms

List configured arms in `~/.coleo/arms/`.

```bash
coleo config arms
```

**Output:**
```
Arm Configurations:

  fullstack-dev [general]
  frontend-dev [frontend]
  backend-dev [backend]
```

---

## Environment Variables

| Variable            | Description             | Default    |
| ------------------- | ----------------------- | ---------- |
| `OCTOPAI_DIR`       | Coleo data directory    | `~/.coleo` |
| `OCTOPAI_API_KEY`   | API key for Observatory | (none)     |
| `ANTHROPIC_API_KEY` | For Claude-based agents | (none)     |
| `OPENAI_API_KEY`    | For GPT-based agents    | (none)     |

## Configuration File

Configuration is stored in `~/.coleo/config.toml`:

```toml
version = 1

[brain]
poll_interval_ms = 30000
max_arms = 10

[mail]
from_address = "brain@coleo.local"
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
alias oc="coleo"
alias brain="coleo brain run"
alias spawn="coleo arm spawn"
alias arms="coleo arm list"
alias status="coleo status"
alias inbox="coleo mail inbox"
```

---

## Arm Configuration

Arms can be configured via TOML files in `~/.coleo/arms/`. Each file defines an arm's domain, personality, and context preferences.

### Arm Config File Structure

```toml
# ~/.coleo/arms/&lt;name&gt;.toml

[arm]
name = "my-arm"
# Optional legacy focus hint; behavior is primarily driven by task classification
# and history rather than static domains.
domain = "frontend"  # general, frontend, backend, infrastructure, etc.
harness = "opencode"  # Agent harness type

[context]
budget = 100000       # Max context tokens
priority_files = [    # Files this arm should focus on
  "src/web/**",
  "*.tsx",
  "*.css"
]

[personality]
traits = "Detail-oriented, UX-focused developer"

[convictions]
core = [
  "Clean code is maintainable code",
  "Tests prevent regressions"
]
```

### Legacy Domain Types

These domains were used as coarse focus hints for arms. In the current design, arms are general-purpose and behavior is primarily guided by task classification and history.

| Domain           | Description                      |
| ---------------- | -------------------------------- |
| `general`        | Full-stack, handles any task     |
| `frontend`       | UI/UX, React, CSS, accessibility |
| `backend`        | APIs, databases, services        |
| `infrastructure` | DevOps, CI/CD, deployment        |
| `testing`        | Test infrastructure, QA          |
| `architect`      | Code review, patterns, decisions |

### Preset Configurations (Legacy team shapes)

Load preset arm configurations:

```bash
# List available presets
coleo config presets

# Load a preset (creates arm config files)
coleo config load preset fullstack
coleo config load preset split-stack
coleo config load preset full-team
```

### Managing Arm Configs

```bash
# List configured arms
coleo config arms

# Show arm configuration
coleo config arms show my-arm

# Edit arm configuration (opens in editor)
coleo config arms edit my-arm

# Delete an arm configuration
coleo config arms remove my-arm
```

### Spawning with Config

```bash
# Spawn using a saved configuration
coleo arm spawn --name my-arm --config my-arm

# Override config values at spawn time
coleo arm spawn -n specialist --domain backend --workdir ~/api
```
