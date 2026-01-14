# Octopai Agent Guidelines

This file provides architectural context and guidelines for AI agents (arms) working on the Octopai codebase. All agents should read and follow these guidelines.

## Project Overview

Octopai is an AI agent orchestrator using the "Octopus Model" - a central brain coordinates semi-autonomous "arms" (AI agents), each with focused expertise and context budgets.

## System of Record

**SQLite is the system of record for all persistent state.**

| Data | Storage | Location |
|------|---------|----------|
| Arms | SQLite | `~/.octopai/octopai.db` → `arms` table |
| Proposals | SQLite | `~/.octopai/octopai.db` → `proposals` table |
| Activity | SQLite | `~/.octopai/octopai.db` → `activity` table |
| Config | SQLite | `~/.octopai/octopai.db` → `config` table |
| Claims | SQLite | `~/.octopai/octopai.db` → `claims` table |
| MCP configs | JSON files | `~/.octopai/mcp/*.json` (generated, not authoritative) |
| Mail | Maildir | `~/.octopai/mail/` (human-agent communication) |

**DO NOT** create JSON files for state that should be in SQLite. If you need to persist arm state, proposals, or configuration, use the database.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Language | TypeScript (strict mode) |
| API Server | Hono |
| Database | SQLite (bun:sqlite) with migrations |
| Web UI | React + Vite + TailwindCSS + shadcn/ui |
| Agent Protocol | MCP (Model Context Protocol) |
| Mail | Maildir format |

## Code Organization

```
src/
├── api/          # Hono API server and routes
├── arm/          # Arm spawning and management
├── brain/        # Central coordinator
├── cli/          # CLI commands (Commander.js)
├── db/           # Database initialization and migrations
├── mail/         # Maildir implementation
├── mcp/          # MCP server for arm communication
├── types/        # Shared TypeScript types
└── web/          # React frontend (separate tsconfig)
```

## Conventions

### Database

- All schema changes go through migrations in `src/db/index.ts`
- Use parameterized queries, never string interpolation for SQL
- Column names use `snake_case`, TypeScript uses `camelCase`
- Always close database connections in `finally` blocks

### API

- Routes are modular in `src/api/routes/*.ts`
- Use `HttpError` from middleware for error responses
- Return consistent JSON shapes: `{ arm: ... }`, `{ arms: [...] }`, `{ error: ... }`

### TypeScript

- Run `bun run typecheck` before committing
- Web app has separate tsconfig at `src/web/tsconfig.json`
- Avoid `any` - use `unknown` and narrow types

### Naming

- "arm" not "tentacle" (we renamed this)
- "harness" = agent type (opencode, claude-code, aider)
- "domain" = area of expertise (backend, frontend, testing)

## Current State

### What's Working

- CLI commands: `octopai arm spawn/list/kill`, `octopai status`
- API server with WebSocket support
- React dashboard with real-time updates
- Arm spawning in terminal windows (Ghostty, iTerm2, Terminal.app, tmux)
- Provider/model selection for arms

### What's In Progress

- Arm context budget tracking
- Proposal/governance system
- 3D garden visualization

## For UI Arms

When working on the React UI (`src/web/`):

- Use shadcn/ui components from `src/web/src/components/ui/`
- Follow existing patterns in `src/web/src/pages/`
- API calls go through `src/web/src/lib/api.ts`
- Build with `cd src/web && bun run build` to verify

## For Backend Arms

When working on the API or core:

- Database changes require migrations
- Update types in `src/types/index.ts` when changing data shapes
- Test with `bun run typecheck`
- CLI should exit cleanly after async commands

## Questions?

If you're unsure about an architectural decision:

1. Check this file and `docs/architecture/` first
2. Use the `get_architectural_guidance` MCP tool (when available)
3. Create a proposal for significant changes
4. Ask the human via mail for critical decisions
