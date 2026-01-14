# Octopai Project

**AI Agent Orchestrator using the Octopus Model**

A central brain coordinates semi-autonomous "arms" (AI agents), each with focused expertise and context budgets. Human-agent communication happens via email (Maildir), and arms communicate via MCP (Model Context Protocol).

## Quick Links

- [Current Status](./status.md) - What's happening right now
- [Project Plan](./plan.md) - High-level phases and goals
- [Current Tasks](./tasks/current.md) - Active work items
- [Pending Feedback](./feedback/pending.md) - Human input awaiting action

## Project Health

| Metric | Value |
|--------|-------|
| Current Phase | Phase 0 (Complete) → Phase 1 (Starting) |
| Status | Planning & Documentation |
| Active Arms | 0 (manual development) |
| Blockers | None |

## Getting Started

```bash
# Install dependencies
bun install

# Run the CLI
bun run dev

# View documentation
bun run docs:dev
```

## Documentation

Full architecture documentation available at `docs/` - run `bun run docs:dev` to view.

## Directory Structure

```
.project/
├── README.md          ← You are here
├── plan.md            # High-level project plan
├── status.md          # Current status (updated frequently)
├── decisions/         # Architecture Decision Records
├── tasks/             # Task tracking
├── feedback/          # Human feedback tracking
├── communications/    # Drafts and sent messages
└── acceptance/        # Acceptance criteria per phase
```
