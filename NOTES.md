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
| Git backend | Local Gitea (Docker) | Self-hosted, familiar, good API |
| Initial interface | CLI → TUI → Web | Progressive enhancement |
| Brain process | Polling (cron/interval) | User can watch changes, see logs, predictable |
| Tentacle lifecycle | Long-running | Learn over time, accumulate notes, share discoveries |
| Agent integration | MCP + Terminal | Agents run in own terminal, communicate via MCP |
| Mail implementation | Pure Maildir | No deps, archived when done, compressible |
| Initial agents | OpenCode, Claude Code | Both support MCP |

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

## Tentacle Architecture: MCP + Terminal

Each tentacle is an AI agent running in its own terminal window, communicating via **MCP (Model Context Protocol)**.

### Why MCP?

MCP is Anthropic's open protocol for connecting AI agents to external tools/resources:
- **Standardized** - Same protocol works for Claude Code, OpenCode, and others
- **Bidirectional** - Brain can send tasks, tentacles can request resources
- **Tool exposure** - Brain exposes tools that tentacles can call
- **Future-proof** - New agents just need MCP support

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Desktop                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Terminal 1 │  │  Terminal 2 │  │  Terminal 3 │         │
│  │             │  │             │  │             │         │
│  │  opencode   │  │ claude-code │  │  opencode   │         │
│  │  (t1)       │  │  (t2)       │  │  (t3)       │         │
│  │             │  │             │  │             │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                 │
│         └────────────────┼────────────────┘                 │
│                          │                                  │
│                    MCP Protocol                             │
│                    (stdio/SSE)                              │
│                          │                                  │
│                   ┌──────▼──────┐                           │
│                   │             │                           │
│                   │   Octopai   │                           │
│                   │   Brain     │                           │
│                   │   (MCP      │                           │
│                   │   Server)   │                           │
│                   │             │                           │
│                   └──────┬──────┘                           │
│                          │                                  │
│                   ┌──────▼──────┐                           │
│                   │  ~/.octopai │                           │
│                   │  /mail/     │◄──── himalaya/luk         │
│                   └─────────────┘                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### MCP Tools Exposed by Brain

The brain runs as an MCP server, exposing these tools to tentacles:

```typescript
// Tools tentacles can call
{
  "claim_task": {
    "description": "Claim a task from the queue",
    "parameters": { "task_id": "string" }
  },
  "complete_task": {
    "description": "Mark a task as complete",
    "parameters": { "task_id": "string", "summary": "string", "artifacts": "array" }
  },
  "report_discovery": {
    "description": "Report something interesting found",
    "parameters": { "kind": "string", "details": "object" }
  },
  "request_approval": {
    "description": "Ask human for approval before proceeding",
    "parameters": { "action": "string", "context": "string" }
  },
  "share_note": {
    "description": "Share a learning with other tentacles",
    "parameters": { "title": "string", "content": "string", "tags": "array" }
  },
  "get_notes": {
    "description": "Get shared notes on a topic",
    "parameters": { "tags": "array" }
  }
}
```

### MCP Resources Exposed by Brain

```typescript
{
  "octopai://tasks/pending": "List of tasks available to claim",
  "octopai://tasks/mine": "Tasks assigned to this tentacle",
  "octopai://notes/shared": "Shared knowledge base",
  "octopai://status": "Current system status"
}
```

### Tentacle Startup

When you spawn a tentacle:

```bash
octopai tentacle spawn --agent opencode --name explorer
```

Octopai:
1. Opens a new terminal window (Ghostty, iTerm2, etc.)
2. Configures the agent's MCP settings to connect to brain
3. Starts the agent with an initial prompt/context
4. Registers tentacle in state

The agent config (e.g., `~/.opencode/config.json`) includes:
```json
{
  "mcpServers": {
    "octopai": {
      "command": "octopai",
      "args": ["mcp", "serve"],
      "env": {
        "OCTOPAI_TENTACLE_ID": "t1"
      }
    }
  }
}
```

### Terminal Management

Options for opening terminals:

**macOS:**
```bash
# Ghostty
ghostty -e "opencode --mcp-config ..."

# iTerm2
osascript -e 'tell application "iTerm2" to create window with default profile command "opencode ..."'

# Terminal.app
open -a Terminal "opencode ..."
```

Tentacles run visibly - you can watch them work, or minimize/hide the windows.

---

## Tentacle Specializations

Each tentacle wraps an AI coding agent with specific tool access:

| Tentacle | Agent | MCP Tools | Specialty |
|----------|-------|-----------|-----------|
| explorer | opencode | glob, grep, read | Codebase exploration, answering questions |
| coder | claude-code | edit, write, bash | Making changes, fixing bugs |
| reviewer | opencode | git, test, lint | Code review, quality checks |
| researcher | claude-code | webfetch, read | Documentation, API research |

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

## Gitea Integration (Docker)

Local Gitea instance for agent collaboration:

### Docker Compose Setup

```yaml
# docker-compose.yml
services:
  gitea:
    image: gitea/gitea:latest
    container_name: octopai-gitea
    environment:
      - USER_UID=1000
      - USER_GID=1000
      - GITEA__server__ROOT_URL=http://localhost:3000
      - GITEA__server__HTTP_PORT=3000
    restart: unless-stopped
    volumes:
      - ./gitea-data:/data
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
    ports:
      - "3000:3000"
      - "2222:22"
```

### Usage

```bash
# Start Gitea
octopai gitea up

# Stop Gitea  
octopai gitea down

# Open Gitea UI
octopai gitea open  # Opens http://localhost:3000
```

### Agent Workflow with Gitea

1. **Brain creates issue** in Gitea when task arrives
2. **Tentacle claims issue** (assigns to self)
3. **Tentacle creates branch** and worktree for isolation
4. **Tentacle works** in isolated worktree
5. **Tentacle opens PR** when done
6. **Brain reviews** or requests human review
7. **PR merged** → Issue closed → Archive mail thread

### Configuration

```toml
# ~/.octopai/config.toml
[gitea]
url = "http://localhost:3000"
token = "..."  # Generated on first setup
default_org = "octopai"
default_repo = "workspace"

[gitea.labels]
tentacle = ["t1", "t2", "t3"]  # Auto-created labels
priority = ["critical", "high", "normal", "low"]
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

## Mail Lifecycle & Archiving

Messages flow through Maildir folders with eventual compression:

```
~/.octopai/mail/
├── inbox/
│   ├── new/        # Unread messages from agents
│   ├── cur/        # Read messages (moved by mail client)
│   └── tmp/        # Temp files during write
├── sent/           # Your replies (brain reads these)
├── drafts/         # WIP replies
└── archive/
    ├── 2026-01/    # Archived by month
    ├── 2026-02/
    └── summaries/  # Compressed context summaries
```

### Archive Flow

1. **Active**: Messages in inbox/cur and sent/
2. **Completed**: When task finishes, brain moves thread to archive/YYYY-MM/
3. **Compressed**: Weekly job summarizes old threads into context summaries

### Context Summaries

Old mail threads are compressed into structured summaries:

```json
// ~/.octopai/mail/archive/summaries/2026-W02.json
{
  "week": "2026-W02",
  "threads": [
    {
      "id": "task-add-dark-mode",
      "subject": "Add dark mode support",
      "tentacle": "t2",
      "outcome": "completed",
      "summary": "Added dark mode toggle using CSS variables. Created 3 new files, modified 5. All tests passing.",
      "learnings": ["CSS variables work better than Tailwind dark: prefix for this codebase"],
      "artifacts": ["commit:abc123", "pr:42"]
    }
  ]
}
```

These summaries can be fed back to tentacles as context without the full mail history.

---

## Open Questions

1. **Note format**: Markdown files vs structured JSON vs hybrid?
2. **Context persistence**: How much conversation history to keep per tentacle?
3. **Archive retention**: How long to keep raw mail before compression?

---

## Next Steps

1. [x] Decide architecture (octopus model)
2. [x] Decide language (Bun/TypeScript)
3. [x] Decide comms model (mailbox + MCP + file queue)
4. [x] Decide agent integration (MCP protocol)
5. [x] Decide mail implementation (pure Maildir)
6. [x] Decide git backend (Gitea in Docker)
7. [ ] Set up project structure (`bun init`)
8. [ ] Create docker-compose.yml for Gitea
9. [ ] Implement Maildir reader/writer
10. [ ] Implement MCP server (brain exposes tools to tentacles)
11. [ ] Implement brain polling loop
12. [ ] Implement tentacle spawner (open terminal, configure agent)
13. [ ] CLI commands for control

---

## References

- [Gas Town](https://github.com/steveyegge/gastown) - Steve Yegge's multi-agent orchestrator
- [Changelog Friends #118](https://changelog.com/friends/118) - Chris Benson on swarms
- "Children of Ruin" by Adrian Tchaikovsky - Octopus intelligence fiction
- [luk](../luk/) - Your existing mail/task TUI
- [himalaya](https://github.com/pimalaya/himalaya) - CLI email client
- [Maildir format](https://en.wikipedia.org/wiki/Maildir) - Email storage format
- [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) - Anthropic's agent protocol
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - Official TS implementation
