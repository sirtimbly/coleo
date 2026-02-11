# Agent Guidelines
This repo is an AI agent orchestrator (brain + arms). Keep edits small, precise, and consistent with existing patterns.

## Build, Lint, Test
```bash
# Type checking
bun run typecheck

# Unit tests (bun:test)
bun test src/**/__tests__/
bun test src/api/__tests__/tasks.test.ts
bun test -t "task creates" src/api/__tests__/tasks.test.ts
bun run test:watch

# Integration & E2E
bun run test:integration
bun run test:e2e

# Build
bun run build
bun run web:build

# Lint (web workspace only)
bun run --cwd src/web lint

# Dev servers
bun run dev
bun run server
bun run web:dev
bun run brain

# Docs
bun run docs:dev
bun run docs:build
```
## System of Record
SQLite is the system of record. Do not create JSON files for state.
| Data | Location |
|------|----------|
| Arms, Proposals, Activity, Config, Claims | `~/.octopai/octopai.db` |
| MCP configs | `~/.octopai/mcp/*.json` (generated) |
| Mail | `~/.octopai/mail/` (Maildir) |
## Technology Stack
Bun, TypeScript (strict), Hono, SQLite (bun:sqlite), React + Vite + TailwindCSS + shadcn/ui, MCP, Maildir.
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
- Strict mode enabled; avoid `any`. Prefer `unknown` with type guards.
- Explicit return types on exported functions.
- Use `interface` for object shapes, `type` for unions/aliases.
- Prefer `const` assertions for literal types.

### Naming Conventions
- Files: kebab-case (e.g., `task-manager.ts`).
- Functions/variables: camelCase.
- Classes/interfaces: PascalCase.
- Constants: UPPER_SNAKE_CASE for true constants.
- Database columns: snake_case.
- TypeScript properties: camelCase.
- Terminology: "arm" not "tentacle", "harness" = agent type, "domain" = expertise area.

### Imports
- Group: external deps → internal modules → types.
- Use `import type { Foo }` for type-only imports.
- Prefer absolute imports for cross-module references (use relative inside a module when already nearby).
- Use `bun:sqlite` not `node:sqlite`.

### Formatting
- Follow existing file style (tabs vs spaces, quotes, trailing commas).
- No repo-wide formatter; web code is linted via ESLint (`src/web/eslint.config.js`).

### Error Handling
- API routes use `HttpError` middleware (`src/api/middleware/error.ts`).
- Always return `{ error: string }` for errors.
- Status codes: 400 (bad request), 401 (unauthorized), 403 (forbidden), 404 (not found), 500 (server error).
- Log unexpected errors with context.

### API Routes
- Create routes in `src/api/routes/*.ts`.
- Return `{ arm: ... }` or `{ arms: [...] }` for single/plural resources.
- Use parameterized queries only (SQL injection prevention).
- Apply `HttpError` for consistent error responses.

### Database
- Migrations live in `src/db/index.ts`.
- Brain/DB separation: `src/brain/**` must NOT import `bun:sqlite`.
- Brain reads/writes through HTTP API calls; API server is the only layer that talks to SQLite.
- Use WAL mode, foreign keys ON.

### Testing
- Use `bun:test` (describe, it, expect, beforeEach, afterEach).
- Create in-memory SQLite DB for tests.
- Clean up resources in `afterEach`.
- Test file naming: `*.test.ts`.

## Multi-Agent Contention
1. Run `git status` before committing; check for unexpected changes.
2. Do not commit files you did not change.
3. Check the `claims` table before editing; use `claim_file` for major edits.

Signs: unexpected modified files, files changing between reads, merge conflicts, TypeScript errors in untouched files.

## Semantic Search Tools (Copilot Rules)
These rules come from `.github/copilot-instructions.md`.

Use `search_code` when:
- Looking for how something is implemented.
- Finding where logic lives.
- Searching for code patterns.
- Understanding related functionality.
- The search is conceptual rather than a literal string match.
- Finding files that contain specific functions together.

Only use file search / grep when:
- You need regex pattern matching or counting occurrences.
- You are looking for files by exact name pattern.

`search_code` filters:
- `include_extensions`, `exclude_patterns`, `must_contain`, `must_contain_all`.

Use `search_docs` for internal docs (GDS, ADRs, guides, RFCs).
Use `search_api` for API endpoints and request/response formats.

## Cursor Rules
No `.cursorrules` or `.cursor/rules/` found in this repo.

## External SDK Integration
Prefer official SDKs over raw fetch:
```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
```

Note: OpenCode SDK uses object format for models: `{ providerID: "opencode", modelID: "grok-code" }`.
