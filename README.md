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
octopai brain run                           # Start the brain
octopai tentacle spawn -n coder --agent opencode  # Spawn in tmux
octopai status                              # Check status

# View tentacle logs (headless mode)
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
Tentacle  Tentacle  Tentacle
(opencode)(claude)  (aider)
```

## Commands

```bash
octopai init                    # Initialize ~/.octopai
octopai brain run               # Start brain (foreground)
octopai brain run --once        # Single poll cycle
octopai tentacle spawn -n NAME  # Spawn a tentacle
octopai tentacle spawn -n NAME --headless  # Spawn without terminal window
octopai tentacle list           # List tentacles
octopai mail inbox              # View inbox
octopai mail send "task"        # Send task to brain
octopai status                  # Overall status
octopai mcp serve               # Run MCP server (for tentacles)
```

## Headless Mode

In environments without a display (Docker, SSH), tentacles run in headless mode:

- **tmux**: If available, creates a tmux session (attach with `tmux attach -t tentacle_name`)
- **headless**: Runs as background process, logs to `~/.octopai/logs/`

Force headless mode with `--headless` flag:

```bash
octopai tentacle spawn -n worker --agent opencode --headless
```

## Gitea (Optional)

For local git collaboration:

```bash
docker compose up -d
open http://localhost:3000
```

## License

MIT
