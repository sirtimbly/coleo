# Agent Guidelines

This document orients agentic contributors. Respect existing patterns, document non-trivial changes, and treat this repo as the single source of truth.

## Build, Lint, Test

### Root Services
- `bun run dev` - Launch CLI + web dev servers
- `bun run server`, `bun run brain` - Start standalone API/brain stacks
- `bun run build` - Vite + Bun CLI build

### Web Workspace (`src/web`)
- `bun run web:dev`, `bun run web:build`, `bun run web:preview`

### Type Checking & Lint
- `bun run typecheck` - TypeScript check (strict mode)
- `bun run --cwd src/web lint` - ESLint on web workspace

### Testing
- `bun test` - Run all tests in `src/**/__tests__/*.test.ts`
- `bun test src/api/__tests__/tasks.test.ts` - Single file
- `bun test -t "task creates"` - Filter by title (Bun `-t` flag)
- `bun run test:watch` - Watch mode
- `bun run test:integration`, `bun run test:e2e` - Integration/e2e suites

### Docs
- `bun run docs:dev`, `bun run docs:build`, `bun run docs:preview`

## Code Style

### TypeScript
- `strict` mode with `noUncheckedIndexedAccess`, `noImplicitOverride`
- Avoid `any`. Use `unknown` with type guards when deferring types
- Exported functions/hooks: explicit return types. Internal helpers: inference OK
- `interface` for data shapes; `type` for unions/aliases
- `as const` for literal values; `satisfies` for structure validation
- Single responsibility per file; break large files into folders under `src/*`
- Prefer `const`, `readonly`, immutable patterns

### Code Comments
- **DO NOT add comments** unless explicitly asked
- Let code be self-documenting through clear naming

### Imports
- Order: external packages → internal modules → type-only imports
- `import type { Foo }` for pure types at bottom of import block
- Absolute paths for cross-module imports (`src/api/...`); relative for same folder
- Bun-specific: `bun:sqlite`, `bun:test` for platform integrations

### Naming
- Files/folders: kebab-case (`task-manager.ts`)
- Functions/variables: camelCase
- Types/interfaces/classes: PascalCase
- Constants/enums: UPPER_SNAKE_CASE
- Domain terms: `arm` (never `tentacle`), `harness` for agent kinds, `proposal` for queued work

### Formatting
- Match existing delimiter choices (quotes, commas, trailing)
- Lines ~120 cols; wrap long chains onto multiple lines

## Error Handling

### API Routes (`src/api/routes/*.ts`)
- Throw `HttpError` from `src/api/middleware/error.ts` for expected failures
- Status codes: 400 (validation), 401/403 (auth), 404 (missing), 500 (server)
- Responses: `{ arm: ... }`, `{ arms: [...] }`, `{ error: string }`
- Always use parameterized SQL; never interpolate strings

### Database (`src/db/index.ts`)
- SQLite with WAL mode, foreign key enforcement
- System of record: `~/.octopai/octopai.db`
- Brain packages must not `import bun:sqlite`; use HTTP APIs only
- No JSON state files; rely on database

## Testing

- Tests in `src/**/__tests__/*.test.ts` using Bun's `describe/it/expect`
- In-memory SQLite with clean state in `afterEach`
- Mock external services; avoid production DB files

## Frontend (`src/web`)

- React + Vite + TailwindCSS v4 + HeroUI v3 + TanStack Query
- Path alias: `@/` maps to `src/web/src/`
- Extract business logic into hooks; keep components focused on rendering
- Expressive typography, deliberate palettes, purposeful layouts
- Gradients/patterns over flat backgrounds; meaningful motion

## Observability

- Include request IDs, route names, params in server logs
- Prefer structured logging over `console.log`

## Technology Stack

- Runtime: Bun + TypeScript (strict)
- API: Hono framework
- Database: SQLite (`bun:sqlite`)
- Frontend: React + Vite + TailwindCSS v4 + shadcn/ui + HeroUI v3
- Messaging: NATS JetStream
- Orchestration: MCP/brain with Maildir

## Code Organization

```
src/
├── api/       # Hono routes and middleware
├── arm/       # Agent orchestration
├── brain/     # Central coordinator logic
├── cli/       # CLI commands and helpers
├── db/        # Schema + migrations
├── mail/      # Maildir implementation
├── mcp/       # MCP server code
├── types/     # Shared type declarations
└── web/       # React frontend package
```

## Search & Tooling

### Semantic Code Search
Use for conceptual matches, not literal strings:
- How something is implemented
- Where logic lives
- Code patterns

### Reserve glob/grep for
- Filename queries
- Regex matches
- Exact string counts

## Multi-Agent Collaboration

- Run `git status` before commits; only stage your modified files
- Check claims (`claim_file`) before editing shared artifacts
- `bun run dev` as smoke test when touching server/web bridges

## Documentation

- Read `docs/` before touching large systems
- Update docs for new public APIs or persistent procedures
- Link plan IDs in code comments for brain follow-up tasks

## External SDKs

- Prefer official SDKs (e.g., `@opencode-ai/sdk`) over manual HTTP
- Example: `createOpencodeClient({ baseUrl: "http://localhost:4096" })`
- Cache SDK clients per arm/lifecycle; reuse when safe
