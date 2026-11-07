# Initial setup wizard: implementation proposal

Status: initial implementation added. Repository-only design record. The current
command contract and limitations are documented in [Set up Coleo](../guides/setup.md).
The canonical command is now `coleo-ops init`; `setup` remains a compatibility alias.
Client selection is now an additive checklist: CLI is required for every setup
role, with optional Textual, web, and macOS clients. `--clients tui,web` and the
`clients` array replace the original single-client choice below.
The proposal below retains the intended design; credential-file inputs, automatic
native/browser connection verification, and cross-platform release walkthroughs
remain follow-up work. `--release` selects the installation version; `--version`
prints the ops version. Doctor supports `--wait` and central readiness is enforced.

## Outcome

A new user should choose what this machine does, answer only the relevant
questions, and finish with a verified workspace connection and clear next steps.
An interrupted setup should resume without overwriting existing configuration.

## Entry point and ownership

Recommend **`coleo-ops setup`** as the setup entry point. `coleo-ops` owns the
cross-component operations workflow, role menu, readiness summary, and resume
journal. Bare `coleo-ops` opens an operations menu in a terminal and prints help
otherwise. Ship it as an independently invokable operations tool; it must not
require a Python, Swift, or browser client to perform server/host administration.

### How the tools fit together

| Interface | Owns | Relationship to `coleo-ops` |
| --- | --- | --- |
| `coleo-install` | Release selection, component downloads, private runtimes, installation and upgrades | Ops delegates component acquisition to it. Installation remains noninteractive unless explicitly requested and does not start setup or services automatically. Print `coleo-ops setup` after installation. |
| `coleo-ops` (proposed) | Guided setup and cross-component diagnostics | Coordinates the component interfaces below; does not duplicate their configuration stores or lifecycle implementations. |
| `coleo-server` | Local API and Brain configuration, lifecycle, logs, and server diagnostics | Ops invokes its bounded commands and uses the API for application configuration. Existing manual commands remain supported. |
| `coleo-agent` | Local Arm Host configuration, lifecycle, logs, and host diagnostics | Ops configures and starts the selected host through this interface. |
| `coleo-client` CLI | API-based workspace commands and its own saved connections | A peer client. Ops may invoke `connect`/`doctor` when this client is selected; it is not the configuration authority for other clients. |
| Python/Textual client | Terminal UI and its connection preferences | A peer client; currently shares the Python implementation and connection store with `coleo-client`. This implementation detail does not make Python an operations layer. |
| Swift/macOS client | Native UI and its own connection/credential settings | A peer client. Ops provides a supported connection handoff or explicit native connection instructions. |
| Web client | Browser UI and its own browser/session authentication | A peer client. Ops can arrange the web host and provide its URL; browser credentials/session state remain client-owned. |

Client implementations all communicate with the API. None is the backend or
configuration authority for another client. The current `coleo-client web`
launcher is a packaging entry point, not evidence that browser authentication
uses the Python connection store. Retain current packaging dependencies until
explicitly changed; report them as dependencies rather than client ownership.

Use versioned JSON subprocess contracts for local operators and installer
operations, and HTTP for application configuration. Each component validates and
persists its own settings. Each selected client receives an explicit connection
handoff using its supported interface; if no automated handoff exists, show the
required steps and report connection verification as pending. Do not invent a
shared credential file or silently copy credentials into browser/native stores.
Validate compatible component versions before applying a setup plan. Provision
`coleo-ops` through the release installer; add its artifact/manifest entry and
smoke checks as part of implementation.

Proposed interface (none of these setup commands exist yet):

```text
coleo-ops setup
coleo-ops setup --role local --workspace PATH
coleo-ops setup --role client --server URL
coleo-ops setup --role agent --server URL --workspace PATH
coleo-ops setup --resume
coleo-ops setup --config setup.json --non-interactive --json
coleo-ops setup --config setup.json --dry-run --json
coleo-ops doctor
coleo-ops --doctor
coleo-ops doctor --role server --json
coleo-ops doctor --wait --timeout 180 --json
```

Use `--version` and `--prefix` consistently with installation. `--config` is a
versioned, nonsecret input schema, not a dump of environment variables. Reference
credentials through named environment inputs or credential files; never accept
secrets as command-line arguments. In non-TTY mode require complete inputs and
`--non-interactive`; never hang waiting for a prompt. `--json` reserves stdout for
one redacted result; progress goes to stderr.

### Doctor: one diagnostic entry point

`coleo-ops doctor` is the canonical subcommand; `coleo-ops --doctor` is an alias
for the same read-only operation, including `--json` support. Reject combining
`--doctor` with `setup` or another operation. Keep existing `coleo-server doctor`,
`coleo-agent doctor`, and `coleo-client doctor` available for focused checks.

Ops discovers installed/configured components and aggregates their diagnostics.
Use `--role local|server|agent|client` to limit scope; default to detected
components. Report selected runtime paths, component versions, configuration
sources, process identity, API access, broker/host visibility, and selected-client
connectivity where applicable. Local inspection cannot establish the state of a
remote process: use available API evidence and label unavailable checks clearly.

Each check returns `pass`, `fail`, `skipped`, or `unknown`, a redacted explanation,
and an actionable next command. Missing unselected clients are skipped, not
failures. An inaccessible native/browser connection store is unknown, not a
reason to fall back to Python credentials. Exit 0 only when required checks pass;
exit 1 for failed or unverifiable required checks, and 2 for invalid input.

Doctor never installs, writes configuration, rotates keys, starts/restarts
services, or resumes setup. It may make bounded connectivity probes but does not
submit inference or agent tasks. A cached provider check must be labeled with
its age; model discovery alone does not prove inference readiness. Setup uses
the same diagnostic check implementations, with any active provider validation
performed separately during its apply/verify flow.

`doctor --wait --timeout SECONDS` observes central health until the same final
readiness gate used by setup passes or the deadline expires. `--doctor` accepts
these options too. Without `--wait`, doctor reports a single bounded snapshot.

## The three paths

| Choice                          | Install when missing                    | Ask                                                                              | Completion evidence                                                    |
| ------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Run everything here (default)   | server, agent, selected client(s) and their packaging dependencies | Workspace, runtime directory, Brain provider/model, harness readiness, interface | Authenticated API, Brain model check, registered host, selected-client connection |
| Connect to an existing server   | Selected CLI, Python/Textual, Swift/macOS, or web client and packaging dependencies | Server origin, client choice, connection name where supported, authentication | Authenticated snapshot and connection saved by the selected client, or explicit pending handoff |
| Add this machine as an Arm Host | agent                                   | Workspace, server origin, NATS URL/credential, host name/capacity                | Broker connection and host registration observed by the API            |

Expose advanced settings behind a single “Customize” choice. Do not ask a client
user for database paths, NATS, or provider credentials. Remote hosts need both
HTTP and NATS configuration; an API URL alone cannot provision broker access.

### One-machine sequence

1. **Inspect:** detect installed versions, existing runtime and connections,
   workspace validity, executables, writable paths, and occupied ports. Show
   discovered settings and their sources. Offer to reuse an existing runtime.
2. **Choose:** default to loopback API binding, port 8080, one local Arm Host,
   and a `local` connection name where the selected client supports named connections.
   Offer CLI, Python/Textual, Swift/macOS, and web as peer client choices, filtered
   by platform availability. Show absolute workspace and runtime paths.
   This loopback default is a deliberate wizard change: current operator defaults
   bind `0.0.0.0`. An advanced remote-access choice must distinguish bind address
   from the URL clients use.
3. **Configure:** collect the Brain provider/model using the implemented provider
   list; separately check OpenCode installation and its model credentials.
   Brain credentials do not automatically configure the arm harness. Generate a
   non-`dev-` API key for a new runtime; preserve existing credentials on rerun.
4. **Review:** show components to install, paths to write, services to start,
   network bindings, and any existing values to change. One apply action starts
   the work. Installation downloads and provider probes should be disclosed here.
5. **Apply:** install missing components; initialize missing runtime assets;
   merge explicit operator changes; start API; save Brain configuration through
   `/api/config/brain`; validate provider access; start Brain and Arm Host; save
   or hand off each selected client's connection through its supported interface.
6. **Verify and wait:** poll the central API until all configured service health
   checks are fresh and green, including Brain progress and host registration.
   Report pending client handoffs separately. Offer launch of the selected installed client. Show exact commands
   for `coleo-ops doctor`, component status/logs/stops, and setup resume.

Keep unset/default NATS URLs absent from persisted and applied server overrides
so the existing local broker bootstrap runs. Do not eagerly serialize all
resolved defaults. An explicitly configured external broker remains external.

### First useful result

Finish with the selected client's workspace snapshot, host visibility, and a
short explanation of the planning gate. Offer a read-only repository orientation
task as a separate user action through the normal task workflow. Do not create
tasks or trigger paid agent work just to claim setup succeeded. Distinguish
“connected”, “ready for agent work”, and “task completed”; do not conflate them.

## Reuse and necessary changes

| Existing building block                       | Required work                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/src/cli/commands/init.ts`             | Extract idempotent initialization: create missing assets, preserve user edits, report conflicts. Do not call legacy init wholesale: it rewrites `config.toml`, can write credentials into `mise.toml`, and prints obsolete commands. |
| `server/src/cli/operator-config.ts`           | Reuse validation, source resolution, atomic owner-only persistence. Merge only explicit wizard changes; server and agent share operator settings within a runtime.                                                                   |
| `server/src/cli/operator-program.ts`          | Reuse bounded lifecycle commands; expose any missing setup adapter as a versioned machine-readable operation. Preserve foreground/background semantics.                                                                              |
| `server/src/cli/operator-doctor.ts`           | Reuse diagnostics but add readiness checks: authenticated API, provider reachability, broker, and observed host registration. A listening port or PID alone is insufficient.                                                         |
| `server/src/api/routes/config.ts`             | Use Brain configuration API and model discovery. Model listing is not proof that inference works; add a bounded provider validation operation if no suitable existing one is available.                                              |
| Python `connection_cli.py` / `connections.py` | Reuse for the CLI/Python client only. Add a machine-readable connect result if needed; keep failed validation from replacing a working connection. |
| Swift/macOS and web connection flows | Inventory their existing connection/authentication interfaces; implement supported handoffs or guided instructions and client-specific verification. Do not write their stores through Python. |

Configuration precedence remains flags → exported environment → env file →
saved values → defaults. If an environment override prevents a requested saved
change from taking effect, show the variable name and remedy, not its secret
value. Keep Brain application settings separate from operator lifecycle settings.

## State, failure, and reruns

Use a versioned setup journal in the chosen runtime directory (or ops-owned
state for client-only setup). Store step IDs, nonsecret input fingerprints,
created paths, and process identities; never store credential values or provider
responses. Persist atomically with owner-only permissions and lock against
concurrent setup on the same target.

Steps are `pending`, `running`, `complete`, or `failed`. On resume, recheck live
state before trusting a completed step. Changed inputs invalidate dependent
steps. Never rotate keys, reset databases, duplicate connections, or restart
healthy services merely because setup was run twice.

Cancellation exits 130 after closing handles and recording progress. A partial
failure returns nonzero with the failing step, completed steps, services left
running, log locations, and an exact resume command. Offer cleanup only for
resources created by this run; do not stop preexisting services or delete user
configuration. Provider errors may leave a functioning API and client while
reporting agent readiness as incomplete.

Proposed exit codes: 0 verified success; 1 apply/readiness failure; 2 invalid or
missing input; 130 cancellation. JSON result fields: `schemaVersion`, `role`,
`ok`, `steps`, `paths`, `nextCommands`, and redacted `error` when applicable.

## Verification contract

### Final readiness gate: central API is authoritative

Setup must wait for the running system to demonstrate health through the central
API. Successful subprocess exits, listening ports, and local PID checks are
startup evidence, not completion. Display a live checklist of **all** reported
service health variables, including database, NATS, Maildir, Brain/model access,
host/harness readiness, and configured indexing/search or other integrations.
Discover the server's full check inventory rather than silently ignoring unknown
component names.

Existing sources include `/api/status`, `/api/brain/status`, and the health rows
returned by `/api/brain/internal/infrastructure-health`. Before implementation,
define a supported operator-facing health contract exposing the full inventory,
whether each check is enabled/required, health/error, observation time, and
current process/configuration generation. Reuse the existing health producers;
do not make ops depend permanently on an internal route. Some current summary
fields have optimistic defaults or omit timestamps, so they cannot alone satisfy
this gate. Missing records must remain pending/unknown rather than become green.

- Begin polling after apply with a proposed two-second interval and a configurable
  `--timeout SECONDS` deadline (default 180 seconds). Respect request deadlines
  and cancellation; transient startup failures remain visible while retrying.
- Wait for at least one completed Brain health/poll cycle after the relevant
  configuration/startup changes. Require observations from the current generation,
  within the server's freshness limits, and a fresh host heartbeat/registration.
  An old green result from before setup cannot pass the gate.
- Require all enabled service checks to be green for two consecutive snapshots.
  An enabled optional integration must pass too. Only explicitly disabled or
  inapplicable services may be marked not applicable, with the reason shown.
- Show planning-gate and other reported blockers. Do not bypass them or create
  dummy tasks to force green. If user input is needed, identify the action and
  preserve setup progress; do not print “everything working” while it is blocked.
- On timeout, exit nonzero and show every remaining unhealthy, stale, missing,
  or unknown check, its last observation/error, relevant logs, and exact resume
  and `coleo-ops doctor --wait` commands. Leave existing work and services intact.
- A client-only or remote-host setup still observes the central API's configured
  service health. It may report “client connected” or “host registered” while
  central readiness is incomplete; it must not report overall setup success.

The final success summary means the central API has observed all enabled
services working, and separately identifies whether each selected client's
connection was verified. Manual client handoff still pending means setup remains
incomplete, even when the server is green.

- API health is a liveness probe only. Verify `/api/status` using the selected
  credential, and for newly provisioned local servers verify rejection of a
  wrong credential. Existing proxy-authenticated servers may require a different
  check; report authentication mode as unknown rather than guessing.
- Brain readiness requires valid configuration and a successful bounded provider
  check, not merely a running process or populated model list.
- Host readiness requires NATS connectivity and fresh registration visible to
  the API, plus availability of the supported `opencode-api` harness.
- Client success requires a snapshot from the selected connection. Never use
  unauthenticated `/api/health` as proof that its saved credential works.
- Optional web/TUI absence does not fail a CLI-only setup. Optional integrations
  such as Qdrant and email stay in follow-up guides unless enabled by the user.

## Delivery slices and acceptance

1. **Operations entry point and safe contracts:** package `coleo-ops`, define
   installer/operator/client adapters, idempotent configuration merge, dry-run
   plan, secret redaction, version negotiation. Test existing/partial runtimes,
   precedence, interrupted writes, and preservation of custom files. Verify
   `doctor`/`--doctor` equivalence, read-only behavior, JSON redaction, scoped
   checks, unknown/skipped results, and exit statuses.
2. **Client path:** role menu, component acquisition, connection validation,
   client-owned connection persistence and handoffs. Test CLI, Python/Textual,
   Swift/macOS, and web independently, including a native/web-only user with no
   configured Python connection. Test offline server, 401, proxy behavior,
   invalid URLs, duplicate names, non-TTY input, and cancellation.
3. **Local path:** server → Brain → host → client sequence and readiness. Test
   occupied ports, stale PID records, missing harness, provider failure, local
   NATS bootstrap, paths with spaces, and rerun with no unintended changes. Test
   delayed health convergence, stale greens from a previous process, missing
   health rows, optional-but-enabled failures, disabled checks, planning blockers,
   API disconnects during polling, timeout, and cancellation. Assert that setup
   cannot succeed before the central readiness gate passes.
4. **Remote host and recovery:** explicit NATS settings, registration deadline,
   resume journal, concurrent-run lock, cleanup ownership. Test broker outage,
   auth failure, disconnected host, and resuming after each apply step.
5. **Release walkthrough and docs:** validate fresh-user and existing-runtime
   flows against installed artifacts on supported macOS/Linux targets. Publish
   the companion guide only after these pass; link it from installation and
   Getting Started. Keep manual component setup as the advanced reference.

Recommendation: approve this command ownership and role split first, then deliver
slices 1–3 as the initial wizard. The remote-host path completes the same design
without making it a prerequisite for a useful one-machine onboarding release.
