[![Latest Release](https://img.shields.io/github/v/release/sirtimbly/coleo)](https://github.com/sirtimbly/coleo/releases/latest)
[![Fair Source](https://img.shields.io/badge/license-Fair%20Source-blue.svg)](LICENSE.txt)

# Coleo

Distributed agent orchestration for software development. Coleo is a coordination layer that turns existing agent harnesses into a supervised multi-agent system: a central Brain, persistent state, and an Observatory for visibility.

**[Documentation and self-hosting](https://coleo.dev)** · **[Managed Coleo workspaces at Coleo Reef](https://coleo.app)**

> *Named after Coleoidea, the subclass of intelligent cephalopods that ditched rigid shells for distributed neural architecture.*

## Quick Start

Requires the [Bun](https://bun.sh/) runtime (v1.1+).

For installation details and configuration guidance, see the [Coleo getting started guide](https://coleo.dev/guides/getting-started).

```bash
# Install Bun + coleo globally (Linux/macOS, no mise required)
curl -fsSL https://raw.githubusercontent.com/sirtimbly/coleo/master/bin/install.sh | bash

# Initialize Coleo in this project (creates ./.coleo/)
coleo init --dir ./.coleo
# During init you'll be prompted to generate an API token in ./.coleo/.env

# Terminal 1: start the API server
# If COLEO_NATS_URL is unset, this will auto-start local NATS for you
coleo serve

# Terminal 2: start the Brain (foreground polling loop)
coleo brain run

# Terminal 3: spawn an Arm (headless by default via opencode-api)
coleo arm spawn --name explorer --harness opencode-api --workdir ./your-repo

# Send a task via mail
coleo mail send "Explore the codebase and identify refactoring opportunities"

# Check status
coleo status
```

## Docker Quick Start

Run Coleo in a container with SSH access:

```bash
# Copy env file and add your API keys
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY, etc.

# Build and start
docker compose up -d

# SSH into the container
ssh -p 2222 coleo@localhost  # password: coleo

# Inside the container:
coleo serve                         # Start the API server
coleo brain run                     # Start the Brain
coleo arm spawn -n coder --terminal tmux     # Spawn in tmux (uses opencode-tui)
coleo status                        # Check status

# View Arm logs (headless mode)
tail -f ~/.coleo/logs/coleo_coder.log
```

Ports:
- **2222**: Coleo SSH
- **3000**: Gitea web UI
- **2223**: Gitea git SSH

## Hosted Coleo

Prefer to use Coleo without operating the infrastructure yourself? [Coleo Reef](https://coleo.app) provides managed private Coleo workspaces, including the Brain, Observatory, storage, routing, and updates.

Coleo remains self-hostable. Visit [coleo.dev](https://coleo.dev) for documentation and deployment guides, or choose [Coleo Reef](https://coleo.app) for the managed experience.

## Architecture

See the [architecture overview on coleo.dev](https://coleo.dev/architecture/overview) or `docs/architecture/overview.md` for detailed system documentation.

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
coleo init                      # Initialize ./.coleo in the current project
coleo init --dir ~/.coleo       # Optional: use a global directory instead
coleo serve                     # Start API server in foreground
coleo serve start               # Start API server in background
coleo brain run                 # Start Brain (foreground)
coleo brain run --once          # Single poll cycle
coleo arm spawn -n NAME         # Spawn an Arm (via API server)
coleo arm spawn -n NAME --terminal tmux  # Spawn in a visible terminal (opencode-tui)
coleo arm list                  # List active Arms
coleo mail inbox                # View inbox
coleo mail send "task"          # Send task to Brain
coleo imap serve                # Start IMAP gateway for mail clients
coleo imap password             # Show/reset IMAP password
coleo status                    # Overall status
coleo mcp serve                 # Run MCP server (for Arms)
```

## Harness Modes

Coleo separates “coordination” from “agent UI” via harnesses:

```bash
# Headless (API-driven) harness
coleo arm spawn -n worker --harness opencode-api --workdir /path/to/repo

# Visible terminal harness (recommended when you want to watch/debug)
coleo arm spawn -n worker --terminal tmux --workdir /path/to/repo
```

## Local Development

### Prerequisites

- [Bun](https://bun.sh/) runtime (v1.1+)
- [NATS Server](https://nats.io/) with JetStream enabled (optional, for distributed arms and stream-backed events)
- [OpenCode](https://opencode.ai/) CLI (for spawning AI Arms)

This section is for contributors running Coleo from source. For regular usage, install the global CLI and run `coleo` commands.

### Setup

```bash
# Clone and install dependencies
git clone https://github.com/sirtimbly/coleo.git
cd coleo
bun run setup

# Initialize Coleo (creates ./.coleo directory and database by default)
bun run src/cli/index.ts init

# Build the web UI
bun run web:build
```

### Running Locally

```bash
# Start the API server
# If COLEO_NATS_URL is unset, this auto-starts local NATS into ./.coleo/
bun run src/cli/index.ts serve

# Start the Brain orchestrator
bun run src/cli/index.ts brain run

# Development mode for web UI (hot reload)
bun run web:dev
```

### Available Scripts

| Script                     | Description                          |
| -------------------------- | ------------------------------------ |
| `bun run dev`              | Run CLI commands directly            |
| `bun run brain`            | Start the Brain orchestrator         |
| `bun run check`            | Run shellcheck + TypeScript checks   |
| `bun run typecheck`        | Run TypeScript type checking         |
| `bun run test`             | Run unit tests                       |
| `bun run test:watch`       | Run unit tests in watch mode         |
| `bun run test:integration` | Run quick integration tests          |
| `bun run test:e2e`         | Run full end-to-end regression tests |
| `bun run web:dev`          | Start web UI dev server (hot reload) |
| `bun run web:build`        | Build web UI for production          |
| `bun run docs:dev`         | Start documentation dev server       |

### Environment Variables

Create a `.env` file in the project root:

```bash
# Required for AI Arms
ANTHROPIC_API_KEY=your-key-here
OPENAI_API_KEY=your-key-here      # Optional

# Optional configuration
COLEO_API_PORT=8080               # API server port (default: 8080)
COLEO_API_HOST=0.0.0.0            # API server host (default: 0.0.0.0)
COLEO_API_KEY=your-key-here       # Optional API key for the Observatory/API
COLEO_DB_PATH=./.coleo/coleo.db   # Database location
# Leave unset to let `coleo serve` auto-start local NATS in ./.coleo/
COLEO_NATS_URL=nats://localhost:4222  # External NATS server URL
```

## Testing

Coleo has three levels of testing:

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

Standalone scripts for quick manual verification of specific features. These are **not** run by `test:integration`—they're meant for ad-hoc testing during development.

```bash
# Session isolation test - verifies each Arm gets a unique session
bun run test-session-isolation.ts

# JetStream pattern test - verifies multi-part event subjects work
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
bun run src/regression/runner.ts --quick
bun run src/regression/runner.ts --scenario session-isolation
bun run src/regression/runner.ts --tag core
```

Regression test results are saved to `~/.coleo/regression-results/`.

### Test Scenarios

Located in `src/regression/scenarios/`. Scenarios tagged `quick` run with `test:integration`.

| Scenario                   | Tags  | Description                                            |
| -------------------------- | ----- | ------------------------------------------------------ |
| `infrastructure-startup`   | quick | Verifies all infrastructure components start correctly |
| `session-isolation`        | quick | Verifies Arms don't share session history              |
| `self-healing-api-restart` | -     | Tests API server recovery after restart                |
| `zombie-arm-detection`     | -     | Tests detection and cleanup of zombie Arms             |
| `simple-task-completion`   | -     | Tests basic task assignment and completion             |
| `arm-recovery`             | -     | Tests Arm crash recovery and session restoration       |

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

## License

Business Source License 1.1 (BSL 1.1). Free for individual use. See [Coleo licensing](https://coleo.dev/licensing) for organizational use.
