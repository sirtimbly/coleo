# Component versions and upgrades

Coleo releases the web app, API/CLI, and Arm host agent together. The root
`package.json` is the release source of truth. The web workspace declares that
same version; both browser and server bundles embed the root version at build
time. A running process reports its loaded version, so replacing files alone
does not update a running API or agent.

## Release workflow

- Use Conventional Commits and Conventional Commit PR titles. Release Please
  updates the root package, web package, changelog, and release manifest together.
- Run `bun run versions:check` before building. CI and web/package builds reject
  workspace version drift. Add future component packages to the root workspaces
  and Release Please `extra-files` list.
- Build all artifacts from the same release tag (`coleo-vX.Y.Z`). Deploy pinned
  release artifacts or immutable image digests rather than mutable `latest` tags.
- Upgrade and restart the API and each Arm host, serve the matching web bundle,
  and refresh open browser tabs. Use the dashboard to confirm the rollout.
- For rollback, restore the same prior release across components. Check database
  migration compatibility before rolling back persisted state.

## Dashboard compatibility

The dashboard shows the browser's compiled release, the running API release,
and each currently registered host's advertised release and NATS schema.
Registration and heartbeats refresh host metadata; the status endpoint returns
this inventory without making host RPC calls. Hosts disappear after the existing
heartbeat timeout; this is a live discovery view, not an inventory of offline hosts.

- **In sync:** identical release strings and supported schema numbers.
- **Release differs:** stable releases with the same major (and the same minor
  while on `0.x`). Finish the rollout even though they are in the compatibility range.
- **Incompatible:** different majors, different `0.x` minors, different prereleases,
  or different NATS schema versions. Coordinate the upgrade across components.
- **Compatibility unknown:** missing or malformed metadata, including older agents.
  An older API cannot verify the fleet. Failed refreshes label retained data stale.

Matching versions describe the compatibility contract; they cannot prove two
locally modified builds have identical code. Use immutable release artifacts in
production. Compatibility reporting warns operators; it does not block commands.

## NATS payload schema

`src/shared/version-compatibility.ts` owns `NATS_SCHEMA_VERSION`, initially `1`.
Core NATS messages carry additive `schemaVersion` and `publisherVersion` fields;
retained JetStream events also carry these fields. The existing command envelope
schema constant uses this same contract. This describes Coleo payloads, not the
NATS broker software version.

Keep schema 1 for additive optional fields and compatible fixes. Increase the
schema for removed/renamed fields, changed meanings or types, or newly required
fields. Treat a schema bump as a breaking release (a minor bump during `0.x`, a
major bump after `1.0`). Update affected readers and tests together. Missing schema
fields on historical events remain legacy schema 1; they are not rewritten.

Schema metadata is currently observational; event readers retain their existing
behavior. Before introducing schema 2, implement explicit consumer validation and
migration/upcasting for retained schema 1 events. Do not silently reinterpret old
payloads. Plan breaking upgrades with work drained or paused rather than assuming
mixed schema versions can operate safely.

The release automation uses [Release Please extra files](https://github.com/googleapis/release-please/blob/main/docs/customizing.md).
The pre-1.0 compatibility policy is deliberately conservative because
[SemVer does not promise stability for 0.x](https://semver.org/).


## Database compatibility and migration safety

Database migrations and NATS payload schemas have independent lifecycles. Coleo's
SQLite compatibility epoch starts at `1`, independently of the product release.

`initDatabase` acquires SQLite's write lock with an immediate transaction before
reading the migration ledger. All pending schema/data changes, checksums, and the
epoch update commit together. Unexpected SQL failures, schema validation failures,
or foreign key violations roll back the entire pending upgrade and stop startup.
Already committed migrations from earlier startups remain applied.

Foreign keys are disabled on the migration connection before the transaction so
table rebuilds cannot cascade-delete child rows. A foreign key check runs before
commit, and the original setting is restored on both success and failure. The
five-second busy timeout bounds lock contention. Retry startup after the competing
writer finishes if acquiring the migration lock times out.

Existing direct database clients use `openDatabase`: they cannot create a missing
file or migrate a legacy database. They verify the epoch, required migration
checksums, tables, columns, defaults, indexes, triggers, and CHECK constraints.
They require initialization with the matching API first. Existing explicit
initializers (including legacy local services) all use the same serialized runner.

### Migration authoring

- Add new migrations to `src/db/migration-catalog.ts`; never edit an applied
  migration. SQL definitions live in `src/db/migrations/`.
- Checksums cover the migration name, SQL, column additions, and a stable callback
  `implementationVersion`. JavaScript callbacks must declare this version; do not
  change callback behavior under an existing version. This avoids different hashes
  for source and bundled JavaScript. New behavior belongs in a new migration.
- Migration callbacks must be synchronous and confined to database changes. They
  must not commit, change foreign key settings, or perform external side effects.
- Keep the epoch unchanged for compatible additive changes. Increment
  `DATABASE_COMPATIBILITY_EPOCH` for changes that make older readers/writers unsafe.
  Set `MINIMUM_MIGRATABLE_EPOCH` to the oldest epoch the migration history supports.
- A newer database with the same epoch is accepted only if this release's required
  history and structure still match and newer migration records have checksums.
  The epoch is an explicit compatibility promise by migration authors, not a proof
  that arbitrary future business logic will work.
- Validate new migrations against fresh and populated databases, plus rollback
  on failure. The DB tests run in the standard unit suite.

### Legacy adoption and rollback

A legacy database has no epoch or historical checksums. Initialization applies
pending migrations, validates required structure and foreign keys, then baselines
its known ledger with this release's checksums. That baseline cannot prove which
SQL originally ran. Unknown legacy migrations or inconsistent structure stop
startup rather than being silently accepted.

Stop/drain database clients before an incompatible epoch upgrade, take a consistent
SQLite backup, migrate, and restart the matching release. Checks run when a
connection opens; they do not revoke already-open connections. Older binaries
from before these guards were introduced cannot enforce the new contract.

A binary that does not support the stored epoch refuses to open the database.
Rolling back a breaking upgrade requires the matching pre-upgrade backup or a
separately tested corrective migration. Automatic down-migrations are not provided.
