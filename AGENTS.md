```diff
*** Begin Patch
*** Add File: AGENTS.md
Index: adds agent guide
===================================================================
--- /dev/null
+++ b/AGENTS.md
@@
# Agent Guidelines

## Build, Lint, Test
```bash
# Type checking
bun run typecheck

# Run all unit tests
bun test

# Run a single test or file
bun test src/api/__tests__/tasks.test.ts       # run one file
bun test -t "task creates"                    # run tests matching title

# Integration & E2E tests
bun run test:integration
bun run test:e2e

# Build outputs
bun run build
bun run web:build

# Lint (web only)
bun run --cwd src/web lint

# Dev servers
bun run dev
bun run server
bun run web:dev
bun run brain

# Docs site
bun run docs:dev
bun run docs:build
```

## Code Style Guidelines

### TypeScript
- Strict mode enabled; avoid `any`. Use `unknown` with type guards when needed.
- Explicit return types on exported functions.
- Use `interface` for object shapes; `type` for unions/aliases.
- Prefer `const` assertions for literal types.

### Naming Conventions
- Files: kebab-case (e.g., `task-manager.ts`).
- Functions/variables: camelCase.
- Classes/interfaces: PascalCase.
- Constants: UPPER_SNAKE_CASE.
- Database columns: snake_case.
- TS properties: camelCase.
- Terminology: use "arm" not "tentacle"; "harness" = agent type; "domain" = expertise area.

### Imports
- Group imports: external → internal → types.
- Use `import type { Foo }` for type-only imports.
- Prefer absolute imports for cross-module; use relative within same module.
- Use `bun:sqlite` not `node:sqlite`.

### Formatting
- Follow existing file style (tabs vs spaces, quotes, trailing commas).
- No repo-wide formatter; web code is linted via ESLint (`src/web/eslint.config.js`).

### Error Handling
- API routes use `HttpError` middleware (`src/api/middleware/error.ts`).
- Return `{ error: string }` for errors.
- Status codes: 400, 401, 403, 404, 500.
- Log unexpected errors with context.

### API Routes
- Create routes in `src/api/routes/*.ts`.
- Return `{ arm: ... }` or `{ arms: [...] }`.
- Use parameterized queries only.
- Apply `HttpError` for consistent responses.

### Database
- Migrations in `src/db/index.ts`.
- `src/brain/**` must NOT import `bun:sqlite`.
- Brain interacts via HTTP API only.
- Enable WAL mode; enforce foreign keys.

### Testing
- Use `bun:test` (describe, it, expect, beforeEach, afterEach).
- Create in-memory SQLite DB for tests.
- Clean up in `afterEach`.
- Test file naming: `*.test.ts`.

## System of Record
SQLite is the system of record. Do not create JSON files for state.
| Data                                         | Location                              |
|----------------------------------------------|---------------------------------------|
| Arms, Proposals, Activity, Config, Claims    | `~/.octopai/octopai.db`               |
| MCP configs                                  | `~/.octopai/mcp/*.json` (generated)   |
| Mail                                         | `~/.octopai/mail/` (Maildir)          |

## Technology Stack
Bun · TypeScript (strict) · Hono · SQLite (`bun:sqlite`) · React · Vite · TailwindCSS · shadcn/ui · MCP · Maildir

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

## Semantic Code Search (Copilot Rules)
These rules are from `.github/copilot-instructions.md`.

### When to Use Semantic Search
**Always** use `search_code` when:
- Looking for how something’s implemented or where logic lives.
- Searching conceptual patterns, related functionality, or co‑occurring functions.
- The query is conceptual, not an exact string match.

**Only use file search / grep** when:
- You need regex matching or counting.
- Searching by exact name pattern.

### Advanced Filtering
| Param                | Description                                  |
|----------------------|----------------------------------------------|
| `query`              | Natural language description                 |
| `include_extensions` | File types to include (e.g. ".ts,.tsx")      |
| `exclude_patterns`   | Paths to exclude (e.g. "test,.spec")         |
| `must_contain`       | Exact terms that must appear                 |
| `must_contain_all`   | true=all terms must match; false=any         |

### Examples
```bash
search_code(query="React hooks", include_extensions=".ts,.tsx")
search_code(query="authentication", exclude_patterns="test,.spec")
search_code(
  query="business operations handling",
  must_contain="useBusinessOperations,isMultiOp"
)
```

## Documentation Search
Use `search_docs` for internal docs (GDS, ADRs, guides, RFCs).
Example:
```bash
search_docs(query="Button component variants", sources="gds")
```

## API Search
Use `search_api` for API endpoints and formats.
Example:
```bash
search_api(query="create field", service="fields-svc", method="POST")
```

## When to Use Which Tool
| Need                           | Tool          |
|--------------------------------|---------------|
| Find code in this project      | `search_code` |
| Find GDS component docs        | `search_docs` |
| Find architecture decisions    | `search_docs` |
| Find API endpoints             | `search_api`  |

## Cursor Rules
No `.cursorrules` or `.cursor/rules/` found in this repo.

## Multi-Agent Contention
- Run `git status` before committing; check for unexpected changes.
- Do not commit files you did not change.
- Check the `claims` table before editing; use `claim_file` for major edits.

## External SDK Integration
Prefer official SDKs over raw fetch:
```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
```
Note: OpenCode SDK uses object format: `{ providerID: "opencode", modelID: "grok-code" }`.
*** End Patch
```
