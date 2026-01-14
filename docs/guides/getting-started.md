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

# Initialize Octopai (copies arm templates)
bun run src/cli/index.ts init

# Or initialize with a preset configuration
bun run src/cli/index.ts init --preset split-stack
```

### Preset Configurations

When initializing, you can specify a preset to pre-configure arms:

```bash
# Single full-stack arm (minimal setup)
octopai init --preset fullstack

# Frontend + backend split
octopai init --preset split-stack

# Full team with specialists
octopai init --preset full-team
```

### Arm Templates

Octopai includes arm configuration templates in `templates/arms/`:

| Template | Domain | Description |
|----------|--------|-------------|
| `fullstack.toml` | general | Versatile generalist for any task |
| `frontend.toml` | frontend | UI/UX, React, accessibility |
| `backend.toml` | backend | APIs, databases, infrastructure |
| `testing.toml` | testing | QA, test infrastructure |
| `docs.toml` | docs | Documentation specialist |
| `architect.toml` | architect | Code review, patterns |

These templates are copied to `~/.octopai/arms/` during initialization and can be edited before spawning arms.

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

### From Templates

Arm configuration templates are included in the project at `templates/arms/`:

```bash
# List available templates
ls templates/arms/
# fullstack.toml  frontend.toml  backend.toml  testing.toml  docs.toml  architect.toml
```

These templates are copied to `~/.octopai/arms/` when you run `octopai init`.

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

---

## Documentation Sync

Octopai automatically watches your `docs/` directory and keeps arms informed of changes. This ensures that when you update requirements, plans, or architectural decisions, all arms stay synchronized.

### How It Works

1. **File Watching**: The brain watches `docs/` for changes (created, modified, deleted)
2. **Change Detection**: Docs are hashed to detect content changes
3. **Arm Notification**: Arms are notified via MCP tools when relevant docs change
4. **Task Re-evaluation**: When requirements or plans change, pending tasks are re-prioritized

### Documentation Categories

Organize docs in subdirectories for automatic categorization:

```
docs/
├── architecture/    # System design, component details
├── guides/          # How-to guides, tutorials
├── plans/           # Phase plans, sprint goals
├── requirements/    # Feature requirements, specifications
├── decisions/       # ADR (Architectural Decision Records)
└── other/           # Miscellaneous documentation
```

### MCP Tools for Documentation

Arms can use these MCP tools to stay informed:

```bash
# List available documentation
get_documentation()

# Check for changes since last read
check_documentation_changes(since="2024-01-15T10:00:00Z")

# Find docs relevant to current task
find_relevant_docs(task_description="implementing auth flow")
```

### Example Workflow

1. User updates `docs/requirements/auth.md` with new requirements
2. Brain detects change, logs it
3. Next poll cycle re-evaluates pending tasks
4. Arms use `check_documentation_changes` to detect updates
5. Arms use `get_documentation` to re-read updated requirements

### Watching Status

View documentation watcher status:

```bash
# Check if docs are being watched
octopai brain status

# Output includes:
# Documentation: 12 files tracked, last scan: 10:30:00
```

---

## File Watching Workflow

Arms automatically monitor files relevant to their work. When files change, the brain coordinates notifications to keep all arms in sync.

### How It Works

1. **Arms Subscribe**: When an arm starts work, it subscribes to relevant file patterns
2. **Change Detection**: Arms periodically check their subscribed files for changes
3. **Change Reporting**: When a change is detected, the arm reports to the brain
4. **Brain Notification**: The brain notifies all subscribed arms
5. **Impact Assessment**: Each arm assesses if the change affects their work

### MCP Tools for File Watching

Arms use these tools to manage file subscriptions:

```bash
# Subscribe to watch a file or pattern
subscribe_file({
  pattern: "docs/requirements/*.md",
  category: "requirements"
})

# Stop watching a pattern
unsubscribe_file({ pattern: "docs/requirements/*.md" })

# Report a detected change
report_file_change({
  file_path: "docs/requirements/auth.md",
  change_type: "modified",
  summary: "Added OAuth 2.0 requirements",
  impact: "high"
})
```

### Example: Requirements Change Flow

1. User updates `docs/requirements/auth.md` with new OAuth requirements
2. Docs arm detects change via `check_documentation_changes`
3. Docs arm reports to brain: `report_file_change`
4. Brain notifies subscribed arms (frontend-dev, backend-dev)
5. Frontend arm assesses impact on UI components
6. Backend arm assesses impact on API endpoints
7. Affected arms report back if their work needs adjustment

### Notification Types

| Change | Notified Arms | Action |
|--------|---------------|--------|
| docs/requirements/* | All arms | Re-evaluate task alignment |
| docs/plans/* | All arms | Update sprint priorities |
| docs/architecture/* | Architect, backend | Review consistency |
| Source code changes | Related domain arms | Check for regressions |

### For Source Code Arms

When requirements change:

1. You will receive a `file_change_notification` via your arm queue
2. Read the requirements change
3. Assess if your current work is affected
4. Report back to brain if you need to adjust your approach

### For Docs Arms

When monitoring documentation:

1. Periodically check for changes: `check_documentation_changes`
2. Summarize significant changes
3. Report high-impact changes to brain
4. Notify relevant arms if source code needs updates

---

## Documentation Updates from Email

When you reply to emails from Octopai with documentation changes, the brain creates documentation update tasks assigned to "docs" domain arms.

### How It Works

1. **You send an email** with instructions like:
   - "Update the requirements for auth flow"
   - "Update docs to clarify the deployment process"
   - "Revise the API documentation"

2. **Brain detects the intent** and creates a `doc_update` task with high priority

3. **Docs arm picks up the task** and uses MCP tools to update the relevant files:
   - `get_documentation` - Read current docs
   - `update_documentation` - Write updated content
   - `check_documentation_changes` - Track what changed

4. **Other arms are notified** when documentation changes (via documentation watcher)

### Example Email Flow

```
You: "Please update docs/requirements/auth.md to reflect the new OAuth flow"
      (subject: Update auth requirements)

Brain: Creates task "Docs: Update auth requirements" with domain=docs

Docs Arm: Receives task, reads current docs, updates with new OAuth requirements

Brain: Notifies you when complete, other arms detect the change
```

### For Docs Arms

Arms with `domain = "docs"` receive initial tasks to:

1. Review and update project documentation
2. Update requirements based on user feedback
3. Keep docs/architecture/ in sync with implementation

Spawn a docs arm:

```bash
octopai arm spawn --name docs-arm --domain docs
```
