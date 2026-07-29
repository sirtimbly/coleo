# CLI Reference

Complete reference for the `coleo` command-line interface.

## Installation

The CLI is published to npm as `coleo` and runs using the Bun runtime.

```bash
# Requires Bun v1.1+
bun install -g coleo
```

Install with `mise` (project-local setup + initialize):

```bash
mise use bun@latest && MISE_NPM_PACKAGE_MANAGER=bun mise use npm:coleo@latest && mise x -- coleo init --dir ./.coleo
```

Install without `mise` (bootstrap Bun + global `coleo`):

```bash
curl -fsSL https://raw.githubusercontent.com/sirtimbly/coleo/master/bin/install.sh | bash
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

Initialize Coleo in the current project (default: `./.coleo`).

```bash
coleo init [options]

Options:
  -d, --dir &lt;path&gt;  Custom directory (default: ./.coleo)
```

**Examples:**
```bash
# Default project-local initialization
coleo init

# Explicit project-local directory
coleo init --dir ./.coleo

# Custom global directory
coleo init --dir ~/.coleo
```

**What happens:**
1. Creates directory structure (`./.coleo/` by default)
2. Seeds the editable YAML Arm templates in `./.coleo/templates/`
3. Copies the legacy `default.toml` profile to `./.coleo/arms/`
4. Creates `config.toml`
5. Initializes maildir directories
6. Prompts to generate an API token in `.coleo/.env`

**After initialization:**
```bash
# List configured arms
coleo config arms

# Edit an arm configuration
vim ./.coleo/arms/default.toml

# Edit a Spawn Arm template
vim ./.coleo/templates/balanced.yml
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
  --template <name>       Use a template from ./.coleo/arms/ (or your COLEO_DIR)
  --recover               Reattach/recover an existing arm before falling back to restart
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

# Reuse an existing arm if possible, otherwise restart it
coleo arm spawn -n worker --recover
```

#### arm recover

Recover or restart an existing arm using its persisted runtime metadata.

```bash
coleo arm recover <name>
```

The recovery flow is:

1. Reattach if the runtime is still alive and the current agent or harness manager can confirm it.
2. Recover an existing local OpenCode server when `pid` + `port` are still valid.
3. Restart the arm on a live compatible agent (or locally for non-daemon harnesses) when reattachment is not possible.

Examples:

```bash
# Recover a stopped or hung daemon-managed arm
coleo arm recover Nebyx

# Then confirm the unified runtime view
coleo arm status Nebyx
coleo arm watch Nebyx --history 1
```

#### arm list

List all registered arms.

```bash
coleo arm list
```

The list view shows the runtime-derived state and the age of the last output seen for each arm. Use
`coleo arm status <name>` for the full runtime summary, including heartbeat age, activity age, and
the recovery signals the API is using.

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
This is a legacy/local workflow. For production human email, use the required Postmark-style gateway flow with fixed sender/receiver addresses.

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
Directory: /absolute/path/to/your-project/.coleo

System: ok (vX.Y.Z)
Infrastructure:
  Database: ✓ Healthy
Arms: 3 total
Proposals: 2 open
Activity: 42 events (24h)
```

---

## config

Manage Coleo arm configuration files in `./.coleo/arms/` by default.

#### config arms

List configured arms in `./.coleo/arms/` by default.

```bash
coleo config arms
```

**Output:**
```
Arm Configurations:

  default-arm [general]
```

---

## Environment Variables

| Variable            | Description             | Default    |
| ------------------- | ----------------------- | ---------- |
| `COLEO_DIR`         | Coleo data directory    | `./.coleo` |
| `COLEO_API_KEY`     | API key for Observatory | (none)     |
| `ANTHROPIC_API_KEY` | For Claude-based agents | (none)     |
| `OPENAI_API_KEY`    | For GPT-based agents    | (none)     |

## Configuration File

Configuration is stored in `./.coleo/config.toml` by default:

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

Arms can be configured via TOML files in `./.coleo/arms/` by default. Each file defines an arm's domain, personality, and context preferences.

### Arm Config File Structure

```toml
# ./.coleo/arms/&lt;name&gt;.toml

[arm]
name = "my-arm"
# Optional legacy focus hint; behavior is primarily driven by task classification
# and history rather than static domains.
domain = "frontend"  # general, frontend, backend, infrastructure, etc.
harness = "opencode"  # Agent harness type

[context]
budget = 300000       # Max context tokens
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

### Default Arm Configuration

Initialization writes a single starter config:

```bash
./.coleo/arms/default.toml
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
