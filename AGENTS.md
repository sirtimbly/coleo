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

## Copilot Rules

### Semantic Code Search (search_code)

**ALWAYS use `search_code` when:**
- Looking for how something is implemented ("how do we handle auth?")
- Finding where logic lives ("where are errors processed?")
- Searching for code patterns ("find all API endpoint handlers")
- Understanding related functionality ("code related to user sessions")
- The search is conceptual rather than literal string matching

**Only use grep/glob when:**
- You need regex pattern matching or counting occurrences
- Looking for files by exact name pattern

**Filtering options:**
- `query`: Natural language description
- `include_extensions`: File types (e.g., ".ts,.tsx")
- `exclude_patterns`: Paths to exclude (e.g., "test,__tests__")
- `must_contain`: Required terms that must appear

**Examples:**
```
search_code(query="React hooks", include_extensions=".ts,.tsx")
search_code(query="authentication", exclude_patterns="test,__tests__")
```

### Documentation Search (search_docs)

Use for GDS Design System, Engineering Portal ADRs/guides, and API docs.

**Sources:**
- `gds`: Design system components and guidelines
- `eng_portal`: Architecture decisions and RFCs
- `api`: API specifications

**Examples:**
```
search_docs(query="Button component variants")
search_docs(query="authentication architecture", sources="eng_portal")
```

### API Search (search_api)

Use to find API endpoints by capability, service, or HTTP method.

**Parameters:**
- `query`: What you're looking for
- `service`: Filter by service name
- `method`: Filter by HTTP method

**Examples:**
```
search_api(query="create field")
search_api(query="authentication", service="auth-svc", method="POST")
```

### Tool Selection Guide

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
