# Getting Started

This guide will help you set up Octopai and run your first brain + arm session.

## Prerequisites

- [Bun](https://bun.sh/) v1.0+ installed
- Git
- (Optional) Docker for containerized deployment

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/your-username/octopai
cd octopai

# Install dependencies
bun install

# Initialize Octopai
bun run src/cli/index.ts init
```

### Verify Installation

```bash
bun run src/cli/index.ts status
```

You should see:
```
Octopai Status
Directory: ~/.octopai

Brain: not started
Arms: 0
Inbox: 0 unread
Tasks: 0
```

## Directory Structure

After initialization, Octopai creates this structure:

```
~/.octopai/
├── mail/              # Human-agent communication (Maildir)
│   ├── inbox/
│   ├── sent/
│   ├── drafts/
│   └── archive/
├── queue/             # Inter-agent message queue
│   └── brain/
│       ├── pending/
│       └── processed/
├── state/             # Persistent state
│   ├── brain.json
│   ├── tasks.json
│   ├── arms/
│   └── notes/
├── mcp/               # MCP configurations
├── logs/              # Log files
└── config.toml        # Configuration
```

## Running the Brain

The brain is the central coordinator. Run it in the foreground to see what's happening:

```bash
bun run src/cli/index.ts brain run
```

You'll see output like:
```
Brain starting...
Polling every 30000ms
Press Ctrl+C to stop

[10:30:00] Polling... 0 messages, 0 tasks
[10:30:30] Polling... 0 messages, 0 tasks
```

### Single Poll Cycle

For testing, you can run a single poll cycle:

```bash
bun run src/cli/index.ts brain run --once
```

## Spawning an Arm

With the brain running (in another terminal), spawn an arm:

```bash
bun run src/cli/index.ts arm spawn \
  --name explorer \
  --agent opencode \
  --workdir ~/projects/my-project
```

This will:
1. Create MCP configuration for the arm
2. Open a new terminal window (or tmux session in headless mode)
3. Start the AI agent with Octopai MCP connected

## Arm Configurations

Arms can be configured for different patterns of work distribution. The brain assigns tasks based on arm domains and availability.

### Full-Stack Arms (Default)

By default, arms are "generalist" and can work on any part of your codebase:

```bash
# Spawn a full-stack arm
octopai arm spawn --name fullstack-dev --domain general

# Or explicitly
octopai arm spawn --name fullstack-dev --domain fullstack
```

A full-stack arm will handle both frontend and backend tasks as assigned by the brain.

### Split-Stack Configuration

For larger projects, you can run specialized arms that focus on specific layers:

```bash
# Frontend specialist
octopai arm spawn --name frontend-arm --domain frontend

# Backend specialist  
octopai arm spawn --name backend-arm --domain backend

# Database/ infrastructure specialist
octopai arm spawn --name infra-arm --domain infrastructure
```

The brain will match tasks to the appropriate specialist arm based on the task context.

### Preset Configurations

Octopai includes preset configurations for common setups. Load a preset:

```bash
# Single full-stack arm (minimal setup)
octopai config load preset fullstack

# Multi-arm with frontend/backend split
octopai config load preset split-stack

# Full team with specialists
octopai config load preset full-team
```

### Custom Arm Profiles

Create custom arm profiles in `~/.octopai/arms/` with domain-specific settings:

```toml
# ~/.octopai/arms/frontend-specialist.toml
[arm]
name = "frontend-specialist"
domain = "frontend"
harness = "opencode"

[context]
budget = 150000
priority_files = [
  "src/web/**",
  "*.css",
  "*.tsx"
]

[personality]
traits = "Detail-oriented, UX-focused, advocates for accessibility"

[convictions]
core = [
  "Accessibility is not optional",
  "Performance is a feature",
  "Component reusability matters"
]
```

### Configuration Priority

The brain considers multiple factors when assigning tasks:

1. **Domain match** - Task keywords vs arm domain
2. **Availability** - Idle arms preferred over busy ones
3. **Workload** - Arms with fewer active claims get priority
4. **Context budget** - Arms with remaining budget for the task scope

### Switching Configurations

To switch between configurations:

```bash
# List available configurations
octopai config list

# Load a different configuration set
octopai config load my-custom-setup

# This replaces all arms with the new configuration
# Existing arm processes continue until manually killed
```

## Sending a Task

Send a task to the brain via the mail interface:

```bash
bun run src/cli/index.ts mail send "Add a dark mode toggle to the settings page"
```

The brain will:
1. Pick up the message on the next poll
2. Parse it as a new task
3. Assign it to an available arm

## Checking Status

View the current status:

```bash
bun run src/cli/index.ts status
```

Output:
```
Octopai Status
Directory: ~/.octopai

Brain: running (last poll: 10:30:30)
Arms: 1
  - explorer: working [Add dark mode toggle]
Inbox: 0 unread
Tasks: 1 pending
```

## Viewing the Inbox

Check messages from arms:

```bash
bun run src/cli/index.ts mail inbox
```

## Docker Deployment

For a containerized setup with Gitea:

```bash
# Copy environment template
cp .env.example .env

# Edit with your API keys
vim .env

# Start the stack
docker compose up -d

# SSH into the container
ssh -p 2222 octopai@localhost  # password: octopai

# Inside container
octopai brain run
```

See the [Docker Setup Guide](./docker) for more details.

## Next Steps

- [CLI Reference](./cli) - All available commands
- [Docker Setup](./docker) - Containerized deployment
- [Architecture Overview](/architecture/overview) - System design
