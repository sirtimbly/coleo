---
layout: home

hero:
  name: Octopai
  text: AI Agent Orchestrator
  tagline: Distributed autonomous arms coordinated by a central brain
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
    details: Central brain coordinates semi-autonomous arms, each with focused expertise and context
  - icon: 🌱
    title: The Garden
    details: 3D visualization of your codebase with ownership tracking and conflict detection
  - icon: 🗳️
    title: Anarchic Governance
    details: Arms persuade each other through reasoned arguments, not just votes
  - icon: 🔭
    title: Observatory
    details: Web UI for monitoring, configuring, and intervening in arm activity
  - icon: 📬
    title: Email Interface
    details: Communicate with agents via familiar email (Maildir) interface
  - icon: 🚀
    title: Deployment Consensus
    details: Arms reach consensus before deploying, with human approval for production
---

## Quick Start

```bash
# Clone and install
git clone https://github.com/your-username/octopai
cd octopai
bun install

# Initialize
bun run src/cli/index.ts init

# Start the brain
bun run src/cli/index.ts brain run

# Spawn an arm
bun run src/cli/index.ts arm spawn --name explorer --agent opencode
```

## Current Status

**v0.1** - Core infrastructure complete:
- Brain polling loop
- Maildir communication
- MCP server with tools
- Terminal & headless arm spawning
- Docker support with Gitea

**Next**: Observatory (Web UI + API) and arm specialization.

## Documentation Sections

| Section | Description |
|---------|-------------|
| [Architecture](/architecture/overview) | System design and component details |
| [Guides](/guides/getting-started) | How-to guides and CLI reference |
