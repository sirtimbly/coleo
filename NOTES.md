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
| Brain process | Polling (cron/interval) | User can watch changes, see logs, predictable |
| Tentacle lifecycle | Long-running | Learn over time, accumulate notes, share discoveries |

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

## Brain Polling Loop

The brain runs on an interval (configurable, default 30s):

```
┌─────────────────────────────────────────────────────────┐
│                    Brain Poll Cycle                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Check ~/.octopai/mail/sent/ for new human messages  │
│     └─> Parse intent, create tasks                      │
│                                                         │
│  2. Check ~/.octopai/queue/brain/pending/ for tentacle  │
│     messages                                            │
│     └─> Process discoveries, requests, completions      │
│                                                         │
│  3. Check tentacle status (are they alive? stuck?)      │
│     └─> Restart if needed, reassign work               │
│                                                         │
│  4. Assign pending tasks to available tentacles         │
│     └─> Write to ~/.octopai/queue/tentacles/<id>/      │
│                                                         │
│  5. Generate status digest if significant changes       │
│     └─> Write to ~/.octopai/mail/inbox/new/            │
│                                                         │
│  6. Log cycle summary                                   │
│     └─> ~/.octopai/logs/brain.log                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

User can watch with:
```bash
octopai brain run              # Foreground, see each cycle
octopai brain run --interval 10  # Faster polling
tail -f ~/.octopai/logs/brain.log  # Watch logs
```

---

## CLI Commands (v0.1)

```bash
# Initialize octopai in current directory
octopai init

# Run brain (foreground for visibility)
octopai brain run              # Run polling loop, ctrl+c to stop
octopai brain run --interval 10  # Poll every 10 seconds
octopai brain run --once       # Single poll cycle, then exit

# Background mode (later)
octopai brain start            # Daemon mode
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

## Learning Tentacles

Since tentacles are **long-running**, they accumulate knowledge over time:

### Personal Notes
Each tentacle maintains its own notes in `~/.octopai/state/tentacles/<id>/notes/`:

```
~/.octopai/state/tentacles/t1/
├── notes/
│   ├── codebase.md          # What I've learned about this codebase
│   ├── patterns.md          # Patterns I've noticed
│   ├── gotchas.md           # Things that tripped me up
│   └── tools.md             # Useful commands/scripts I've discovered
├── context.json             # Current conversation context
└── history.jsonl            # Task history for reflection
```

### Note Sharing
Tentacles can share discoveries with each other via the brain:

```json
{
  "from": "t1",
  "to": "brain",
  "type": "share_note",
  "payload": {
    "title": "Auth module requires specific test order",
    "content": "Tests in auth.spec.ts must run sequentially...",
    "tags": ["testing", "auth", "gotcha"],
    "share_with": ["all"]  // or specific tentacle IDs
  }
}
```

Brain distributes shared notes to relevant tentacles.

### Tool Discovery
When a tentacle discovers a useful command or script:

```json
{
  "from": "t2", 
  "to": "brain",
  "type": "tool_discovery",
  "payload": {
    "name": "quick-typecheck",
    "command": "bun run tsc --noEmit --incremental",
    "description": "Fast typecheck using incremental compilation",
    "context": "Use this instead of full build for type errors"
  }
}
```

Brain can:
1. Add to shared toolbox
2. Notify human of discovery
3. Suggest to other tentacles

### Memory Consolidation
Periodically (or on shutdown), tentacles consolidate learnings:
- Summarize task history into patterns
- Prune outdated notes
- Identify recurring issues → suggest automation

---

## Open Questions

1. **Himalaya vs custom mail handler**: Use himalaya CLI or implement Maildir directly in TypeScript?
   - himalaya: Battle-tested, but another dependency
   - Native: More control, fewer moving parts

2. **Initial agents**: Start with claude (via opencode?) or support multiple from day one?

3. **Note format**: Markdown files vs structured JSON vs hybrid?

4. **Context persistence**: How much conversation history to keep per tentacle?

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
