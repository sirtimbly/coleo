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
    details: Communicate with the system via Maildir-backed IMAP/SMTP, keeping familiar email workflows
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
