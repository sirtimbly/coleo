# Architecture Overview

Coleo is an AI agent orchestrator that enables multiple general-purpose AI agents ("arms") to collaborate on software projects while a human maintains oversight and control.

## System Goals

1. **Coordinate cognitive work** - Multiple arms work on different aspects of a project over time
2. **Preserve shared context** - Arms share discoveries and plans instead of siloed expertise
3. **Enable human oversight** - The human can monitor, guide, and intervene at any time
4. **Support creative autonomy** - Arms can push forward on blocked work when they have conviction

## Key Metaphors

| Metaphor | Meaning |
|----------|---------|
| **Octopus** | The whole system - a central brain coordinating semi-autonomous arms |
| **Brain** | Central coordinator that assigns tasks, manages context, and interfaces with the human |
| **Arms** | General-purpose AI agents whose behavior changes with task classification |
| **Garden** | The shared workspace - code, docs, configs, environments - that arms tend |
| **Observatory** | The web UI where humans observe and configure the system |
| **Nerve System** | Communication layer (MCP, WebSocket, message queues) |

## Design Principles

### 1. Arms Are Not Specialized
Arms are general-purpose and adapt their behavior based on **task classification** (architect, development, QA, PM, etc.). The same arm may behave like an architect for one task and like a QA engineer for the next.

### 2. Progressive Planning
The brain does **not** maintain a static backlog. Instead it progressively determines the **single next task** for an arm at runtime by re-evaluating plan documents, completed tasks, discoveries, and status reports.

### 3. Observable by Default
All activity is logged and visualizable.

### 4. Human-in-the-Loop
Humans provide requirements and decisions; arms execute and report. Critical decisions can still require explicit human approval.

### 5. Client Agnostic
CLI, Web, and Email clients all interact with the same core API and Maildir state.

### 6. Linear, Shared Git Workflow

Multiple arms often work in the same codebase at once. Rather than giving each arm its own worktree or long-lived feature branch, Coleo assumes:

- A **single clone** of the project.
- A shared integration branch (typically named `octopai`) where arms make changes.
- A **mostly linear git history**, with humans in control of commits, rebases, and merges.

The design does not forbid more advanced flows (temporary branches, stashes, or branch-per-feature models). Those can be layered on later. The default is “many arms, one garden, one branch,” with coordination handled through tasks, claims, and proposals rather than Git topology.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENT LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  Web Browser              CLI Terminal                 Mail Client                 │
│  ┌────────────────────┐   ┌──────────────────────┐    ┌────────────────────────┐  │
│  │  React Observatory │   │  octopai CLI         │    │  IMAP/SMTP client      │  │
│  │  - Timeline view   │   │  - spawn/list/kill   │    │  - Threads with Brain  │  │
│  │  - Arm activity    │   │  - status            │    │  - Status reports      │  │
│  │  - Garden (3D)     │   │  - API proxy         │    │  - Decisions & alerts  │  │
│  └─────────┬──────────┘   └──────────┬───────────┘    └─────────────┬───────────┘  │
│            │                         │                            │              │
│            └───────────────┬─────────┴───────────────┬──────────────┘              │
│                            ▼                         ▼                             │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                               COLEO SERVER & IMAP GATEWAY                          │
│  ┌───────────────────────────────────────────────────────────────────────────────┐  │
│  │  Hono API (REST + WebSocket)                                                │  │
│  │  - /api/brain/*     - Brain state, control                                 │  │
│  │  - /api/arms/*      - Arm status, tasks, activity                          │  │
│  │  - /api/tasks/*     - Task timeline, next task                             │  │
│  │  - /api/discoveries - Indexed discoveries                                  │  │
│  │  - /api/mail/*      - Maildir metadata, threads                            │  │
│  │  - /api/garden/*    - File ownership & touch history                       │  │
│  │  - /api/proposals/* - Governance (future phases)                           │  │
│  │  - /ws              - Real-time updates                                    │  │
│  └───────────────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                   BRAIN + ARMS                                     │
│  ┌───────────────────────────────────────────────────────────────────────────────┐  │
│  │  Brain                                                                       │  │
│  │  - Coordinates arms                                                          │  │
│  │  - Reads .project/ plans, status, decisions                                  │  │
│  │  - Progressive task assignment (single next task per arm)                   │  │
│  │  - Builds context bundles (requirements, docs, decisions, discoveries)      │  │
│  │  - Mirrors human ↔ arm email threads via Maildir                            │  │
│  └───────────────────────────────────────────────────────────────────────────────┘  │
│        │                     │                        │                           │
│        ▼                     ▼                        ▼                           │
│  ┌─────────────┐     ┌──────────────┐        ┌────────────────┐                   │
│  │ Architect   │     │ Development  │        │ QA             │   ...             │
│  │ Task (arm)  │     │ Task (arm)   │        │ Task (arm)     │                   │
│  └─────────────┘     └──────────────┘        └────────────────┘                   │
│        ▲                     ▲                        ▲                           │
│        └───────────── PM / Project Management Tasks ──┘                           │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                      THE GARDEN                                    │
│  ┌───────────────────────────────────────────────────────────────────────────────┐  │
│  │  Code, configs, docs, tests                                                 │  │
│  │  MCP servers (git, docs, runtime, devtools, etc.)                           │  │
│  │  SQLite as system of record (arms, tasks, activity, claims, config, mail)   │  │
│  └───────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Client Interfaces

- **CLI ↔ API**: The `octopai` CLI treats the API server as its single source of truth for spawning, listing, and managing arms. All mutating commands are proxied through authenticated REST calls.
- **Web UI ↔ API**: The Observatory React app consumes the same REST and WebSocket endpoints for status dashboards, configuration, and real-time updates.
- **Mail Client ↔ Email Server**: Humans connect via standard IMAP/SMTP clients to converse with the brain. Messages are persisted in Maildir, surfaced through `/api/mail/*`, and synchronized with a coordination arm routing context between the brain and worker arms.

## Next Steps

- [Components](./components) - Deep dive into Brain, Arms, Garden, Observatory
- [Governance](./governance) - How arms will make decisions together (Phase 3)
- [Distributed Architecture](./distributed) - Running gardens across multiple machines
- [Implementation Phases](./phases) - Roadmap for building this system
