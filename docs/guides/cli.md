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
  --preset <name>   Load a preset configuration (fullstack, split-stack, full-team)
```

**Examples:**
```bash
# Default initialization
octopai init

# With split-stack preset
octopai init --preset split-stack

# Custom directory
octopai init --dir ~/my-octopai
```

**What happens:**
1. Creates directory structure (`~/.octopai/`)
2. Copies arm templates to `~/.octopai/arms/`
3. Creates `config.toml`
4. Initializes maildir directories

**After initialization:**
```bash
# List configured arms
octopai config arms

# Load a different preset
octopai config load full-team

# Edit an arm configuration
vim ~/.octopai/arms/my-arm.toml
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

Spawn a new arm. Runs interactively if no arguments provided.

```bash
octopai arm spawn [options]

Options:
  -n, --name <name>       Arm name/ID
  -a, --agent <agent>     Agent type: opencode, claude-code, aider (default: opencode)
  -d, --domain <domain>   Arm domain: general, frontend, backend, testing, docs, architect
  -w, --workdir <path>    Working directory
  -t, --terminal <type>   Terminal: ghostty, iterm2, terminal, tmux, headless
  -p, --prompt <prompt>   Initial task/prompt for the arm
  --provider <provider>   AI provider (e.g., anthropic, openai)
  --model <model>         Model name (e.g., claude-sonnet-4-20250514)
  --template <name>       Use template from ~/.octopai/arms/
```

**Interactive Mode (no arguments):**

When run without `--name`, you'll be prompted interactively:

```bash
octopai arm spawn

=== Arm Configuration ===

Would you like to use an arm template? [Y/n] y
Select a template:
  1. fullstack-dev [general] - Versatile generalist for any task
  2. frontend-dev [frontend] - UI/UX specialist
  3. backend-dev [backend] - API/database specialist
  4. Custom arm (no template)
Select: 1

Select agent type:
  1. opencode
  2. claude-code
  3. aider
Select: 1

Working directory [/Users/user/project]:
Configure provider/model? [y/N] y
Provider (anthropic, openai, github-copilot): anthropic
Model [optional]: claude-sonnet-4-20250514

=== Spawning Arm ===
  Name: fullstack-dev
  Agent: opencode
  Domain: general
  Workdir: /Users/user/project
  Provider: anthropic
  Model: claude-sonnet-4-20250514
```

**Examples:**
```bash
# Basic spawn
octopai arm spawn --name explorer --agent opencode

# Using a template
octopai arm spawn --template frontend-dev --name ui-specialist

# With provider and model
octopai arm spawn -n my-arm -a opencode --provider anthropic --model claude-opus-4

# In terminal window
octopai arm spawn -n worker --terminal ghostty
```

**Templates:**

Templates from `~/.octopai/arms/*.toml` are shown in interactive mode. When using `--template`, the arm will use template values for domain, harness, context budget, and other settings, which can be overridden by explicit arguments.

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

#### arm prompt

Send a prompt/message to a running arm.

```bash
octopai arm prompt <name> <message> [options]

Options:
  -i, --interrupt  Send escape key twice before prompt to cancel/interrupt current work
```

**Examples:**
```bash
# Send a task to an arm
octopai arm prompt explorer "Please add error handling to the API routes"

# Interrupt current work and send new instructions
octopai arm prompt explorer "Stop what you're doing and fix the critical bug in auth.ts" --interrupt
```

**Notes:**
- The arm must be running (status: idle or busy)
- Without `--interrupt`, the message is queued after current work
- With `--interrupt`, two ESC keys are sent first to cancel any in-progress operation, then the new prompt is sent

#### arm logs

View recent logs from an arm.

```bash
octopai arm logs <name> [options]

Options:
  -n, --lines <n>  Number of lines to show (default: 50)
  -f, --follow     Follow log output (tail -f style)
```

**Example:**
```bash
# View last 50 lines
octopai arm logs explorer

# View last 100 lines
octopai arm logs explorer -n 100
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

### imap

IMAP server commands for accessing Octopai mail with any email client.

#### imap serve

Start the IMAP server.

```bash
octopai imap serve [options]

Options:
  -p, --port <port>          IMAP server port (default: 1143)
  -h, --host <host>          IMAP server host (default: 127.0.0.1)
  -u, --username <username>  IMAP username (default: octopai)
  --password <password>      IMAP password (auto-generated if not provided)
```

**Examples:**
```bash
# Start with defaults
octopai imap serve

# Custom port
octopai imap serve --port 993

# Allow external connections (use with caution)
octopai imap serve --host 0.0.0.0
```

**Output:**
```
Starting IMAP server...
  Host: 127.0.0.1
  Port: 1143
  Username: octopai
  Password: abc123...

Connect with your email client using:
  Server: 127.0.0.1
  Port: 1143
  Security: None (local only)
  Username: octopai
  Password: abc123...
```

**Configuring Email Clients:**

For Apple Mail:
1. Add new account → Other Mail Account
2. Server: 127.0.0.1, Port: 1143
3. Connection Security: None
4. Username: octopai
5. Password: (from output above)

For Thunderbird:
1. Settings → Account Settings → Account Actions → Add Mail Account
2. Manual config: IMAP, Server: 127.0.0.1:1143, SSL: None
3. Username: octopai
4. Password: (from output above)

#### imap password

Show or reset the IMAP password.

```bash
octopai imap password [options]

Options:
  -r, --reset  Generate a new password
```

**Examples:**
```bash
# Show current password
octopai imap password

# Reset password
octopai imap password --reset
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

## config

Manage Octopai configuration, including arm templates and presets.

#### config presets

List available arm configuration presets.

```bash
octopai config presets
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

Usage: octopai init --preset <name>
       octopai config load <name>
```

#### config load <preset>

Load an arm configuration preset into `~/.octopai/arms/`.

```bash
octopai config load <preset>
```

**Presets:**
- `fullstack` - Single generalist arm
- `split-stack` - Frontend + backend
- `full-team` - All specialists

**Example:**
```bash
octopai config load split-stack
```

#### config arms

List configured arms in `~/.octopai/arms/`.

```bash
octopai config arms
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
alias spawn="oc arm spawn"
alias arms="oc arm list"
alias status="oc status"
alias inbox="oc mail inbox"
```

---

## Arm Configuration

Arms can be configured via TOML files in `~/.octopai/arms/`. Each file defines an arm's domain, personality, and context preferences.

### Arm Config File Structure

```toml
# ~/.octopai/arms/<name>.toml

[arm]
name = "my-arm"
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

### Domain Types

| Domain | Description |
|--------|-------------|
| `general` | Full-stack, handles any task |
| `frontend` | UI/UX, React, CSS, accessibility |
| `backend` | APIs, databases, services |
| `infrastructure` | DevOps, CI/CD, deployment |
| `testing` | Test infrastructure, QA |
| `architect` | Code review, patterns, decisions |

### Preset Configurations

Load preset arm configurations:

```bash
# List available presets
octopai config presets

# Load a preset (creates arm config files)
octopai config load preset fullstack
octopai config load preset split-stack
octopai config load preset full-team
```

### Managing Arm Configs

```bash
# List configured arms
octopai config arms

# Show arm configuration
octopai config arms show my-arm

# Edit arm configuration (opens in editor)
octopai config arms edit my-arm

# Delete an arm configuration
octopai config arms remove my-arm
```

### Spawning with Config

```bash
# Spawn using a saved configuration
octopai arm spawn --name my-arm --config my-arm

# Override config values at spawn time
octopai arm spawn -n specialist --domain backend --workdir ~/api
```
