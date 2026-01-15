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

## Known Architectural Issues

**IMPORTANT:** The following issues were identified during comprehensive architectural review (January 2026) and should be addressed:

### Critical Issues

1. **SQLite Principle Violations**: 50+ JSON files found storing state that violates the core principle
   - Brain state (`.octopai/state/brain.json`) - coordinator status, poll intervals, active arms
   - Task management (`.octopai/state/tasks.json`) - task queue and status tracking
   - Tool discovery (`.octopai/state/toolbox.json`) - discovered tools from arms
   - Arm tracking (`.octopai/state/seen_arms.json`) - arm ID tracking
   - Message queuing (31+ files in `.octopai/queue/`) - persistent message system
   - Individual arm states (`.octopai/state/arms/`) - per-arm state persistence
   - Shared notes (`.octopai/state/notes/`) - inter-arm communication

2. **Data Consistency Risk**: Dual storage systems (SQLite + JSON files) create data inconsistency potential

### Code Quality Issues

3. **API Convention Violations**: 7 instances of direct error returns instead of `HttpError` middleware
   - `src/api/routes/agents.ts`: 6 violations (lines 45, 50, 64, 69, 75, 79)
   - `src/api/routes/activity.ts`: 1 violation (line 90)

4. **Type Safety Issues**: Extensive unsafe patterns found
   - 39+ instances of unsafe `JSON.parse()` without validation
   - 20+ instances of overused `unknown` types where specific interfaces needed
   - 38+ instances of `Record<string, unknown>` instead of proper interfaces
   - Unsafe type casting with `as unknown as` chains

5. **Code Duplication**: Massive duplication across codebase
   - 50+ instances of database connection duplication
   - 100+ instances of similar error handling patterns
   - 100+ instances of JSON operations duplication
   - Duplicate type definitions across multiple files (OctopaiConfig, ArmConfig, Arm interfaces)
   - Activity logging patterns repeated across files

### Immediate Actions Required

**Priority 1: SQLite Migration**
- Migrate brain state from JSON to `brain_state` table
- Migrate task queue from JSON to `tasks` table  
- Migrate message queue from JSON files to `messages` table
- Migrate toolbox from JSON to `tools` table

**Priority 2: Code Consolidation**
- Create `src/db/utils.ts` for database connection patterns
- Create `src/utils/json.ts` for safe JSON operations
- Create `src/utils/errors.ts` for error handling utilities
- Consolidate duplicate type definitions in `src/types/index.ts`

**Priority 3: API Fixes**
- Fix `agents.ts` and `activity.ts` to use `HttpError` middleware
- Add proper type validation for JSON parsing operations

### Recommended Fixes

- **Database Utilities**: Create shared helpers for connection management
- **JSON Safety**: Implement schema validation with Zod or similar
- **Type Safety**: Define specific interfaces, remove `Record<string, unknown>` patterns
- **Error Handling**: Standardize error patterns across all routes

## Questions?

If you're unsure about an architectural decision:

1. Check this file and `docs/architecture/` first
2. Use the `get_architectural_guidance` MCP tool (when available)
3. Create a proposal for significant changes
4. Ask the human via mail for critical decisions
