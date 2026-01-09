# Octopai - Questions for Next Decisions

## Architecture Questions

### 1. Brain Process Model
How should the brain run?

**Option A: Persistent Daemon**
- Always running in background
- Immediate response to new mail/queue items
- Uses more resources but faster
- Similar to luk's daemon mode

**Option B: Event-Triggered**
- Starts when new mail arrives or queue changes
- Shuts down when idle (after N seconds)
- Uses filesystem watchers (fsevents on macOS)
- More efficient but slightly slower response

**Option C: Polling**
- Runs on cron/interval (every 30s?)
- Simplest implementation
- Less responsive but very predictable

**Your preference?**

---

### 2. Tentacle Lifecycle
How long do tentacles live?

**Option A: Long-Running**
- Tentacle starts and stays alive
- Maintains conversation context with underlying agent
- Brain sends tasks, tentacle responds
- Risk: Context bloat, memory leaks

**Option B: Task-Scoped**
- Brain spawns tentacle for specific task
- Tentacle completes task, writes results, exits
- Fresh context each time
- Risk: Slower startup, loses institutional memory

**Option C: Session-Based**
- Tentacle lives for a "work session" (hours)
- Multiple related tasks during session
- Graceful shutdown at session end
- Balanced approach

**Your preference?**

---

### 3. Underlying Agent Integration
How do tentacles wrap AI agents?

**Option A: CLI Subprocess**
- Spawn `opencode`, `claude`, `codex` as subprocess
- Parse stdout, write to stdin
- Simple but limited control
- Example: `spawn("opencode", ["--prompt", task])`

**Option B: API/SDK**
- Use official APIs (Anthropic, OpenAI)
- Full control over prompts, tools, streaming
- More complex but more powerful
- Tentacles become thin wrappers around API calls

**Option C: MCP (Model Context Protocol)**
- Connect to agents via MCP
- Agents expose tools, tentacles call them
- Future-proof but requires MCP-compatible agents

**Your preference?**

---

### 4. Mail Implementation
How do we write/read the mailbox?

**Option A: Pure Maildir**
- Write .eml files directly
- Follow Maildir spec (new/, cur/, tmp/)
- luk/himalaya reads them natively
- Simple, no dependencies

**Option B: himalaya CLI**
- Use `himalaya` commands to send/read
- Handles all mail formatting
- Extra process spawn overhead

**Option C: JMAP/IMAP to Gitea/Stalwart**
- Run local mail server
- Full email features (search, threading)
- Overkill for v0.1?

**Your preference?** (I'm guessing A - pure Maildir?)

---

### 5. Initial Tentacle Configuration
What agents/tools should the first tentacles have?

**Proposed starting set:**
```
t1: "explorer"
    agent: opencode
    tools: glob, grep, read files
    purpose: codebase exploration, answering questions

t2: "coder"  
    agent: claude (via opencode?)
    tools: edit, write, bash
    purpose: making changes, fixing bugs

t3: "reviewer"
    agent: codex or claude
    tools: git diff, test runner, linter
    purpose: code review, quality checks
```

**What agents do you have access to?** (API keys, CLI tools installed)
- Claude CLI / opencode?
- OpenAI Codex?
- Gemini?
- Local models via Ollama?

---

### 6. Gitea Setup
Local Gitea for collaboration:

**Questions:**
- Do you already have Gitea running locally?
- If not, should we:
  - Use Docker Compose for Gitea?
  - Or start without Gitea and add later?
- What git forge features do we need first?
  - Issues only?
  - PRs?
  - Webhooks?

---

### 7. Project Scope for v0.1
What's the minimum to be useful?

**Proposed v0.1:**
```
✅ octopai init - set up ~/.octopai directory structure
✅ octopai brain start/stop - daemon management  
✅ octopai tentacle spawn - start one tentacle
✅ octopai status - show what's happening
✅ Brain can read your mail and respond
✅ Brain can assign task to tentacle
✅ Tentacle can complete task and report back
✅ Results appear in your mailbox
```

**NOT in v0.1:**
- Multiple projects
- Gitea integration
- Web UI
- TUI (use luk instead)

**Does this scope feel right?**

---

## Quick Answers Needed

Please answer these to unblock development:

1. Brain process: Daemon / Triggered / Polling?
2. Tentacle lifecycle: Long-running / Task-scoped / Session?
3. Agent integration: CLI subprocess / API / MCP?
4. Mail: Pure Maildir / himalaya / mail server?
5. What AI agents do you have available?
6. Gitea: Existing / Docker / Skip for v0.1?
7. Is v0.1 scope right?

---

## Ready to Code

Once you answer these, I can:
1. Initialize the Bun/TypeScript project
2. Set up the directory structure
3. Start implementing the core message queue
4. Build the first tentacle wrapper
