# Octopai

AI agent orchestrator using the **Octopus Model** - semi-autonomous AI "arms" coordinated by a central brain, with human-agent communication via mail.

## Quick Start

```bash
# Install dependencies
bun install

# Initialize Octopai
bun run src/cli/index.ts init

# Start the brain (foreground)
bun run src/cli/index.ts brain run

# In another terminal, spawn an arm
bun run src/cli/index.ts arm spawn --name explorer --harness opencode

# Send a task via mail
bun run src/cli/index.ts mail send "Add dark mode toggle to settings"

# Check status
bun run src/cli/index.ts status
```

## Docker Quick Start

Run Octopai in a container with SSH access:

```bash
# Copy env file and add your API keys
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY, etc.

# Build and start
docker compose up -d

# SSH into the container
ssh -p 2222 octopai@localhost  # password: octopai

# Inside the container:
octopai brain run                              # Start the brain
octopai arm spawn -n coder --harness opencode  # Spawn in tmux
octopai status                                 # Check status

# View arm logs (headless mode)
tail -f ~/.octopai/logs/octopai_coder.log
```

Ports:
- **2222**: Octopai SSH
- **3000**: Gitea web UI
- **2223**: Gitea git SSH

## Architecture

See [NOTES.md](./NOTES.md) for detailed architecture documentation.

```
Human (You)
    │
    ▼
┌─────────┐
│ Maildir │ ◄── himalaya/luk reads this
└────┬────┘
     │
┌────▼────┐
│  Brain  │ ← Polling loop, MCP server
└────┬────┘
     │
┌────┴────┬─────────┐
▼         ▼         ▼
Arm       Arm       Arm
(opencode)(claude)  (aider)
```

## Commands

```bash
octopai init                    # Initialize ~/.octopai
octopai brain run               # Start brain (foreground)
octopai brain run --once        # Single poll cycle
octopai arm spawn -n NAME       # Spawn an arm
octopai arm spawn -n NAME --headless  # Spawn without terminal window
octopai arm list                # List arms
octopai mail inbox              # View inbox
octopai mail send "task"        # Send task to brain
octopai status                  # Overall status
octopai mcp serve               # Run MCP server (for arms)
```

## Headless Mode

In environments without a display (Docker, SSH), arms run in headless mode:

- **tmux**: If available, creates a tmux session (attach with `tmux attach -t arm_name`)
- **headless**: Runs as background process, logs to `~/.octopai/logs/`

Force headless mode with `--headless` flag:

```bash
octopai arm spawn -n worker --harness opencode --headless
```

## Local Development

### Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- [NATS Server](https://nats.io/) with JetStream enabled (optional, for event streaming)
- [OpenCode](https://opencode.ai/) CLI (for spawning AI arms)

### Setup

```bash
# Clone and install dependencies
git clone <repo-url>
cd octopai
bun install

# Initialize Octopai (creates ~/.octopai directory and database)
bun run src/cli/index.ts init

# Build the web UI
bun run web:build
```

### Running Locally

```bash
# Start the API server (serves both API and web UI)
bun run server

# Or run the brain directly (includes API server)
bun run brain

# Development mode for web UI (hot reload)
bun run web:dev
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Run CLI commands directly |
| `bun run brain` | Start the brain orchestrator |
| `bun run server` | Start the API server |
| `bun run typecheck` | Run TypeScript type checking |
| `bun run test` | Run unit tests |
| `bun run test:watch` | Run unit tests in watch mode |
| `bun run test:integration` | Run quick integration tests |
| `bun run test:e2e` | Run full end-to-end regression tests |
| `bun run web:dev` | Start web UI dev server (hot reload) |
| `bun run web:build` | Build web UI for production |
| `bun run docs:dev` | Start documentation dev server |

### Environment Variables

Create a `.env` file in the project root:

```bash
# Required for AI arms
ANTHROPIC_API_KEY=your-key-here
OPENAI_API_KEY=your-key-here      # Optional

# Optional configuration
OCTOPAI_PORT=7337                  # API server port (default: 7337)
OCTOPAI_DB_PATH=~/.octopai/octopai.db  # Database location
NATS_URL=nats://localhost:4222    # NATS server URL
```

## Testing

Octopai has three levels of testing:

### Unit Tests

Fast, isolated tests for individual modules.

```bash
# Run all unit tests
bun run test

# Run in watch mode during development
bun run test:watch

# Run tests for a specific module
bun test src/mcp/__tests__/
bun test src/api/__tests__/
bun test src/brain/__tests__/
```

### Integration Tests

Standalone scripts for quick manual verification of specific features. These are **not** run by `test:integration` - they're meant for ad-hoc testing during development.

```bash
# Session isolation test - verifies each arm gets a unique session
# (Self-contained: starts its own API server)
bun run test-session-isolation.ts

# JetStream pattern test - verifies multi-part event subjects work
# Requires: nats-server -js (running separately)
bun run test-jetstream-pattern.ts

# Task assignment test
bun run test-task-assignment.ts
```

### Regression Tests

Comprehensive test suite that runs scenarios against multiple AI models. Use `test:integration` for quick checks or `test:e2e` for full coverage.

```bash
# Quick regression tests (only scenarios tagged 'quick')
bun run test:integration

# Full regression test suite (all scenarios)
bun run test:e2e

# Run the regression runner directly with options
bun run src/regression/runner.ts --quick                    # Quick mode
bun run src/regression/runner.ts --scenario session-isolation  # Specific scenario
bun run src/regression/runner.ts --tag core                 # All 'core' tagged scenarios
```

Regression test results are saved to `~/.octopai/regression-results/`.

### Test Scenarios

Located in `src/regression/scenarios/`. Scenarios tagged `quick` run with `test:integration`.

| Scenario | Tags | Description |
|----------|------|-------------|
| `infrastructure-startup` | quick | Verifies all infrastructure components start correctly |
| `session-isolation` | quick | Verifies arms don't share session history |
| `self-healing-api-restart` | - | Tests API server recovery after restart |
| `zombie-arm-detection` | - | Tests detection and cleanup of zombie arms |
| `simple-task-completion` | - | Tests basic task assignment and completion |
| `arm-recovery` | - | Tests arm crash recovery and session restoration |

### Writing New Tests

**Unit tests**: Create `*.test.ts` files in `__tests__/` directories alongside source files.

**Integration tests**: Create standalone `test-*.ts` files in the project root. These should be self-contained and clean up after themselves.

**Regression scenarios**: Add new scenarios to `src/regression/scenarios/` following the existing pattern. Export them from `src/regression/scenarios.ts`.

## Gitea (Optional)

For local git collaboration:

```bash
docker compose up -d
open http://localhost:3000
```

