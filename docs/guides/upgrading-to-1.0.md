---
title: Upgrading from 0.14.4 to 1.0
description: Migrate commands and services, preserve persistent state, and recover from an interrupted upgrade.
---

# Upgrading from 0.14.4 to 1.0

The CLI split is a breaking change. Migrate automation and service definitions
before replacing the old installation. This guide describes the current
implementation; **a populated-database upgrade and backup restoration have not
been rehearsed as part of this documentation change**. Run the procedure on an
isolated copy of your deployment and record the results before production rollout.

Use a pinned release and its matching component artifacts. `VERSION` below means
the actual published target version, not `latest`. The component installer needs
a release containing `coleo-release.json`; it cannot install older releases that
lack that manifest. Retain your original 0.14.4 installation method and artifacts
for recovery. See [Component Installation](./installation).

## 1. Migrate command ownership

| 0.14.4 interface | New interface / meaning |
| --- | --- |
| `coleo serve` | `coleo-server run` — foreground API |
| `coleo serve start/stop/restart/status/logs` | `coleo-server start/stop/restart/status/logs` — local API service |
| `coleo brain run/start/stop/restart/status/logs` | `coleo-server brain run/start/stop/restart/status/logs` — local brain process |
| `coleo agent start` | `coleo-agent run` for the same foreground model; `coleo-agent start` now means background |
| `coleo agent status` | `coleo-client agents` for server-visible agents; `coleo-agent status` for the local process |
| `coleo tasks`, `bugs`, `mail`, `config`, `activity`, `status` | `coleo-client` with the corresponding command |
| `coleo inbox`, `coleo inbox views`, `coleo inbox validate` | `coleo-client inbox`, `coleo-client views`, `coleo-client validate` |
| `coleo arm …` except local `logs` | `coleo-client arms …` |
| `coleo arms` | `coleo-client arms list --watch` |
| `coleo discoveries list/resolve/history` | `coleo-client discoveries list/resolve/history` |
| `coleo tui`, `coleo web` | `coleo-client tui`, `coleo-client web` (optional components) |
| `coleo init`, MCP, IMAP, branch commands, local arm logs and discovery summarizer diagnostics | Retained on transitional `coleo`; inspect `coleo --help` |

Migrated Bun commands print a replacement and **exit 1**; they do not forward the
request or fall back to local database access. Check each replacement's `--help`
and JSON output before updating scripts; this table is not a promise of identical
flags or output. The Python `coleo-inbox` alias still exists.

`coleo-client config` is server-side arm configuration. Save local service settings
with `coleo-server configure` or `coleo-agent configure`. Python
`coleo-client brain start/stop` calls the selected server's control API; it does not
replace local process management with `coleo-server brain start/stop`.

Task sync/reparse and CSV operations now use the selected server and its workspace,
including a configured remote Arm Host. They no longer use the caller's local
database just because a script runs inside a project directory.

For source-based service definitions, the server code is in `server/src`, web in
`clients/web`, and Python in `clients/python` with its project metadata at the
repository root. Prefer installed executables or documented mise tasks over the
transitional `src` symlink.

## 2. Inventory settings and capture a baseline

Record the old binary versions, installation paths, service manager definitions,
working directories, environment, API URL, NATS URL, and credentials on each host.
Record the absolute runtime directory and **actual database path**; a database
outside the runtime directory needs its own backup.

- `--dir` overrides `COLEO_DIR`; otherwise the operator runtime defaults to
  `.coleo` in the working directory. Use explicit absolute paths during migration.
- Operator setting precedence is flags, nonempty exported environment, loaded
  environment-file values, saved `operator.json`, then defaults. The loader uses
  the first available `.env` in the Coleo directory, project directory, or working
  directory. Do not assume that editing saved settings overrides an old export.
- `operator.json` is runtime-scoped and saved with mode 0600. Preserve existing
  `config.toml`, `.env`, service environment files, and provider credentials too.
- `COLEO_DB_PATH`/`--db-path` selects the server database. Preserve
  `COLEO_PROJECT_DIR`, remote workspace settings, stable agent IDs, and each Arm
  Host's workspace/runtime directory. Reconfiguring a path must not silently point
  the upgrade at an empty database or a different project.
- HTTP clients use `COLEO_API_URL` and `COLEO_API_KEY`; NATS uses its own
  `COLEO_NATS_URL` and `COLEO_NATS_TOKEN`. Do not interchange these credentials.
- Python flags override environment, saved connections, and defaults. Python does
  not discover the operator's `.env` files or use its `COLEO_API_TOKEN` alias.
  Back up `connections.json` in the client configuration directory, including any
  `COLEO_CONFIG_DIR` override. `--connection` selects a server connection;
  `--profile` selects an Inbox query profile.

Capture representative IDs, counts, and contents using the old UI/API or read-only
exports: tasks and their plans/discussions, messages and attachments, workbench
profiles/views/layouts/preferences, arm configuration, and any existing host
inventory/notes. Include completed and blocked tasks and populated profiles, not
only an empty database. CSV/profile exports are useful comparison records but are
not a complete database backup.

## 3. Quiesce and back up

1. Stop new submissions and scheduled automation. Stop brain orchestration using
   the **old** installation (`coleo brain stop` for its managed daemon, or the
   external supervisor for a foreground service).
2. Finish or explicitly stop active arms through their original host while the API
   and NATS are available. Save workspace changes. Stopping an Arm Host is not the
   same operation as terminating every individual arm. Older arms without ownership
   records are not automatically adopted by the new host.
3. Stop Arm Hosts on every machine using their existing foreground process or
   supervisor. Stop web/client sessions, IMAP, MCP processes and other writers.
4. Stop the old API with `coleo serve stop`, or its external supervisor. Disable
   automatic restart during maintenance and confirm no processes still hold the
   database or write workspace/mail/upload state.
5. Back up persistent state. If snapshotting local NATS/JetStream or other service
   volumes, stop those services after their clients and use their supported backup
   procedure. A shared remote broker needs coordinated snapshots, not an arbitrary
   stop of other tenants' service.

For example, after quiescing, with `sqlite3` installed, substitute your real paths:

```sh
export COLEO_DIR=/absolute/path/to/existing/.coleo
export DB=/absolute/path/to/existing/coleo.db
export BACKUP=/absolute/path/to/backups/coleo-0.14.4-before-1.0
umask 077
mkdir -p "$BACKUP"
cp -Rp "$COLEO_DIR" "$BACKUP/runtime"
sqlite3 "$DB" ".backup '$BACKUP/database.sqlite'"
sqlite3 "$BACKUP/database.sqlite" 'PRAGMA integrity_check;'
```

Use a new backup directory outside the runtime directory. Require `integrity_check`
to return `ok`. SQLite's backup command produces a consistent standalone database;
copying only a live `.db` file can omit WAL changes. Keep any raw database/WAL/SHM
files together in the runtime snapshot, but use `database.sqlite` for restoration.

Also copy external configuration, repositories/worktrees (including uncommitted
files and plan sources), external mail/upload directories, client settings, and
deployment-specific NATS/JetStream and other persistent volumes. The runtime copy
includes uploads stored under `COLEO_DIR/uploads`, but not paths outside it.
Preserve permissions and protect credential-bearing backups. Retain a manifest of
paths, versions, snapshot times, and checksums, and test access to the backup.

## 4. Install and migrate with orchestration stopped

First perform these steps on a separate copy with isolated API ports, NATS, and
workspaces. Do not let a rehearsal brain or Arm Host connect to the production
broker or execute production work.

For an existing component installation:

```sh
coleo-install upgrade server --version VERSION
# On each Arm Host:
coleo-install upgrade agent --version VERSION
# On client hosts, select the installed interfaces:
coleo-install upgrade client --version VERSION
coleo-install install web --version VERSION
```

For a 0.14.4 npm/source installation, use the pinned release's bootstrap to
**install** the selected components as described in [installation](./installation).
The installer does not overwrite unrelated executables. Resolve PATH collisions
deliberately, retain the old installation for recovery, and check `command -v`
and `--version` for each selected executable. Server and agent share one operator
distribution on a host: upgrading either changes that shared installation.

Restore/start required infrastructure first. With the intended runtime directory,
database, workspace and environment selected, inspect and configure the new operator:

```sh
coleo-server --dir "$COLEO_DIR" configure --db-path "$DB"
coleo-server --dir "$COLEO_DIR" doctor
coleo-server --dir "$COLEO_DIR" start --db-path "$DB"
coleo-server --dir "$COLEO_DIR" status
coleo-server --dir "$COLEO_DIR" logs
```

Review resolved paths and configuration sources in diagnostics. Local `status`
confirms process identity, not successful authenticated API access. The API starts
separately from the brain; leave the brain and Arm Hosts stopped while checking
the migration. For externally supervised services, configure `coleo-server run`
and `coleo-agent run` in the supervisor rather than nesting background `start`.

API initialization applies pending database migrations. The catalog includes
`073_hosts`, creating persistent host identity, role, agent association and notes
storage. It does not reconstruct historical hosts from nothing; an older database
may legitimately have no host rows until registration. Never edit the migration
ledger to make startup appear successful. See [database compatibility](./versioning#database-compatibility-and-migration-safety).

Connect a matching client and verify access:

```sh
coleo-client connect http://127.0.0.1:8080 --name upgraded --prompt-key
coleo-client --connection upgraded doctor --json
coleo-client --connection upgraded tasks --json
```

Replace the URL with the reachable API address; `0.0.0.0` is a listen address, not
a client destination. Clear stale endpoint/key exports if selecting a saved
connection, since environment values override saved settings.

## 5. Verify data, then resume services

- Compare the baseline task IDs, statuses, plans, dependencies, discussions, and
  representative message bodies/attachments. Check plan files in the configured
  workspace as well as database records.
- Open each populated workbench profile and compare views, layouts, preferences,
  and selected resources. Profile exports are not substitutes for backups; use
  current-format exports for import. Import requires `schemaVersion: 1` and the
  required collections; future-version bundles are rejected rather than imported
  on a best-effort basis. Explicit import modes are `copy` and `replace`.
- Confirm `073_hosts` is present in `_migrations` and inspect host inventory.
  Preserve existing IDs/notes; verify new host registration after restarting agents.
- Exercise an authenticated read and a small reversible edit through each installed
  client. Refresh and reconnect to confirm persistence. Inspect logs for migration,
  authentication, workspace-path, or compatibility errors.

Start each Arm Host with its preserved ID/workspace/runtime and matching NATS
settings (`coleo-agent configure`, `coleo-agent start`). Verify registration and
version reporting before starting `coleo-server brain start`. Resume automation
only after a supervised task and reconnect checks succeed.

The API is now **API-only**: its root and browser routes return 404. Start the
separate installed web host with `coleo-client --connection upgraded web`; it runs
in the foreground, defaults to `127.0.0.1:3000`, and proxies to the selected API
using the selected credential. Update reverse-proxy/service definitions to point
browser traffic at the web host. For a checkout, build with `bun run web:build`
and run `clients/web/dist/host.js` with the intended API environment. See
[Server and clients](../architecture/client-server-separation#run-the-web-client).

Record the exact release/commit, platform, populated backup used, commands,
migration logs, comparison results, and restore results. This is the evidence for
your rehearsal; installation success alone does not establish data preservation.

## Interrupted upgrade and restore

Keep orchestration and writers stopped while diagnosing failure. Preserve logs and
a snapshot of the failed state before retrying. Installer generation switching and
database migration are separate operations: reverting installed commands does not
revert data. For a stale installer lock, follow the checks in the installation
guide before removing it. For a migration failure, inspect the reported cause and
retry the same release only after resolving it; do not delete ledger entries.

**Do not point 0.14.4 binaries at a database already migrated by 1.0.** Older
binaries may lack compatibility guards. There is no automatic down-migration;
use the matching pre-upgrade backup or a separately tested corrective migration.

To restore, first rehearse this procedure in isolation:

1. Stop all upgraded clients/writers, brain, arms, hosts and API, in the shutdown
   order above. Disable supervisors and confirm processes are stopped.
2. Move the failed runtime and any external database **with its WAL/SHM sidecars**
   to a separate recovery location. Keep them for investigation. Do not overlay
   an old database onto a directory containing the newer database's sidecars.
3. Recreate the original paths and permissions from the pre-upgrade runtime and
   external-state snapshots. At the recorded database path, replace the restored
   raw database and its sidecars with the standalone `database.sqlite` backup.
   Check the restored database with `sqlite3 "$DB" 'PRAGMA integrity_check;'`.
4. Restore matching workspace, mail/uploads, service configuration, credentials,
   and coordinated infrastructure snapshots. A database-only restore can leave
   attachments, plan files or broker state inconsistent. Do not restore stale PID
   registrations as proof of a running process; inspect actual process identity.
5. Reinstall/select the retained 0.14.4 artifacts using their original installation
   method. Verify PATH and versions, then start infrastructure and the old API,
   inspect data against the baseline, and only then restart original hosts and brain.
6. Repeat authenticated client and persistence checks. Record any changes lost
   since the backup and reconcile them before accepting new work.

A restore loses writes made after the backup unless they are separately recovered.
Keep both snapshots until the restored deployment and its data have been verified.
