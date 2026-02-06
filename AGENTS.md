# Octopai Agent Guidelines

Octopai is an AI agent orchestrator - a central brain coordinates semi-autonomous "arms" (AI agents).

## System of Record

**SQLite is the system of record.** Don't create JSON files for state.

| Data | Location |
|------|----------|
| Arms, Proposals, Activity, Config, Claims | `~/.octopai/octopai.db` |
| MCP configs | `~/.octopai/mcp/*.json` (generated) |
| Mail | `~/.octopai/mail/` (Maildir) |

## Technology Stack

Bun, TypeScript (strict), Hono, SQLite (bun:sqlite), React + Vite + TailwindCSS + shadcn/ui, MCP, Maildir

## Technology Selection Principles

### 1. Production-First Selection

**Don't "start simple and migrate later"** when migration cost exceeds setup cost. Octopai is distributed (NATS, containers, multiple arms) - adding a container fits the architecture.

**Choose production-grade when:** system is distributed, feature is core, long-running operation expected, migration would rewrite integration.

### 2. Distributed & Recoverable by Default

- Multiple arms run concurrently - no singleton assumptions
- Arms can die anytime - state must be recoverable
- Brain restarts are normal - derive state from persistent sources

### 3. Data Persistence Hierarchy

| Use Case | Technology |
|----------|------------|
| Structured state | SQLite |
| Event streams | NATS JetStream |
| Vector search | Qdrant |
| Human communication | Maildir |
| Configuration | TOML files |

See [ADR-011](.project/decisions/011-production-first-technology-selection.md) for full rationale.

## Code Organization

```
src/
├── api/     # Hono API server
├── arm/     # Arm spawning/management
├── brain/   # Central coordinator
├── cli/     # CLI commands
├── db/      # Database/migrations
├── mail/    # Maildir implementation
├── mcp/     # MCP server
├── types/   # Shared types
└── web/     # React frontend
```

## Conventions

**Database:** Migrations in `src/db/index.ts`. Parameterized queries only. `snake_case` columns, `camelCase` TypeScript.

**Brain/DB separation:** `src/brain/**` must not import `bun:sqlite` or open SQLite connections directly. The brain process reads/writes persistent state through HTTP API calls to `src/api/routes/**`, and the API server is the only layer that talks to SQLite.

**API:** Routes in `src/api/routes/*.ts`. Use `HttpError` middleware. Return `{ arm: ... }` or `{ arms: [...] }`.

**TypeScript:** Run `bun run typecheck`. Avoid `any`.

**Naming:** "arm" not "tentacle", "harness" = agent type, "domain" = expertise area.

## Multi-Agent Contention

1. Run `git status` before committing - check for unexpected changes
2. Don't commit files you didn't change - report via `report_contention` MCP tool
3. Check `claims` table before editing, use `claim_file` for major edits

Signs: unexpected modified files, files changing between reads, merge conflicts, TypeScript errors in untouched files.

## Search Tools

### `search_code` - Semantic Code Search

Use for conceptual queries instead of `grep`/`glob`:

```
search_code(
  query="how errors are handled",
  include_extensions=".ts,.tsx",
  exclude_patterns="test,node_modules",
  must_contain="functionA,functionB"
)
```

### `search_docs` - Documentation

| Source | Content |
|--------|---------|
| `gds` | GDS Design System |
| `eng_portal` | ADRs, guides, RFCs |
| `api` | API specs |

```
search_docs(query="Button component", sources="gds")
```

### `search_api` - API Endpoints

```
search_api(query="create field", service="fields-svc", method="POST")
```

## External SDK Integration

Prefer official SDKs over raw fetch for type safety:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
const session = await client.session.create({ body: { title: "Session" } });
```

Note: OpenCode SDK uses object format for models: `{ providerID: "opencode", modelID: "grok-code" }`

If no SDK exists: generate from OpenAPI spec, or create typed wrappers with interfaces.
