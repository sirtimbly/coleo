# Octopai - Remaining Questions

## Answered

| Question | Answer |
|----------|--------|
| Brain process model | **Polling** - user can watch, see logs, predictable |
| Tentacle lifecycle | **Long-running** - learn over time, accumulate notes, share discoveries |

---

## Still Need Answers

### 3. Underlying Agent Integration
How do tentacles communicate with AI agents?

**Option A: CLI Subprocess** (simplest)
- Spawn `opencode`, `claude`, `aider`, etc. as subprocess
- Write prompts to stdin, parse stdout
- Example: `spawn("opencode", ["--prompt", task])`
- Pro: Works with any CLI tool
- Con: Limited control, parsing stdout is fragile

**Option B: API/SDK Direct** 
- Call Anthropic/OpenAI APIs directly from TypeScript
- Full control over prompts, tools, streaming
- Pro: Maximum control
- Con: Each provider needs separate implementation

**Option C: Hybrid**
- Use CLI for agents that have good CLIs (opencode, aider)
- Use API for agents without CLI or needing fine control
- Pro: Best of both worlds
- Con: More code paths to maintain

**Your preference?**

---

### 4. Mail Implementation
How do we read/write the mailbox?

**Option A: Pure Maildir** (recommended)
- Write .eml files directly to Maildir folders
- Follow spec: new/ → cur/ when read
- luk/himalaya reads natively
- Simple TypeScript implementation
- Pro: No dependencies, you control everything
- Con: Need to implement RFC 5322 email formatting

**Option B: himalaya CLI**
- Shell out to `himalaya` for send/read
- Pro: Battle-tested email handling
- Con: Extra dependency, process spawning overhead

**Your preference?** (I assume A?)

---

### 5. What AI Agents Do You Have?

Which of these do you have access to?

**CLI Tools:**
- [ ] `opencode` - The tool we're using now
- [ ] `claude` - Anthropic's CLI (if it exists?)
- [ ] `aider` - AI pair programming
- [ ] `codex` - OpenAI Codex CLI
- [ ] `cursor` - Cursor's CLI mode
- [ ] Other: _______________

**API Keys:**
- [ ] Anthropic (Claude)
- [ ] OpenAI (GPT-4, Codex)
- [ ] Google (Gemini)
- [ ] Local models (Ollama, llama.cpp)
- [ ] Other: _______________

This determines which tentacles we can actually spawn.

---

### 6. Gitea Setup

**Option A: Already Running**
- You have Gitea at localhost:3000 or similar
- Just need to configure octopai to use it

**Option B: Docker Compose**
- We add a `docker-compose.yml` to spin up Gitea
- Isolated, reproducible

**Option C: Skip for v0.1**
- Start without Gitea
- Tentacles work in regular git repos
- Add Gitea integration later

**Your preference?**

---

### 7. v0.1 Scope Confirmation

Proposed minimum viable product:

```
✅ octopai init           - Create ~/.octopai structure
✅ octopai brain run      - Foreground polling loop
✅ octopai tentacle spawn - Start a long-running tentacle
✅ octopai tentacle list  - Show active tentacles
✅ octopai status         - Overview of system state

✅ Brain reads your sent mail, creates tasks
✅ Brain assigns tasks to tentacles
✅ Tentacles complete work, report back
✅ Brain sends status updates to your inbox
✅ Tentacles maintain personal notes
```

**NOT in v0.1:**
- Multiple projects (just current directory)
- Gitea integration
- Web UI
- TUI (use luk for mail)
- Note sharing between tentacles (brain just logs them)

**Does this feel right?**

---

## Quick Summary - What I Need

1. Agent integration: CLI subprocess / API / Hybrid?
2. Mail: Pure Maildir or himalaya?
3. What AI agents/APIs do you have available?
4. Gitea: Existing / Docker / Skip?
5. Is v0.1 scope correct?

Once you answer these, I'll:
1. `bun init` the project
2. Set up the directory structure
3. Start implementing core components
