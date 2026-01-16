---
layout: home

hero:
  name: Octopai
  text: AI Agent Orchestrator
  tagline: Progressive planning with general-purpose AI arms
  actions:
    - theme: brand
      text: Architecture Overview
      link: /architecture/overview
    - theme: alt
      text: Getting Started
      link: /guides/getting-started

features:
  - icon: 🐙
    title: Octopus Model
    details: Central brain coordinates general-purpose arms whose behavior depends on the task they’re executing
  - icon: 🧠
    title: Progressive Planning
    details: The brain determines the single next task at runtime based on plans, history, and discoveries
  - icon: 🪴
    title: The Garden
    details: 3D visualization of your codebase with ownership tracking and conflict detection
  - icon: 🔭
    title: Observatory
    details: Web UI and CLI over a shared API for monitoring and intervening in arm activity
  - icon: ✉️
    title: Email Interface
    details: Communicate with the system via Maildir-backed mail, with web UI and CLI integrations. IMAP/SMTP gateway is future work.
  - icon: ⚖️
    title: Governance
    details: Proposal and consensus system for higher-risk changes (planned phases)
---

## Quick Start

```bash
# Clone and install
git clone https://github.com/your-username/octopai
cd octopai
bun install

# Run the CLI (dev mode)
bun run dev

# Start the brain (coordinates arms)
bun run brain run

# Start the API + Observatory server
bun run server

# Spawn an arm (general-purpose)
bun run src/cli/index.ts arm spawn --name worker-1 --agent opencode
```

### Two ways to start using Octopai

You don’t need to redesign your whole workflow to try Octopai.

- **Point it at an existing repo**  
  Keep your current stack, CI, and habits. Run the brain locally, spawn a general-purpose arm with `--workdir` pointing at your existing project, and let it help with refactors, tests, and docs. You can start by reviewing its changes on a shared `octopai` branch in your own Git history.

- **Start a brand new idea with it**  
  Create a fresh project directory and git repo, make an `octopai` branch, and spawn an arm into that working tree. Describe the idea in a single task ("scaffold a minimal app that does X"), and let the arm handle the initial structure while you stay in control of commits and reviews.

From there, the [Getting Started guide](/guides/getting-started) walks through both flows step by step.

## Current Status

**Phase 2** – Task classification & context bundles in progress.

- Brain polling loop and Maildir communication implemented
- Hono API server, SQLite migrations, and WebSocket in place
- Basic web Observatory shell and arm list view
- NATS integration for distributed arms
- `.project/` directory defines project plan, requirements, and status

The next major focus is **progressive planning** and a **timeline-first task UI** rather than a manual backlog.

## Documentation Sections

| Section | Description |
|---------|-------------|
| [Architecture](/architecture/overview) | System design, task model, and component details |
| [Guides](/guides/getting-started) | How-to guides and CLI/API reference |
