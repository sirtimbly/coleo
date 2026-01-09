# Octopai

AI agent orchestrator using the **Octopus Model** - distributed autonomous tentacles coordinated by a central brain, with human-agent communication via email.

## Quick Start

```bash
# Install dependencies
bun install

# Initialize Octopai
bun run src/cli/index.ts init

# Start the brain (foreground)
bun run src/cli/index.ts brain run

# In another terminal, spawn a tentacle
bun run src/cli/index.ts tentacle spawn --name explorer --agent opencode

# Send a task via mail
bun run src/cli/index.ts mail send "Add dark mode toggle to settings"

# Check status
bun run src/cli/index.ts status
```

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
Tentacle  Tentacle  Tentacle
(opencode)(claude)  (aider)
```

## Commands

```bash
octopai init                    # Initialize ~/.octopai
octopai brain run               # Start brain (foreground)
octopai brain run --once        # Single poll cycle
octopai tentacle spawn -n NAME  # Spawn a tentacle
octopai tentacle list           # List tentacles
octopai mail inbox              # View inbox
octopai mail send "task"        # Send task to brain
octopai status                  # Overall status
octopai mcp serve               # Run MCP server (for tentacles)
```

## Gitea (Optional)

For local git collaboration:

```bash
docker compose up -d
open http://localhost:3000
```

## License

MIT
