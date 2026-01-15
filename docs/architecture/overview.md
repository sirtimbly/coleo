# Architecture Overview

Octopai is an AI agent orchestrator that enables multiple specialized AI agents ("arms") to collaborate on software projects while a human maintains oversight and control.

## System Goals

1. **Parallelize cognitive work** - Multiple arms work simultaneously on different aspects of a project
2. **Reduce context bottlenecks** - Each arm maintains focused expertise rather than trying to know everything
3. **Enable human oversight** - The human can monitor, guide, and intervene at any time
4. **Support creative autonomy** - Arms can push forward on blocked work when they have conviction

## Key Metaphors

| Metaphor | Meaning |
|----------|---------|
| **Octopus** | The whole system - a central brain coordinating semi-autonomous arms |
| **Brain** | Central coordinator that mediates conflicts, enforces rules, and interfaces with human |
| **Arms** | Specialized AI agents with focused context and expertise |
| **Garden** | The shared workspace - code, docs, configs, environments - that arms tend |
| **Observatory** | The web UI where humans observe and configure the system |
| **Nerve System** | Communication layer (MCP, WebSocket, message queues) |

## Design Principles

### 1. Anarchy with Accountability
Arms are autonomous but the brain can intervene or terminate destructive behavior.

### 2. Persuasion over Voting
Arms convince each other with reasoning, not just vote counts.

### 3. Specialization over Generalization
Each arm has a domain and context budget.

### 4. Observable by Default
All activity is logged and visualizable.

### 5. Human-in-the-Loop
Critical decisions require human approval; routine work proceeds autonomously.

### 6. Client Agnostic
Web and SSH are equal citizens accessing the same API.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                                 │
├─────────────────────────────────────────────────────────────────────┤
│   Web Browser                    │  SSH Terminal        │  Mail Client        │
│   ┌─────────────────────┐       │  ┌──────────────────┐│  ┌────────────────┐ │
│   │  React UI           │       │  │  octopai CLI     ││  │  IMAP/SMTP     │ │
│   │  - Garden view      │       │  │  - Same commands ││  │  bridge to     │ │
│   │  - Arm activity     │       │  │  - Direct REPL   ││  │  Maildir +     │ │
│   │  - Notifications    │       │  │  - API proxy     ││  │  coordinator   │ │
│   │  - Config editor    │       │  └────────┬─────────┘│  └────────┬───────┘ │
│   └─────────┬───────────┘       │           │          │           │         │
│             │                   │           │          │           │         │
│             └───────┬───────────┼───────────┴──────────┴───────────┘         │
│                     ▼           │                                           │
├─────────────────────────────────────────────────────────────────────┤
│                      OCTOPAI SERVER API                              │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Hono API (REST + WebSocket)                                   │ │
│  │  - /api/brain/*     - Brain state, control                     │ │
│  │  - /api/arms/*      - Arm status, claims, activity             │ │
│  │  - /api/garden/*    - File ownership, touch history            │ │
│  │  - /api/proposals/* - Governance proposals                     │ │
│  │  - /api/mail/*      - Maildir access, digests, metadata        │ │
│  │  - /ws              - Real-time updates                        │ │
│  └────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│                         BRAIN + ARMS                                 │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Brain                                                        │   │
│  │  - Coordinates arms                                           │   │
│  │  - Manages context budgets                                    │   │
│  │  - Resolves ownership conflicts                               │   │
│  │  - Routes tasks to specialists                                │   │
│  │  - Mirrors human ↔ arm email threads                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│       │          │           │            │           │              │
│       ▼          ▼           ▼            ▼           ▼              │
│  ┌────────┐ ┌────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐        │
│  │UI Arm  │ │API Arm │ │Test Arm  │ │Ops Arm  │ │DevTools  │        │
│  │        │ │        │ │          │ │         │ │Arm       │        │
│  │Context:│ │Context:│ │Context:  │ │Context: │ │Context:  │        │
│  │- CSS   │ │- Routes│ │- Specs   │ │- Docker │ │- Browser │        │
│  │- React │ │- DB    │ │- Fixtures│ │- Deploy │ │- E2E     │        │
│  │- Figma │ │- Auth  │ │- Mocks   │ │- Env    │ │- Console │        │
│  └────────┘ └────────┘ └──────────┘ └─────────┘ └──────────┘        │
├─────────────────────────────────────────────────────────────────────┤
│                         THE GARDEN                                   │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  MCP Servers (Tools exposed to arms)                           │ │
│  │  ├── git-mcp        - VCS operations, history, branches        │ │
│  │  ├── env-mcp        - Environment variables, secrets           │ │
│  │  ├── runtime-mcp    - Node/Python/Bun version management       │ │
│  │  ├── docs-mcp       - Library docs, API references             │ │
│  │  ├── nx-mcp         - Monorepo task orchestration              │ │
│  │  ├── devtools-mcp   - Chrome automation, screenshots           │ │
│  │  ├── deploy-mcp     - Hosting/deployment per environment       │ │
│  │  └── pkg-mcp        - Package management (npm/pnpm/cargo)      │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Client Interfaces

- **CLI ↔ API**: The `octopai` CLI now treats the API server as its single source of truth for spawning, listing, and managing arms. All mutating commands are proxied through authenticated REST calls.
- **Web UI ↔ API**: The Observatory React app consumes the same REST and WebSocket endpoints for status dashboards, configuration, and real-time updates.
- **Mail Client ↔ Email Server**: Humans connect via standard IMAP/SMTP clients to converse with the brain. Messages are persisted in Maildir, surfaced through `/api/mail/*`, and synchronized with the coordinator arm routing context between the brain and worker arms.

## Next Steps

- [Components](./components) - Deep dive into Brain, Arms, Garden, Observatory
- [Governance](./governance) - How arms make decisions together
- [Distributed Architecture](./distributed) - Running gardens across multiple machines
- [Implementation Phases](./phases) - Roadmap for building this system
