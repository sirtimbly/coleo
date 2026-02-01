# Architectural Context for Arms

This document describes how Coleo provides architectural context and constraints to AI agents (arms) to ensure they follow project conventions and make consistent decisions.

## The Problem

AI agents working on a codebase need to understand:
- Where to store data (SQLite vs files vs API)
- Code conventions and patterns
- Current architectural decisions
- What's in progress vs what's stable

Without this context, agents may:
- Create redundant storage mechanisms
- Violate conventions
- Make inconsistent architectural choices
- Duplicate work or conflict with other arms

## Solution: Three-Layer Context System

Coleo uses three complementary approaches:

### 1. Static Context: AGENTS.md

A markdown file at the project root that AI coding agents automatically read.

**Location:** `/AGENTS.md`

**Contents:**
- System of record (what data lives where)
- Technology stack
- Code organization
- Naming conventions
- Current state (what's working, what's in progress)
- Domain-specific guidelines and task classification guidance

**Supported by:** OpenCode, Claude Code, Cursor, and most AI coding tools

**Pros:**
- Zero-cost to query (already in context)
- Version controlled
- Human-readable

**Cons:**
- Static (manual updates)
- Uses context budget
- Can become stale

### 2. Dynamic Queries: MCP Guidance Tools

MCP tools that arms can call to get context-specific guidance.

**Tools:**

```typescript
// Get guidance on where to store a type of data
get_storage_guidance(dataType: string) → {
  storage: "sqlite" | "file" | "memory",
  location: string,
  example: string
}

// Get the current architectural decision for a topic
get_architectural_decision(topic: string) → {
  decision: string,
  rationale: string,
  decidedAt: Date,
  decidedBy: string
}

// Check if a proposed change aligns with architecture
check_architectural_alignment(change: string) → {
  aligned: boolean,
  concerns: string[],
  suggestions: string[]
}
```

**Pros:**
- Dynamic and up-to-date
- Can provide context-specific answers
- Doesn't bloat initial prompt

**Cons:**
- Requires active querying
- Arms may forget to query
- Adds latency

### 3. Review via Architect-Classified Tasks

Instead of a dedicated, permanently specialized "architect arm", Coleo uses **architect-classified tasks**, often guided by the `architect:project-management` task configuration template, to review other work for architectural compliance.

**Classification:** `architect` (with subtype `project-management` when in a PM/review role)

**Responsibilities:**
- Review proposals before they're accepted
- Scan commits for architectural violations
- Suggest refactors when patterns diverge
- Maintain and update AGENTS.md and key architecture docs
- Answer architectural questions from other arms (via MCP tools or mail)

**Triggers:**
- New proposal created → Architect-classified review task
- Significant code changes touching architectural boundaries → Review task
- Arm asks question via mail → Architect-classified Q&A task

**Powers:**
- Can recommend veto of proposals that violate architecture (the Brain enforces)
- Can request changes before risky deployments
- Can escalate to human for ambiguous cases

**Pros:**
- Catches mistakes before merge/deploy
- Can handle nuanced cases
- Learns and adapts over time

**Cons:**
- Adds latency to workflow
- Requires coordination
- Uses context budget

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| AGENTS.md | ✅ Done | `/AGENTS.md` |
| MCP Guidance Tools | 🟢 Planned / Partial | `src/mcp/tools/guidance.ts` |
| Architect-Classified Review Tasks | 🟢 Planned | Brain assigns `architect` tasks with the appropriate template |

## Configuration

### AGENTS.md Auto-Update

Architect-classified tasks can be configured to automatically update AGENTS.md:

```toml
[architect]
auto_update_agents_md = true
update_frequency = "on_change"  # or "daily"
```

### Architectural Decisions Database

Decisions are stored in SQLite for MCP tool queries:

```sql
CREATE TABLE architectural_decisions (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT,
  decided_by TEXT,
  decided_at TEXT DEFAULT (datetime('now')),
  supersedes TEXT REFERENCES architectural_decisions(id)
);
```

### Architect Task Configuration Template

Architect review and project-management behavior is driven by the `TaskConfigurationTemplate` registry:

- Key: `"architect:project-management"`
- Location: `src/types/index.ts` (`TASK_CONFIGURATION_TEMPLATES`)

This template defines:
- Allowed tools (e.g., `fs`, `git`, `mcp:guidance`)
- Context bundles to load (`.project/*`, `docs/`, recent activity, status reports)
- Governance expectations (when proposals are expected, when status reports are emphasized)
- A short system hint describing how architect tasks should behave

## Best Practices

### For Arms

1. **Read AGENTS.md** – It's automatically loaded, but pay attention to it.
2. **Query when unsure** – Use `get_storage_guidance` before creating new persistence.
3. **Create proposals** – For significant architectural changes, create a proposal for review.
4. **Check alignment** – Before submitting, run `check_architectural_alignment`.

### For Humans

1. **Keep AGENTS.md current** – Update when architecture changes.
2. **Review architect-classified decisions** – Occasionally check vetoes and recommendations.
3. **Override when needed** – Use proposals to override architectural decisions.
4. **Document rationale** – When making decisions, explain why.

## Future Enhancements

- **Architectural fitness functions** – Automated tests for architectural compliance
- **Decision history** – Track how architecture evolved over time
- **Cross-project patterns** – Share architectural patterns across Coleo instances
- **Visualization** – Show architectural boundaries in the Garden view
