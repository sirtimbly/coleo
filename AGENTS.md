# Agent Guidelines

This document orients agentic contributors. Respect existing patterns, document every non-trivial change, and treat this repo as the single source of truth.

## Build, Lint, Test

- **Root services**
  - `bun run dev` (launch CLI + web dev servers)
  - `bun run server`, `bun run brain` (start standalone API/brain stacks)
- **Web workspace (`src/web`)**
  - `bun run web:dev`, `bun run web:build`, `bun run web:preview`
- **Type checking & lint**
  - `bun run typecheck`
  - `bun run --cwd src/web lint` (ESLint lives inside the web package)
- **Testing**
  - `bun test` (runs `src/**/__tests__/*.test.ts` via Bun)
  - `bun run test:watch`
  - `bun test src/api/__tests__/tasks.test.ts` (single file)
  - `bun test -t "task creates"` (title match; Bun `-t` filters)
  - `bun run test:integration` and `bun run test:e2e`
- **Build artifacts**
  - `bun run build` (Vite + Bun CLI build path)
- **Docs**
  - `bun run docs:dev`, `bun run docs:build`, `bun run docs:preview`

## Code Style Guidelines

### TypeScript
- The repo uses `strict` mode; avoid `any`. Prefer `unknown` with guards if you must defer typing.
- Exported functions and hooks need explicit return types; internal helpers may infer.
- Use `interface` for data shapes and `type` for unions/aliases or recursive definitions.
- Favor `as const` when fixing literal values and `satisfies` when validating structure.
- Keep files limited in scope (single responsibility) and break large files into folders under `src/*`.
- Keep mutation localized: prefer `const`, `readonly`, and immutable helpers when possible.
- Separate helpers from UI components; extract business logic into plain functions or hooks.

### Imports
- Order imports: external packages first, then internal modules, then type-only statements.
- Use `import type { Foo }` for pure types and keep them at the bottom of the block.
- Prefer absolute paths for cross-module imports (e.g., `src/api/...`); keep relatives for same folder logic.
- Use Bun-specific shims (`bun:sqlite`, `bun:test`) for platform integrations.

### Naming
- Files and folders: kebab-case (e.g., `task-manager.ts`).
- Functions/variables: camelCase.
- Types/interfaces/classes: PascalCase.
- Constants/hard-coded enums: UPPER_SNAKE_CASE.
- Domain-specific terms: refer to `arm` (never `tentacle`), `harness` for agent kinds, `proposal` for queued work.

### Formatting
- Mirror existing delimiter choices (quotes, commas, trailing) within each file.
- Apply Bun/Vite defaults instead of adding another formatter; run `bun fmt` if introduced to repo.
- Keep lines reasonably short (~120 cols). Wrap long chains or template helpers onto multiple lines.

### Observability
- Include request ids, route names, and relevant params/ids in logs coming from the server.
- When instrumenting ops use Bun-compatible loggers; keep log volume reasonable during normal runs.
- Prefer structured logging over ad-hoc `console.log` whenever you need to correlate events.

### Frontend & UX
- When updating UI, aim for expressive typography, deliberate color palettes, and purposeful layouts rather than default stacks.
- Prefer gradients, patterns, or subtle atmospherics over flat, single-color backgrounds; avoid purple-on-white or dark-mode bias unless the design system already uses it.
- Introduce meaningful motion (page-load, staggered reveals) and ensure components feel intentional on desktop and mobile.
- If you work inside an existing design system, preserve its visual language and spacing rather than inventing a new theme.

### Error Handling
- API routes should throw or pass through instances of `HttpError` from `src/api/middleware/error.ts` for expected failures.
- Unexpected issues should bubble up; middleware captures/logs them and returns `{ error: string }`.
- Prefer explicit status codes: 400 (validation), 401/403 (authz), 404 (missing), 500 (server).
- Log contextual information (request id, route, params) when handling unexpected errors.

### API Routes
- Routes live in `src/api/routes/*.ts`; each route exports handlers with strict typings.
- Responses follow normalized shapes such as `{ arm: ... }`, `{ arms: [...] }`, `{ error: string }`.
- Always use parameterized SQL or prepared statements; never interpolate raw strings into queries.
- Apply `HttpError` before sending to ensure consistent payloads.

### Database & Persistence
- Migrations/code in `src/db/index.ts`; keep schema changes backward-compatible when possible.
- Use SQLite with WAL mode and foreign key enforcement; treat `~/.octopai/octopai.db` as the system of record.
- `brain` packages must not `import bun:sqlite`; interact with the DB exclusively through HTTP APIs.
- Do not add JSON state files; rely on the database or existing config locations.

### Testing Practices
- Tests live in `src/**/__tests__/*.test.ts` and use Bun's `describe/it/expect` semantics.
- Prefer in-memory SQLite and clean state in `afterEach`; avoid hitting production DB files.
- Mock external services and use real HTTP endpoints sparingly.
- Keep each test fast and focused; split large suites into smaller files if execution slows down.

## System & Tooling Notes

### System of Record
- Database states (arms, proposals, activity, claims) live in `~/.octopai/octopai.db`.
- Generated MCP configs: `~/.octopai/mcp/*.json`.
- Maildir: `~/.octopai/mail/` (Maildir format).

### Technology Stack
- Bun + TypeScript (strict), Hono (API server), SQLite (`bun:sqlite`).
- React + Vite + TailwindCSS + shadcn/ui powering `src/web`.
- Custom MCP/brain orchestrations run alongside Maildir handling.

### Code Organization
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

### Lint
- `bun run --cwd src/web lint` - Run ESLint on the web workspace

### Search & Tooling Guidance

**Semantic Code Search (`search_code`)**
- Use for conceptual matches, usage examples, or semantics rather than exact strings
- **When to use:** Looking for how something is implemented, finding where logic lives, searching for code patterns, understanding related functionality
- **When NOT to use:** Regex pattern matching, counting occurrences, looking for exact filenames
- **Advanced filters:** `include_extensions` (e.g., ".ts,.tsx"), `exclude_patterns` (e.g., "node_modules,test"), `must_contain` (exact terms), `must_contain_all` (true=ALL terms)

**Examples:**
```
search_code(query="React hooks", include_extensions=".ts,.tsx")
search_code(query="authentication", exclude_patterns="test,.spec,__tests__")
search_code(query="business operations", must_contain="useBusinessOperations,isMultiOp")
```

**Documentation Search (`search_docs`)**
- Sources: `gds` (GDS Design System), `eng_portal` (ADRs, guides, RFCs), `api` (API specifications)
- Leave `sources` empty to search all documentation

**API Search (`search_api`)**
- Find endpoints for specific capabilities
- Filter by `service` name or `method` (HTTP method)

**Examples:**
```
search_api(query="create field")
search_api(query="authentication", service="auth-svc", method="POST")
```

**When to Use Which Tool**
| Need | Tool |
|------|------|
| Find code in this project | `search_code` |
| Find GDS component usage | `search_docs` (sources="gds") |
| Find architecture decisions | `search_docs` (sources="eng_portal") |
| Find API endpoints | `search_api` |

**Reserve glob/grep for:** filename queries, regex matches, or performance-sensitive lookups.
Use semantic search tools before opening files to avoid unnecessary context switching.

### Cursor Rules
- There are currently no `.cursorrules` or `.cursor/rules/` entries in this repository.

### Multi-Agent Collaboration
- Always run `git status` before making commits and ensure you only stage files you modified.
- Check claims (via `claim_file`) before editing shared artifacts and release or transfer claims when done.
- Treat `bun run dev` as a quick smoke test when you touch server/web bridges.

### Documentation & Planning
- Read docs under `docs/` before touching large systems; files describe plans, requirements, and architecture decisions.
- Update documentation whenever you introduce new public-facing behavior, APIs, or persistent procedures.
- Keep documentation changes self-contained; link to plan IDs in code comments if the brain issues follow-up tasks.

### External SDK Guidance
- Prefer official SDKs (e.g., `@opencode-ai/sdk`) over manual HTTP when integrating with external services.
- Example pattern:
  ```ts
  import { createOpencodeClient } from "@opencode-ai/sdk";

  const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
  ```
- When instantiating OpenCode SDK objects, follow the `{ providerID: "opencode", modelID: "grok-code" }` shape.
- Cache SDK clients per arm/lifecycle where it reduces jitter; reuse objects when safe.
