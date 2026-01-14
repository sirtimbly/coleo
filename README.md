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

## Phases & Roadmap

- **Phase 0 – Core Infrastructure (Complete)**: Brain polling loop, maildir IO, MCP server, arm spawner, CLI tooling, Docker/Gitea setup, and shared type definitions delivered.
- **Phase 1 – Observatory Foundation (Next)**: Hono REST API, SQLite schema, WebSocket updates, React shell with dashboards, arm list/status views, CLI proxy routing, and mail metadata API; pending decisions on authentication, component library, and state management (est. 2–3 weeks).
- **Phase 1.5 – Email Gateway (Planned)**: IMAP server over Maildir, SMTP submission into the brain queue, coordinator arm for mirroring replies, and transport observability once Phase 1 ships (~1 week).
- **Phase 2 – Arm Specialization (Planned)**: Domain configuration, context budget tracking, file claim system, thrash detection, and handoff protocol (est. 2 weeks).
- **Phase 3 – Governance (Planned)**: Proposal workflow, argument/signaling system, consensus scoring, reputation tracking, creative override, and emergency stop features (est. 2–3 weeks).
- **Phase 4 – Garden Visualization (Planned)**: React Three Fiber scene, radial layout, real-time file activity and ownership coloring, conflict highlighting, and interactive navigation (est. 2 weeks).
- **Phase 5 – Notifications & Deployment (Planned)**: Browser push notifications, deployment proposal flow, blue/green rollout with rollback + pause, and monitoring hooks (est. 2 weeks).
- **Phase 6 – Agent Harnesses (Planned)**: Harness interface/registry, PTY session management, and harness implementations for OpenCode, Claude Code, and Aider plus a test suite (est. 3 weeks).
- **Phase 7 – Polish & Production (Planned)**: PostgreSQL option, comprehensive tests, performance tuning, security hardening, Docker Swarm support, and user documentation (est. 2–3 weeks).

### Milestones

- **M1 – Observable**: End of Phase 1, arm activity visible through the web UI.
- **M2 – Coordinated**: End of Phase 3, arms negotiate and reach consensus.
- **M3 – Visual**: End of Phase 4, 3D Garden reflects workspace state.
- **M4 – Multi-Agent**: End of Phase 6, multiple harnesses supported.
- **M5 – Production**: End of Phase 7, system ready for real-world use.

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
