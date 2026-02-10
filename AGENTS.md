# Octopai Agent Guidelines

Octopai is an AI agent orchestrator - a central brain coordinates semi-autonomous "arms" (AI agents).

## Build, Test & Lint Commands

```bash
# Type checking (ALWAYS run after changes)
bun run typecheck

# Tests (bun:test)
bun test src/**/__tests__/                    # Run all tests
bun test src/api/__tests__/tasks.test.ts     # Run single test file
bun run test:watch                           # Watch mode

# Integration & E2E
bun run test:integration   # Quick regression tests
bun run test:e2e          # Full regression suite

# Build
bun run build             # Build CLI + web
bun run web:build         # Build web only (workspace)

# Lint (web workspace)
bun run --cwd src/web lint

# Dev servers
bun run dev               # CLI dev
bun run server            # API server
bun run web:dev           # Vite dev server
bun run brain             # Brain process
```

## System of Record

**SQLite is the system of record.** Don't create JSON files for state.

| Data | Location |
|------|----------|
| Arms, Proposals, Activity, Config, Claims | `~/.octopai/octopai.db` |
| MCP configs | `~/.octopai/mcp/*.json` (generated) |
| Mail | `~/.octopai/mail/` (Maildir) |

## Technology Stack

Bun, TypeScript (strict), Hono, SQLite (bun:sqlite), React + Vite + TailwindCSS + shadcn/ui, MCP, Maildir

## Code Organization

```
src/
├── api/     # Hono API server (routes in src/api/routes/*.ts)
├── arm/     # Arm spawning/management
├── brain/   # Central coordinator
├── cli/     # CLI commands
├── db/      # Database/migrations
├── mail/    # Maildir implementation
├── mcp/     # MCP server
├── types/   # Shared types
└── web/     # React frontend (separate package.json)
```

## Code Style Guidelines

### TypeScript
- **Strict mode enabled** - avoid `any`, use `unknown` with type guards
- **Explicit return types** on exported functions
- Use `interface` for object shapes, `type` for unions/aliases
- Prefer `const` assertions for literal types

### Naming Conventions
- **Files**: kebab-case (e.g., `task-manager.ts`)
- **Functions/Variables**: camelCase
- **Classes/Interfaces**: PascalCase
- **Constants**: UPPER_SNAKE_CASE for true constants
- **Database columns**: snake_case
- **TypeScript properties**: camelCase
- **Terminology**: "arm" not "tentacle", "harness" = agent type, "domain" = expertise area

### Imports
- Group: external deps → internal modules → types
- Use `import type { Foo }` for type-only imports
- Prefer absolute imports for cross-module references
- Use `bun:sqlite` not `node:sqlite`

### Formatting
- Follow existing file style (tabs vs spaces, quotes, trailing commas)
- No repo-wide formatter; web code is linted via ESLint (`src/web/eslint.config.js`)

### Error Handling
- Use `HttpError` middleware in API routes (`src/api/middleware/error.ts`)
- Always return `{ error: string }` for errors
- Status codes: 400 (bad request), 401 (unauthorized), 403 (forbidden), 404 (not found), 500 (server error)
- Log unexpected errors with context

### API Routes
- Create routes in `src/api/routes/*.ts`
- Return `{ arm: ... }` or `{ arms: [...] }` for single/plural resources
- Use parameterized queries only (SQL injection prevention)
- Apply `HttpError` for consistent error responses

### Database
- Migrations in `src/db/index.ts`
- **Brain/DB separation**: `src/brain/**` must NOT import `bun:sqlite`
- Brain reads/writes through HTTP API calls
- API server is the only layer that talks to SQLite
- Use WAL mode, foreign keys ON

### Testing
- Use `bun:test` (describe, it, expect, beforeEach, afterEach)
- Create in-memory SQLite DB for tests
- Clean up resources in `afterEach`
- Test file naming: `*.test.ts`

## Multi-Agent Contention

1. Run `git status` before committing - check for unexpected changes
2. Don't commit files you didn't change
3. Check `claims` table before editing, use `claim_file` for major edits

Signs: unexpected modified files, files changing between reads, merge conflicts, TypeScript errors in untouched files.

## Semantic Search Tools

Use `search_code` for conceptual queries instead of grep:

```typescript
search_code(
  query="how errors are handled",
  include_extensions=".ts,.tsx",
  exclude_patterns="test,node_modules",
  must_contain="functionA,functionB"
)
```

Use `search_docs` for GDS components, ADRs, guides.
Use `search_api` for API endpoint discovery.

## Copilot Instructions (Required)

From `.github/copilot-instructions.md`:
- ALWAYS use `search_code` for conceptual code search (implementation details, related logic, patterns).
- Use file search or grep only for regex matching or exact filename/pattern lookups.
- `search_code` supports filtering: `include_extensions`, `exclude_patterns`, `must_contain`.
- Use `search_docs` for internal docs (GDS, ADRs, guides) and `search_api` for API specs.

## Cursor Rules

No `.cursorrules` or `.cursor/rules/` found in this repo.

## External SDK Integration

Prefer official SDKs over raw fetch:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
```

Note: OpenCode SDK uses object format for models: `{ providerID: "opencode", modelID: "grok-code" }`
