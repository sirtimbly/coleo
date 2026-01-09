# Octopai - All Major Decisions Made

## Summary of Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Brain process model | **Polling** - foreground, watchable, predictable |
| 2 | Tentacle lifecycle | **Long-running** - learn, accumulate notes, share |
| 3 | Agent integration | **MCP** - standard protocol, agents in own terminals |
| 4 | Mail implementation | **Pure Maildir** - no deps, archived when done |
| 5 | Initial agents | **OpenCode + Claude Code** - both support MCP |
| 6 | Git backend | **Gitea in Docker** - isolated, reproducible |
| 7 | v0.1 scope | Confirmed (see below) |

---

## v0.1 Scope (Confirmed)

### Included
- `octopai init` - Create ~/.octopai directory structure
- `octopai brain run` - Foreground polling loop with MCP server
- `octopai tentacle spawn` - Open terminal, start agent with MCP config
- `octopai tentacle list` - Show active tentacles
- `octopai status` - Overview of system state
- `octopai gitea up/down` - Manage local Gitea
- Pure Maildir for human-agent communication
- MCP server for brain ↔ tentacle communication
- Tentacle notes (personal, not yet shared)
- Basic mail archiving

### Not in v0.1
- Multiple projects (just current directory)
- Note sharing between tentacles
- Context compression/summarization
- Web UI
- TUI (use luk for mail)
- Automatic PR creation (manual for now)

---

## Remaining Minor Questions

These can be decided during implementation:

1. **Note format**: Markdown files vs structured JSON vs hybrid?
   - Leaning: Markdown for human readability

2. **Context persistence**: How much conversation history per tentacle?
   - Leaning: Keep last N messages, summarize older

3. **Archive retention**: How long before compression?
   - Leaning: 7 days raw, then compress

4. **Terminal emulator**: Auto-detect or configure?
   - Leaning: Auto-detect (Ghostty → iTerm2 → Terminal.app)

---

## Ready to Build

All major decisions are made. Next step: `bun init` and start coding.

```bash
# Initialize project
bun init

# Install dependencies
bun add @modelcontextprotocol/sdk commander

# Create structure
mkdir -p src/{brain,tentacle,mail,mcp,cli}
```
