# Octopai: AI Agent Orchestrator

## Project Vision

An AI coding agent orchestrator using the **Octopus Model** - distributed autonomous tentacles coordinated by a central brain, with human-agent communication via an **email/mailbox interface**.

---

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Organizing principle | Octopus Model | Intuitive, debuggable, still parallel |
| Language | Bun/TypeScript | Fast iteration, familiar tooling |
| Human-Agent comms | Email/Mailbox (.eml files) | Async, threaded, familiar, works with existing luk/himalaya |
| Agent-Agent comms | File-based message queue | No DB needed, git-friendly |
| Git backend | Local Gitea instance | Self-hosted, familiar, good API |
| Initial interface | CLI → TUI → Web | Progressive enhancement |

---

## Architecture: The Octopus Model

```
                    ┌─────────────────┐
                    │   Human (You)   │
                    │                 │
                    │  himalaya/luk   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │    Mailbox      │
                    │  ~/.octopai/    │
                    │    mail/        │
                    │  ├── inbox/     │  ← Brain sends status, requests approval
                    │  ├── sent/      │  ← Your replies to agents
                    │  ├── drafts/    │
                    │  └── archive/   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │     Brain       │
                    │   (central)     │
                    │                 │
                    │ - Reads mail    │
                    │ - Sets goals    │
                    │ - Coordinates   │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼────┐          ┌────▼────┐          ┌────▼────┐
   │Tentacle │          │Tentacle │          │Tentacle │
   │  #1     │          │  #2     │          │  #3     │
   │         │          │         │          │         │
   │ claude  │          │ opencode│          │ codex   │
   │         │          │         │          │         │
   │ tools:  │          │ tools:  │          │ tools:  │
   │ - tests │          │ - docs  │          │ - git   │
   │ - lint  │          │ - types │          │ - build │
   └─────────┘          └─────────┘          └─────────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                    ┌────────▼────────┐
                    │     Gitea       │
                    │   (local)       │
                    │                 │
                    │ - Issues        │
                    │ - PRs           │
                    │ - Worktrees     │
                    └─────────────────┘
```

---

## File System Layout

```
~/.octopai/
├── mail/                      # Human-agent communication (Maildir format)
│   ├── inbox/
│   │   ├── new/              # Unread messages from agents
│   │   ├── cur/              # Read messages
│   │   └── tmp/
│   ├── sent/                 # Your replies to agents  
│   ├── drafts/
│   └── archive/
│
├── queue/                     # Inter-agent message queue
│   ├── brain/                # Messages TO brain
│   │   ├── pending/
│   │   └── processed/
│   └── tentacles/
│       ├── t1/               # Messages TO tentacle 1
│       ├── t2/
│       └── t3/
│
├── state/                     # Persistent state
│   ├── brain.json            # Brain's current goals, context
│   ├── tentacles/
│   │   ├── t1.json           # Each tentacle's state
│   │   ├── t2.json
│   │   └── t3.json
│   └── projects/             # Per-project tracking
│
├── config.toml               # Global configuration
│
└── logs/                     # Agent logs for debugging
    ├── brain.log
    └── tentacles/
```

---

## Email Message Types

### From Brain → Human

**Status Updates** (periodic digest)
```
Subject: [octopai] Daily Status - 3 tasks completed, 1 blocked
From: brain@octopai.local
To: you@local

## Completed
- ✅ t1: Fixed lint errors in src/utils (commit abc123)
- ✅ t2: Added missing type annotations  
- ✅ t3: Updated README with new API

## Blocked - Needs Your Input
- ⏸️ t1: Test failure in auth.spec.ts - unclear expected behavior
  
  [View Details] [Approve Fix] [Skip]

## In Progress  
- 🔄 t2: Refactoring database layer (45% complete)
```

**Approval Requests** (immediate)
```
Subject: [octopai] 🔔 Approval needed: Delete deprecated API
From: brain@octopai.local
Priority: high

Tentacle t1 wants to delete 3 deprecated API endpoints.
This is a breaking change.

Files affected:
- src/api/legacy.ts (deleted)
- src/routes/index.ts (modified)

[Approve] [Reject] [Discuss]
```

**Discovery Reports**
```
Subject: [octopai] 💡 Discovery: Found 12 unused dependencies
From: t3@octopai.local

While analyzing the codebase, I found:
- 12 unused npm dependencies
- 3 duplicate utility functions
- 1 potential security issue in lodash@4.17.15

Should I create issues for these?

[Yes, create issues] [Ignore] [Tell me more]
```

### From Human → Agents

Just reply to any email - the brain parses your intent:
```
Subject: Re: [octopai] 🔔 Approval needed: Delete deprecated API
From: you@local
To: brain@octopai.local

Approved, but make sure to update the CHANGELOG.
```

Or send new directives:
```
Subject: New task: Add dark mode support
From: you@local
To: brain@octopai.local

Add dark mode toggle to the settings page.
Use CSS variables for theming.
Assign to whatever tentacle is free.
```

---

## Inter-Agent Communication

Tentacles communicate with the brain via simple JSON files:

```
~/.octopai/queue/brain/pending/1736383200-t1-discovery.json
```

```json
{
  "from": "t1",
  "to": "brain", 
  "timestamp": "2026-01-08T21:00:00Z",
  "type": "discovery",
  "payload": {
    "kind": "test_failure",
    "file": "src/auth.spec.ts",
    "message": "Expected 401 but got 403",
    "context": "Testing unauthorized access"
  }
}
```

Brain picks up messages, processes them, and either:
1. Responds to the tentacle
2. Escalates to human via email
3. Coordinates with other tentacles

---

## Tentacle Specializations

Each tentacle wraps an AI coding agent with specific tool access:

| Tentacle | Agent | Tools | Specialty |
|----------|-------|-------|-----------|
| t1 | claude | test runner, linter | Quality assurance |
| t2 | opencode | type checker, docs | Documentation & types |
| t3 | codex | git, build system | Integration & deployment |
| t4 | (future) | browser, API client | E2E testing |

Tentacles can be added/removed dynamically. The brain adapts.

---

## CLI Commands (v0.1)

```bash
# Initialize octopai in current directory
octopai init

# Start the brain (background daemon)
octopai brain start
octopai brain stop
octopai brain status

# Manage tentacles
octopai tentacle spawn --agent claude --tools "test,lint"
octopai tentacle list
octopai tentacle kill t1

# Check mailbox (or just use himalaya/luk)
octopai mail inbox
octopai mail send "Add dark mode support"

# View current state
octopai status           # Overview
octopai status t1        # Specific tentacle
octopai log t1           # Tentacle logs

# Quick actions
octopai approve <msg-id>
octopai reject <msg-id>
```

---

## Integration with luk

Since luk already handles:
- Maildir reading/writing
- TUI for mail
- himalaya CLI integration
- Task management

Octopai can be a **mail provider** that luk reads from:

```toml
# ~/.config/luk/mail.toml
[accounts.octopai]
backend = "maildir"
path = "~/.octopai/mail"
```

Then you manage agent communication through the same luk TUI you use for regular email.

---

## Gitea Integration

Local Gitea instance for:
1. **Issue tracking** - Agents create/update issues
2. **Pull requests** - Tentacles open PRs for review
3. **Code review** - Brain aggregates PR feedback
4. **Worktrees** - Each tentacle works in isolated worktree

```toml
# ~/.octopai/config.toml
[gitea]
url = "http://localhost:3000"
token = "..."
org = "octopai"
```

---

## Open Questions

1. **Brain implementation**: Should the brain be a persistent process or triggered on mail/queue changes?
   - Daemon: Always running, immediate response
   - Triggered: Start on new mail/queue item, stop when idle (saves resources)

2. **Tentacle lifecycle**: Long-running or spawn-per-task?
   - Long-running: Maintains context, faster response
   - Spawn-per-task: Cleaner state, better isolation

3. **Himalaya vs custom mail handler**: Use himalaya CLI or implement Maildir directly in TypeScript?
   - himalaya: Battle-tested, but another dependency
   - Native: More control, fewer moving parts

4. **Initial agents**: Start with claude (via opencode?) or support multiple from day one?

---

## Next Steps

1. [x] Decide architecture (octopus model)
2. [x] Decide language (Bun/TypeScript)
3. [x] Decide comms model (mailbox + file queue)
4. [ ] Set up project structure (`bun init`)
5. [ ] Implement Maildir writer (brain → human mail)
6. [ ] Implement queue reader/writer (tentacle ↔ brain)
7. [ ] Implement basic brain loop (read mail, read queue, respond)
8. [ ] Implement first tentacle wrapper (spawn claude, capture output)
9. [ ] CLI commands for status/control

---

## References

- [Gas Town](https://github.com/steveyegge/gastown) - Steve Yegge's multi-agent orchestrator
- [Changelog Friends #118](https://changelog.com/friends/118) - Chris Benson on swarms
- "Children of Ruin" by Adrian Tchaikovsky - Octopus intelligence fiction
- [luk](../luk/) - Your existing mail/task TUI
- [himalaya](https://github.com/pimalaya/himalaya) - CLI email client
- [Maildir format](https://en.wikipedia.org/wiki/Maildir) - Email storage format
