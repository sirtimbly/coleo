# Octopai Agent Guidelines

This file provides architectural context and guidelines for AI agents (arms) working on the Octopai codebase. All agents should read and follow these guidelines.

## Project Overview

Octopai is an AI agent orchestrator using the "Octopus Model" - a central brain coordinates semi-autonomous "arms" (AI agents), each with focused expertise and context budgets.

## System of Record

**SQLite is the system of record for all persistent state.**

| Data        | Storage    | Location                                               |
| ----------- | ---------- | ------------------------------------------------------ |
| Arms        | SQLite     | `~/.octopai/octopai.db` → `arms` table                 |
| Proposals   | SQLite     | `~/.octopai/octopai.db` → `proposals` table            |
| Activity    | SQLite     | `~/.octopai/octopai.db` → `activity` table             |
| Config      | SQLite     | `~/.octopai/octopai.db` → `config` table               |
| Claims      | SQLite     | `~/.octopai/octopai.db` → `claims` table               |
| MCP configs | JSON files | `~/.octopai/mcp/*.json` (generated, not authoritative) |
| Mail        | Maildir    | `~/.octopai/mail/` (human-agent communication)         |

**DO NOT** create JSON files for state that should be in SQLite. If you need to persist arm state, proposals, or configuration, use the database.

## Technology Stack

| Layer          | Technology                             |
| -------------- | -------------------------------------- |
| Runtime        | Bun                                    |
| Language       | TypeScript (strict mode)               |
| API Server     | Hono                                   |
| Database       | SQLite (bun:sqlite) with migrations    |
| Web UI         | React + Vite + TailwindCSS + shadcn/ui |
| Agent Protocol | MCP (Model Context Protocol)           |
| Mail           | Maildir format                         |

## Standard Protocols

When integrating with external services, prefer standard protocols over proprietary solutions.

### Agent Client Protocol (ACP)

ACP is an open standard for AI agent communication. OpenCode implements ACP (see `packages/opencode/src/acp/` in the OpenCode repository), which provides:

- **JSON-RPC 2.0** messaging over stdio
- **Session management** (`session/new`, `session/load`, `session/prompt`)
- **Capability negotiation** during initialization
- **Tool calling** with structured responses

Benefits of ACP:
- IDE integration (Zed, VS Code, etc. can connect directly)
- Interoperability with ACP-compliant tools
- Decoupling (arms can run as standalone ACP servers)

See `.project/plan.md` for ACP implementation roadmap.

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

## Multi-Agent Environment

This repository may have multiple arms working concurrently.

### Contention Protocol

1. **Before committing**: Run `git status` to check for unexpected changes
2. **If you see changes you didn't make**:
   - Do NOT commit those files
   - Report contention to the brain via MCP: `report_contention` tool
   - Include: conflicting files, your task, what you were trying to do
3. **File ownership**: Check `.octopai/claims` table for active file claims before editing
4. **Claim files**: Before major edits, claim files via `claim_file` MCP tool

### Signs of Contention

- Unexpected modified files in `git status`
- Files changing between reads
- Merge conflicts on commit
- TypeScript errors in files you didn't touch

### Reporting Contention (MCP)

// Use the brain MCP server to report
mcp.call('report_contention', {
  files: ['src/api/routes/index.ts', 'src/web/...'],
  my_task: 'regression test suite',
  other_changes: 'status reports feature, messaging page',
  action_taken: 'skipped committing those files'
});

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

| Source       | Content                                     |
| ------------ | ------------------------------------------- |
| `gds`        | GDS Design System components and guidelines |
| `eng_portal` | Engineering Portal (ADRs, guides, RFCs)     |
| `api`        | API specifications                          |

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

| Parameter | Description             | Example        |
| --------- | ----------------------- | -------------- |
| `query`   | What you're looking for | "create field" |
| `service` | Filter by service name  | "fields-svc"   |
| `method`  | Filter by HTTP method   | "POST"         |

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

| Need                        | Tool                                 |
| --------------------------- | ------------------------------------ |
| Find code in this project   | `search_code`                        |
| Find GDS component usage    | `search_docs` (sources="gds")        |
| Find architecture decisions | `search_docs` (sources="eng_portal") |
| Find API endpoints          | `search_api`                         |
| General documentation       | `search_docs` (no sources filter)    |

---

## External SDK Integration Best Practices

When integrating with external services that have official SDKs, prefer the SDK over raw HTTP calls.

### Use Official SDKs

When an official SDK is available, use it for type-safe API interactions:

```typescript
// Good: Use official SDK
import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
const session = await client.session.create({ body: { title: "My Session" } });

// Bad: Raw fetch (no type safety)
const response = await fetch(`${url}/session`, {
  method: "POST",
  body: JSON.stringify({ title: "My Session" }),
});
```

Benefits:
- Type-safe request/response shapes
- Automatic response parsing
- Consistent error handling
- Future API changes handled by SDK updates

### SDK Response Patterns

Most SDKs return responses with a specific structure. Handle them correctly:

```typescript
// SDK responses typically have .data property with the actual result
const response = await client.session.create({ body: { title: "Session" } });
const session = response.data; // Access the actual session object

// SDK methods may not have error property - check response structure
if (!response.response.ok) {
  throw new Error(`Request failed: ${response.response.status}`);
}
```

### Model Format Conventions

Different APIs have different model format requirements. Check the documentation:

```typescript
// OpenCode SDK expects object format:
model: { providerID: "opencode", modelID: "grok-code" }

// NOT string format (will fail):
model: "opencode/grok-code"
```

When in doubt, test the format by making a request and checking for validation errors.

### When SDKs Are Not Available

If no SDK exists for an API:

1. **Generate one** if OpenAPI spec is available (use `openapi-typescript-codegen`)
2. **Create typed wrappers** that define request/response interfaces
3. **Use fetch with proper typing** - avoid `any` for responses

```typescript
// Typed wrapper pattern
interface Session {
  id: string;
  title: string;
  time: { created: number; updated: number };
}

async function createSession(url: string, title: string): Promise<Session> {
  const response = await fetch(`${url}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.statusText}`);
  }
  
  return response.json() as Promise<Session>;
}
```

### TUI/Control Endpoints

Some APIs have UI-specific endpoints (e.g., `/tui/*`) that may not be covered by SDKs. For these, raw fetch is acceptable:

```typescript
// Keep fetch for TUI-specific endpoints not in SDK
const response = await fetch(`${url}/tui/control/next`, {
  signal: AbortSignal.timeout(timeout),
});
```

Document which endpoints require raw fetch vs SDK usage.
