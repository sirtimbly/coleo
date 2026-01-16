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

# Semantic Code Search

This project has semantic code search enabled via the `search_code` tool.

## IMPORTANT: Use `search_code` for Codebase Exploration

When exploring or understanding this codebase, **use `search_code` directly** instead of delegating to the `explore` agent with `glob`/`grep`. The `search_code` tool is faster and more accurate for conceptual queries.

## When to Use Semantic Search

**ALWAYS use `search_code` when:**
- Looking for how something is implemented ("how do we handle authentication?")
- Finding where logic lives ("where are errors processed?")
- Searching for code patterns ("find all API endpoint handlers")
- Understanding related functionality ("code related to user sessions")
- The search is conceptual rather than a literal string match
- You would otherwise use the Task tool with the `explore` agent
- Finding files that contain specific functions/identifiers together

**Only use `grep`/`glob` when:**
- You need regex pattern matching or counting occurrences
- Looking for files by exact name pattern

## Advanced Filtering

The `search_code` tool supports powerful filtering options:

```
search_code(
  query="description of what you're looking for",
  include_extensions=".ts,.tsx",           # Only search these file types
  exclude_patterns="node_modules,test",    # Exclude paths containing these
  must_contain="functionA,functionB",      # Results MUST contain these terms
  must_contain_all=true                    # true = ALL terms, false = ANY term
)
```

## Examples

### Basic semantic search
```
search_code(query="how are errors handled and displayed to users")
```

### Find TypeScript files only
```
search_code(query="React hooks", include_extensions=".ts,.tsx")
```

### Exclude test files
```
search_code(query="authentication logic", exclude_patterns="test,.spec,__tests__,mock")
```

### Find files using specific functions together
Instead of:
```
grep -r "useBusinessOperations.*isMultiOp\|isMultiOp.*useBusinessOperations" --include="*.ts"
```

Use:
```
search_code(
  query="business operations multi-op handling",
  include_extensions=".ts,.tsx",
  exclude_patterns="node_modules,.test.",
  must_contain="useBusinessOperations,isMultiOp"
)
```

## Tool Details

The `search_code` tool uses vector embeddings to find semantically similar code.
- Returns file paths, relevance scores, and code snippets
- Supports file type filtering, path exclusions, and required term matching
- Combines semantic understanding with exact term matching when needed
- Works best with natural language queries describing what you're looking for

---

# Documentation Search

This project has access to internal documentation via `search_docs` and `search_api` tools.

## `search_docs` - Internal Documentation

Use this when you need to find:
- **GDS Design System**: Component usage, props, variants, design guidelines
- **Engineering Portal**: ADRs, guides, RFCs, best practices
- **API Documentation**: Service capabilities and integration patterns

### Sources

| Source | Content |
|--------|---------|
| `gds` | GDS Design System components and guidelines |
| `eng_portal` | Engineering Portal (ADRs, guides, RFCs) |
| `api` | API specifications |

Leave `sources` empty to search all documentation.

### Examples

Find GDS Button component docs:
```
search_docs(query="Button component variants and props")
```

Search ADRs only:
```
search_docs(query="authentication architecture", sources="eng_portal")
```

Search all docs for testing guidance:
```
search_docs(query="unit testing best practices")
```

## `search_api` - API Specifications

Use this when you need to:
- Find API endpoints for specific capabilities
- Understand request/response formats
- Discover available services and operations
- Find schema definitions

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `query` | What you're looking for | "create field" |
| `service` | Filter by service name | "fields-svc" |
| `method` | Filter by HTTP method | "POST" |

### Available Services

Common services include: `fields-svc`, `auth-svc`, `user-svc`, `activities`, 
`crops-svc`, `imagery-api`, `integrations-svc`, `planning-svc`, and 40+ more.

### Examples

Find endpoints for creating fields:
```
search_api(query="create field")
```

Find all POST endpoints in auth service:
```
search_api(query="authentication", service="auth-svc", method="POST")
```

Find user-related endpoints:
```
search_api(query="get user profile")
```

## When to Use Which Tool

| Need | Tool |
|------|------|
| Find code in this project | `search_code` |
| Find GDS component usage | `search_docs` (sources="gds") |
| Find architecture decisions | `search_docs` (sources="eng_portal") |
| Find API endpoints | `search_api` |
| General documentation | `search_docs` (no sources filter) |
