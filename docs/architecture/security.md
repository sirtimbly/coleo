---
title: Security Considerations
description: Implemented permission decisions, their integration limits, and safeguards that remain future work.
banner:
  src: /coleo-architecture-security.png
  alt: An orange octopus guards an underwater garden.
  eyebrow: Guarding the Garden
  position: center 50%
---

# Security Considerations

Coleo has a rule-based permission decision engine. It is **not a universal command,
filesystem, commit, or network interceptor**. The rules below describe decisions
when a request with the relevant fields reaches the engine; they do not establish
that every harness operation is checked or prevented.

## Implemented permission decisions

`server/src/brain/permission-engine.ts` evaluates request action, tool, command,
and file fields against priority-ordered rules. A matching field is sufficient;
the fields in a rule are not combined as mandatory conditions. The first matching
rule wins. Unmatched requests escalate for human review.

With the default auto-approval and auto-denial settings:

| Input matching a built-in rule | Engine decision |
| --- | --- |
| Selected `rm -r`, `rm -rf`, or `rm --recursive` spellings against `/`, `~/`, or `../` paths | Deny |
| Selected `git push --force` or `git push -f` spellings targeting `main` or `master` | Deny |
| `DROP DATABASE/TABLE/SCHEMA`, `TRUNCATE TABLE`, or the matched `DELETE FROM` form without `WHERE` | Deny |
| `curl` text containing a `KEY` variable reference; `echo` of a `SECRET`, `PASSWORD`, or `TOKEN` variable | Deny |
| `curl` text mentioning `pastebin.com`, `paste.ee`, `transfer.sh`, `file.io`, `webhook.site`, or `requestbin.com` | Deny |
| `chmod 777` or `chmod -R 777` | Deny |
| `git reset --hard`, selected production deployment patterns, or `npm/yarn/pnpm publish` | Escalate |
| Recognized read/search/list actions or file-reading tools; selected git, navigation, dependency-install, build, test, and lint command prefixes | Approve |

These are regular-expression and name matches, not shell or SQL parsing. Argument
ordering, aliases, scripts, compound commands, and other tools can change the
result. Approved build, test, and install commands can themselves execute code.
An approval therefore does not certify that an operation is harmless.

Disabling auto-approval or auto-denial converts the corresponding rule result to
escalation. Custom rules can change precedence. A per-arm approval counter defaults
to 30 approvals per minute; once exhausted, evaluation denies requests before
matching rules. Pending escalations and decision history are held in memory.
The engine exposes human-decision and timeout-query methods; a timeout query is
not itself a cancellation or a notification.

## Integration boundary

The current health-monitor integration is narrower than the engine's input model:

- `server/src/brain/health-monitor.ts` constructs pending requests with an action,
  context, timestamp, and generated request ID. It does **not** carry command,
  tool, or file fields into that evaluation. Command-pattern rules cannot match
  command text embedded only in `context`.
- Its non-escalated decisions invoke a callback. In `server/src/brain/brain.ts`,
  that callback ignores the request ID and sends the arm the prompt
  “Yes, proceed.” or “No, do not proceed.” It is not a general tool-execution gate.
- OpenCode's TUI harness has a separate SDK permission-response method, while
  Kimi CLI detects approval prompts in terminal output and emits context. These
  mechanisms do not demonstrate that every operation passes through this engine,
  or that the health-monitor callback uses the SDK permission-response method.

`server/src/brain/__tests__/permission-engine.test.ts` tests direct engine
evaluation. Its passing cases establish the listed decisions for supplied inputs,
not end-to-end interception across supported harnesses. Validate permission
behavior with the actual harness, its permission settings, and its execution
environment before relying on it as a control.

## Audit logging

The engine records decisions in memory and, when configured with an event
publisher, attempts to publish `permission_decision` events through the API
boundary. Publishing is best-effort: absent publishers skip it and failures are
logged. This is not a durable audit of every command or file modification.

Decision events can include the submitted command text. Automatic secret
redaction, comprehensive audit retention policies, and an external audit sink are
not guarantees of this engine. Restrict access to logs and event storage accordingly.

## Future safeguards — not current protections

The permission-engine test suite explicitly records missing scenarios as TODOs.
The following designs remain future work, not protections to assume for 1.0:

- Dedicated detection of `find -delete` and fork bombs.
- Content-based secret scanning for files, diffs, logs, and request bodies,
  including raw API tokens, private keys, and credentials in URLs.
- Scanning staged content before commits and blocking commits containing secrets.
  A self-reported secret discovery is not an automatic pre-commit scan.
- Domain allowlisting and network-wide egress interception. The six `curl`
  patterns above are not an `ALLOWED_DOMAINS` policy or a firewall.
- Additional destination patterns for `hastebin.com`, `dpaste.org`, `ghostbin.com`,
  `0x0.st`, and `pipedream.net`; dedicated GitHub Gist and base64-transfer rules.
- Request-body size and source-code inspection for exfiltration detection.
- Automatic severity-based kill/pause actions, guaranteed human alerts, and a
  reputation penalty for denied exfiltration attempts. The engine itself returns
  approve/deny/escalate decisions; denial does not mean that an arm was killed.

An unmatched request reaching the engine normally escalates; missing dedicated
rules do not mean the engine automatically approves it. Operations that never
reach the engine are outside this decision process entirely.

## Deployment controls and incident response

Apply isolation and access controls in the execution environment: least-privilege
credentials, protected API access, resource limits, and externally enforced
network egress restrictions where required. Coleo does not automatically install
a Kubernetes/Swarm network policy, secret manager, or commit-scanning hook.
Allowing HTTPS to every address is not domain allowlisting.

For a suspected incident, an operator should stop or isolate affected workers,
preserve relevant logs and state, investigate exposed credentials, and rotate them
where necessary. Review changes before resuming work. These are operator actions,
not a claim that Coleo automatically performs an incident-response workflow.
