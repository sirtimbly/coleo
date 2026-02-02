# File Structure

This document describes the proposed file structure for the complete Coleo implementation.

## Current Structure

```
coleo/
├── bin/
│   └── coleo.ts                # CLI entrypoint
├── docs/                        # VitePress documentation (new)
│   ├── .vitepress/
│   │   └── config.ts
│   ├── architecture/
│   │   ├── overview.md
│   │   ├── components.md
│   │   ├── governance.md
│   │   ├── context.md
│   │   ├── api.md
│   │   ├── data.md
│   │   ├── deployment.md
│   │   ├── security.md
│   │   ├── phases.md
│   │   ├── structure.md
│   │   └── questions.md
│   ├── guides/
│   │   ├── getting-started.md
│   │   ├── cli.md
│   │   └── docker.md
│   └── index.md
├── src/
│   ├── brain/
│   │   ├── brain.ts            # Central coordinator (existing)
│   │   └── index.ts
│   ├── cli/
│   │   └── index.ts            # CLI commands (existing)
│   ├── mail/
│   │   ├── maildir.ts          # Maildir implementation (existing)
│   │   └── index.ts
│   ├── mcp/
│   │   ├── server.ts           # MCP server (existing)
│   │   └── index.ts
│   ├── arm/
│   │   ├── spawner.ts          # Arm spawner (existing)
│   │   └── index.ts
│   ├── types/
│   │   └── index.ts            # Type definitions (existing)
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── README.md
├── NOTES.md
├── QUESTIONS.md
└── .env.example
```

## Proposed Structure

```
coleo/
├── bin/
│   └── coleo.ts                # CLI entrypoint
│
├── docs/                        # VitePress documentation
│   ├── .vitepress/
│   │   └── config.ts
│   ├── architecture/
│   ├── guides/
│   └── index.md
│
├── src/
│   ├── brain/
│   │   ├── brain.ts            # Central coordinator
│   │   ├── governance.ts       # Proposal & consensus logic (new)
│   │   ├── intervention.ts     # Misbehavior detection (new)
│   │   └── index.ts
│   │
│   ├── arm/                     # Renamed from tentacle
│   │   ├── profile.ts          # Arm profiles, domains (new)
│   │   ├── context.ts          # Context budget management (new)
│   │   ├── reputation.ts       # Reputation tracking (new)
│   │   ├── spawner.ts          # Arm spawner (existing)
│   │   └── index.ts
│   │
│   ├── garden/                  # New module
│   │   ├── topology.ts         # 3D coordinate system
│   │   ├── ownership.ts        # Claims, conflicts
│   │   ├── activity.ts         # Touch tracking
│   │   └── index.ts
│   │
│   ├── observatory/             # New module - Web server
│   │   ├── server.ts           # Hono app setup
│   │   ├── middleware/
│   │   │   ├── auth.ts         # API key auth
│   │   │   ├── logging.ts      # Request logging
│   │   │   └── errors.ts       # Error handling
│   │   ├── routes/
│   │   │   ├── status.ts       # GET /api/status
│   │   │   ├── brain.ts        # /api/brain/*
│   │   │   ├── arms.ts         # /api/arms/*
│   │   │   ├── garden.ts       # /api/garden/*
│   │   │   ├── proposals.ts    # /api/proposals/*
│   │   │   ├── approvals.ts    # /api/approvals/*
│   │   │   ├── deployments.ts  # /api/deployments/*
│   │   │   ├── notifications.ts # /api/notifications/*
│   │   │   └── config.ts       # /api/config
│   │   ├── ws/
│   │   │   ├── handler.ts      # WebSocket connection handling
│   │   │   ├── channels.ts     # Channel management
│   │   │   └── events.ts       # Event definitions
│   │   ├── push/
│   │   │   ├── sender.ts       # Push notification sender
│   │   │   └── vapid.ts        # VAPID key management
│   │   └── index.ts
│   │
│   ├── db/                      # New module - Database
│   │   ├── interface.ts        # Database interface
│   │   ├── sqlite.ts           # SQLite implementation
│   │   ├── postgres.ts         # PostgreSQL implementation
│   │   ├── migrations/
│   │   │   ├── 001_initial.sql
│   │   │   ├── 002_proposals.sql
│   │   │   └── ...
│   │   └── index.ts
│   │
│   ├── mcp/
│   │   ├── server.ts           # MCP server (existing, expanded)
│   │   ├── tools/              # New - organized tools
│   │   │   ├── task.ts
│   │   │   ├── claim.ts
│   │   │   ├── proposal.ts
│   │   │   └── deploy.ts
│   │   └── index.ts
│   │
│   ├── mail/
│   │   ├── maildir.ts          # Maildir implementation (existing)
│   │   └── index.ts
│   │
│   ├── cli/
│   │   └── index.ts            # CLI commands (existing, expanded)
│   │
│   ├── types/
│   │   ├── index.ts            # Core types (existing, expanded)
│   │   ├── arm.ts              # Arm-related types
│   │   ├── proposal.ts         # Governance types
│   │   ├── garden.ts           # Garden types
│   │   └── api.ts              # API request/response types
│   │
│   └── utils/
│       ├── logger.ts           # Structured logging
│       ├── config.ts           # Configuration loading
│       └── patterns.ts         # Glob pattern matching
│
├── web/                         # New - React frontend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── Header.tsx
│   │   │   │   └── Layout.tsx
│   │   │   ├── dashboard/
│   │   │   │   ├── StatusCard.tsx
│   │   │   │   └── Dashboard.tsx
│   │   │   ├── arms/
│   │   │   │   ├── ArmList.tsx
│   │   │   │   ├── ArmCard.tsx
│   │   │   │   ├── ArmDetail.tsx
│   │   │   │   └── ContextGauge.tsx
│   │   │   ├── garden/
│   │   │   │   ├── Garden3D.tsx
│   │   │   │   ├── FileNode.tsx
│   │   │   │   └── Controls.tsx
│   │   │   ├── proposals/
│   │   │   │   ├── ProposalList.tsx
│   │   │   │   ├── ProposalCard.tsx
│   │   │   │   └── ArgumentForm.tsx
│   │   │   ├── approvals/
│   │   │   │   ├── ApprovalList.tsx
│   │   │   │   └── ApprovalCard.tsx
│   │   │   └── common/
│   │   │       ├── Button.tsx
│   │   │       ├── Card.tsx
│   │   │       └── ...
│   │   ├── hooks/
│   │   │   ├── useApi.ts       # API client hook
│   │   │   ├── useWebSocket.ts # WebSocket hook
│   │   │   └── usePush.ts      # Push notification hook
│   │   ├── stores/
│   │   │   └── coleo.ts        # Zustand store
│   │   ├── lib/
│   │   │   ├── api.ts          # API client
│   │   │   └── ws.ts           # WebSocket client
│   │   └── styles/
│   │       └── globals.css
│   ├── public/
│   │   ├── favicon.ico
│   │   └── icons/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   └── package.json
│
├── docker/                      # Docker configurations
│   ├── Dockerfile              # Main Coleo image
│   ├── Dockerfile.arm          # Arm container image
│   └── docker-compose.dev.yml  # Development stack
│
├── scripts/                     # Utility scripts
│   ├── setup.sh                # Initial setup
│   ├── dev.sh                  # Start dev environment
│   └── migrate.sh              # Run migrations
│
├── docker-compose.yml           # Production stack
├── package.json
├── tsconfig.json
├── README.md
├── NOTES.md
├── QUESTIONS.md
└── .env.example
```

## Module Responsibilities

| Module | Purpose |
|--------|---------|
| `brain/` | Central coordination, governance, intervention |
| `arm/` | Arm profiles, spawning, context, reputation |
| `garden/` | Codebase topology, ownership, activity tracking |
| `observatory/` | Web server, API, WebSocket, push notifications |
| `db/` | Database abstraction, migrations |
| `mcp/` | MCP server and tools for arm communication |
| `mail/` | Maildir for human-agent communication |
| `cli/` | Command-line interface |
| `types/` | TypeScript type definitions |
| `utils/` | Shared utilities |
| `web/` | React frontend (separate package) |

## Package Organization

The project can be structured as a monorepo:

```json
// package.json (root)
{
  "name": "coleo",
  "workspaces": [
    ".",
    "web"
  ]
}
```

Or kept as two separate packages that are built together via docker.

## Import Conventions

```typescript
// Absolute imports from src root
import { Brain } from "@/brain";
import { spawnArm } from "@/arm";
import { Database } from "@/db";

// Types
import type { Arm, Proposal, GardenNode } from "@/types";
```

## Build Output

```
dist/
├── server/                      # Compiled backend
│   ├── index.js
│   └── ...
├── web/                         # Built frontend
│   ├── index.html
│   ├── assets/
│   │   ├── index-xxx.js
│   │   └── index-xxx.css
│   └── ...
└── cli/                         # CLI bundle
    └── coleo
```
