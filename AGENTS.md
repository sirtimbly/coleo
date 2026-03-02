# Agent Guidelines

This document orients agentic contributors working on Coleo, an AI agent orchestrator using the Octopus Model.

## Build, Lint, Test

### Development Commands
- `bun run dev` - Launch CLI + web dev servers concurrently
- `bun run server` - Start standalone API server (port 8080)
- `bun run brain` - Start standalone brain process

### Web Workspace (`src/web/`)
- `bun run web:dev` - Start Vite dev server
- `bun run web:build` - Production build with type checking
- `bun run web:preview` - Preview production build locally
- `bun run --cwd src/web lint` - Run ESLint on web code

### Type Checking & Linting
- `bun run typecheck` - Run `tsc --noEmit` across the project
- `bun run shellcheck` - Lint shell scripts in `bin/`
- `bun run check` - Run both shellcheck and typecheck

### Testing
- `bun test` - Run all tests in `src/**/__tests__/*.test.ts`
- `bun test src/api/__tests__/tasks.test.ts` - Run single test file
- `bun test -t "pattern"` - Filter tests by title pattern
- `bun test --watch` - Run tests in watch mode
- `bun run test:integration` - Quick regression suite
- `bun run test:e2e` - Full regression test suite

### Build & Deploy
- `bun run build` - Full production build (setup + web + CLI)
- `bun run setup` - Install dependencies for all workspaces

### Documentation
- `bun run docs:dev` - Start VitePress dev server
- `bun run docs:build` - Build static documentation
- `bun run docs:preview` - Preview built docs

### Infrastructure
- `docker compose up -d` - Start Qdrant, NATS, Gitea services
- `bun run nats:install` - Install NATS server binary
- `bun run nats:run` - Run NATS with JetStream enabled

## Code Style Guidelines

### TypeScript
- Use `strict` mode; avoid `any`, prefer `unknown` with type guards
- Explicit return types for exported functions/hooks; infer for internal helpers
- Use `interface` for object shapes; `type` for unions, aliases, recursive types
- Favor `as const` and `satisfies` for literal validation
- Keep files focused; escalate files >600 lines for refactoring
- Prefer immutable patterns (`const`, `readonly`)
- Separate business logic from UI components

### Imports
- Order: external packages → internal modules → type-only imports
- Use `import type {Foo}` for pure type imports (place at bottom)
- Prefer absolute paths (`src/...`) for cross-module imports
- Use relative imports only for same-folder modules
- Use Bun shims (`bun:sqlite`, `bun:test`) for platform integrations

### Naming Conventions
- Files/folders: kebab-case (`task-manager.ts`, `arm-spawner/`)
- Variables/functions: camelCase (`processTask`, `armConfig`)
- Types/interfaces/classes: PascalCase (`TaskManager`, `ArmConfig`)
- Constants/enums: UPPER_SNAKE_CASE (`MAX_RETRY_COUNT`)
- Domain terms: `arm`, `harness`, `proposal`, `brain`, `poll`

### Formatting
- Mirror existing delimiter choices (quotes, commas, trailing commas)
- Use Bun/Vite defaults; run `bun fmt` if formatting changes introduced
- Wrap lines at ~120 columns; break long chains onto multiple lines
- Use 2-space indentation consistently

### Error Handling
- Throw or pass through `HttpError` from `src/api/middleware/error.ts` for expected failures
- Unexpected errors bubble up; middleware logs and returns `{error: string}`
- Explicit status codes: 400 (validation), 401/403 (authz), 404 (not found), 500 (server)
- Include request ID, route, and params in error logs

### Testing Patterns
- Place tests in `__tests__/` directories adjacent to source code
- Name test files `*.test.ts` (or `*.test.tsx` for React)
- Use `bun:test` for assertions and test utilities
- Mock external dependencies; test business logic in isolation

## Cursor Rules

No `.cursorrules` or `.cursor/rules/` entries present in this repository.

## Semantic Code Search

This project has semantic code search enabled via the `search_code` MCP tool.

**ALWAYS use `search_code` when:**
- Looking for how something is implemented
- Finding where logic lives
- Searching for code patterns
- Understanding related functionality
- The search is conceptual rather than literal string matching

**Only use file search / grep when:**
- You need regex pattern matching or counting occurrences
- Looking for files by exact name pattern

## Advanced Filtering

The `search_code` tool supports powerful filtering:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `query` | Natural language description | "authentication logic" |
| `include_extensions` | Only these file types | ".ts,.tsx" |
| `exclude_patterns` | Exclude paths containing | "node_modules,test,.spec" |
| `must_contain` | Exact terms that must appear | "useQuery,useMutation" |
| `must_contain_all` | true=ALL terms, false=ANY | true |

## Examples

Find TypeScript files about hooks:
```
search_code(query="React hooks", include_extensions=".ts,.tsx")
```

Find auth code excluding tests:
```
search_code(query="authentication", exclude_patterns="test,.spec,__tests__")
```

Find files using specific functions together:
```
search_code(
  query="business operations handling",
  must_contain="useBusinessOperations,isMultiOp"
)
```

## Tool Details

The `search_code` tool uses vector embeddings to find semantically similar code.
- Combines semantic understanding with exact term matching
- Returns file paths, relevance scores, and code snippets
- Works best with natural language queries describing what you're looking for

---

# Documentation Search

This project has access to internal documentation via `search_docs` and `search_api` MCP tools.

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

## When to Use Which Tool

| Need | Tool |
|------|------|
| Find code in this project | `search_code` |
| Find GDS component usage | `search_docs` (sources="gds") |
| Find architecture decisions | `search_docs` (sources="eng_portal") |
| Find API endpoints | `search_api` |
| Regex pattern matching | `grep` |
| Exact file name search | `glob`

## `search_api` - API Specifications

Use this when you need to:
- Find API endpoints for specific capabilities
- Understand request/response formats
- Discover available services and operations

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `query` | What you're looking for | "create field" |
| `service` | Filter by service name | "fields-svc" |
| `method` | Filter by HTTP method | "POST" |

### Examples

Find endpoints for creating fields:
```
search_api(query="create field")
```

Find all POST endpoints in auth service:
```
search_api(query="authentication", service="auth-svc", method="POST")
```

## When to Use Which Tool

| Need | Tool |
|------|------|
| Find code in this project | `search_code` |
| Find GDS component usage | `search_docs` (sources="gds") |
| Find architecture decisions | `search_docs` (sources="eng_portal") |
| Find API endpoints | `search_api` |
| Regex pattern matching | `grep` |
| Exact file name search | `glob` |

## Project Structure

- `src/api/` - Hono-based REST API and WebSocket server
- `src/brain/` - Brain polling loop and task orchestration
- `src/arm/` - Arm lifecycle management and spawner
- `src/harness/` - LLM provider integrations (OpenAI, etc.)
- `src/mcp/` - Model Context Protocol server implementation
- `src/nats/` - NATS messaging for distributed arms
- `src/web/` - React + Vite dashboard frontend
- `src/mail/` - Maildir and IMAP integration
- `docs/` - VitePress documentation

## Shell Scripts

- Use `set -euo pipefail` in all shell scripts
- Validate required commands with `require_cmd` helper
- Handle OS/architecture differences for cross-platform compatibility
- Use temporary directories with cleanup traps
- Install binaries with proper permissions (0755)
