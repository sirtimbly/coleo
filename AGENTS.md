# Agent Guidelines

This file is for coding agents working in this repo. Keep changes minimal and follow existing patterns.

## Build, Lint, Test

```bash
# Root dev/servers
bun run dev
bun run server
bun run brain

# Web dev (src/web)
bun run web:dev
bun run web:build
bun run web:preview

# Type checking
bun run typecheck

# Unit tests
bun test
bun run test:watch

# Run a single test file
bun test src/api/__tests__/tasks.test.ts

# Run tests matching a title
bun test -t "task creates"

# Integration and E2E tests
bun run test:integration
bun run test:e2e

# Build outputs (CLI + web + templates)
bun run build

# Web lint (only web package has ESLint)
bun run --cwd src/web lint

# Docs
bun run docs:dev
bun run docs:build
bun run docs:preview
```

Notes:
- The root `build` script runs Vite for `src/web` and then Bun build for CLI.
- Unit tests live under `src/**/__tests__/` and use Bun's test runner.

## Code Style Guidelines

### TypeScript
- Repo uses `strict` TypeScript. Avoid `any`; use `unknown` with type guards.
- Add explicit return types for exported functions.
- Prefer `interface` for object shapes and `type` for unions/aliases.
- Use `as const` for literal types when needed.
- Use `satisfies` operator for type-safe object literals.

### Naming Conventions
- Files: kebab-case (example: `task-manager.ts`).
- Functions/variables: camelCase.
- Classes/interfaces/types: PascalCase.
- Constants: UPPER_SNAKE_CASE.
- Database columns: snake_case.
- Terminology: use "arm" (not "tentacle"); "harness" means agent type.

### Imports
- Order: external packages, internal modules, then type-only imports.
- Use `import type { Foo }` for type-only usage.
- Prefer absolute imports across modules; relative imports within a module.
- Use `bun:sqlite` (not `node:sqlite`).

### Formatting
- Follow the existing file's style (tabs/spaces, quotes, trailing commas).
- No repo-wide formatter in root; `src/web` uses ESLint.

### Error Handling
- API routes should use `HttpError` middleware (`src/api/middleware/error.ts`).
- API error payload shape is `{ error: string }`.
- Common status codes: 400, 401, 403, 404, 500.
- Log unexpected errors with context for debugging.
- Use `HttpError` for expected errors; let unexpected errors bubble up to be caught by middleware.

### API Routes
- Routes live in `src/api/routes/*.ts`.
- Response shapes: `{ arm: ... }` or `{ arms: [...] }` when applicable.
- Use parameterized SQL queries only.
- Apply `HttpError` for consistent responses.

### Database
- Migrations in `src/db/index.ts`.
- `src/brain/**` must not import `bun:sqlite`.
- Brain interacts with the DB via HTTP API only.
- Use WAL mode and enforce foreign keys.

### Testing
- Use `bun:test` APIs (`describe`, `it`, `expect`, `beforeEach`, `afterEach`).
- Prefer in-memory SQLite for tests and clean up in `afterEach`.
- Test files: `*.test.ts` under `src/**/__tests__/`.

## System of Record
SQLite is the system of record. Do not add JSON state files.

| Data | Location |
| --- | --- |
| Arms, Proposals, Activity, Config, Claims | `~/.octopai/octopai.db` |
| MCP configs | `~/.octopai/mcp/*.json` (generated) |
| Mail | `~/.octopai/mail/` (Maildir) |

## Technology Stack
Bun, TypeScript (strict), Hono, SQLite (`bun:sqlite`), React, Vite, TailwindCSS, shadcn/ui, MCP, Maildir.

## Code Organization
```
src/
├── api/       # Hono API server (routes in src/api/routes/*.ts)
├── arm/       # Arm spawning/management
├── brain/     # Central coordinator
├── cli/       # CLI commands
├── db/        # Database/migrations
├── mail/      # Maildir implementation
├── mcp/       # MCP server
├── types/     # Shared types
└── web/       # React frontend (separate package.json)
```

## Copilot Instructions (from .github/copilot-instructions.md)

### Semantic Code Search
Use `search_code` for conceptual or related code discovery.

Always use `search_code` when:
- Looking for how something is implemented.
- Finding where logic lives.
- Searching for code patterns or related functionality.
- The query is conceptual rather than an exact string match.
- Finding files that contain specific functions together.

Only use file search/grep when:
- You need regex matching or counting.
- You are searching for files by name pattern.

Advanced filters supported by `search_code`:
- `query` (natural language)
- `include_extensions` (example: `.ts,.tsx`)
- `exclude_patterns` (example: `node_modules,test,.spec`)
- `must_contain` (comma-separated exact terms)
- `must_contain_all` (`true` or `false`)

Examples:
```bash
search_code(query="React hooks", include_extensions=".ts,.tsx")
search_code(query="authentication", exclude_patterns="test,.spec,__tests__")
search_code(
  query="business operations handling",
  must_contain="useBusinessOperations,isMultiOp"
)
```

### Documentation Search
Use `search_docs` for internal documentation (GDS, ADRs, guides, RFCs).

```bash
search_docs(query="Button component variants and props")
search_docs(query="authentication architecture", sources="eng_portal")
```

### API Search
Use `search_api` to find endpoints and request/response formats.

```bash
search_api(query="create field")
search_api(query="authentication", service="auth-svc", method="POST")
```

### Tool Choice Summary
| Need | Tool |
| --- | --- |
| Find code in this project | `search_code` |
| Find GDS component usage | `search_docs` (sources="gds") |
| Find architecture decisions | `search_docs` (sources="eng_portal") |
| Find API endpoints | `search_api` |

## Cursor Rules
No `.cursorrules` or `.cursor/rules/` found in this repo.

## Multi-Agent Contention
- Run `git status` before committing; check for unexpected changes.
- Do not commit files you did not change.
- Check the claims table before editing; use `claim_file` for major edits.

## External SDK Integration
Prefer official SDKs over raw fetch when available:
```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
```

OpenCode SDK uses object format: `{ providerID: "opencode", modelID: "grok-code" }`.
