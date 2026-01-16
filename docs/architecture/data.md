# Data Persistence

Octopai uses a database abstraction layer that supports both SQLite (simple, default) and PostgreSQL (scalable).

## ORM & Database Libraries for Bun

Bun has excellent first-party SQLite support via `bun:sqlite`, but for more complex needs or PostgreSQL, here are the options:

### Option 1: Bun's Native SQLite (Recommended for SQLite)

Bun's built-in `bun:sqlite` is extremely fast and requires no dependencies:

```typescript
import { Database } from "bun:sqlite";

const db = new Database("octopai.db");
db.exec("PRAGMA journal_mode = WAL");

// Prepared statements are fast and safe
const getArm = db.prepare("SELECT * FROM arms WHERE id = ?");
const arm = getArm.get(armId);
```

**Pros**: Zero dependencies, fastest SQLite in JS, built-in  
**Cons**: SQLite only, no migrations built-in, manual SQL

### Option 2: Drizzle ORM (Recommended for TypeScript)

Drizzle works great with Bun and supports both SQLite and PostgreSQL:

```typescript
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Schema definition (type-safe)
const arms = sqliteTable("arms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Legacy: domain was used for static specialization.
  // Newer code should prefer task classifications and history.
  domain: text("domain"),
  reputation: integer("reputation").default(50),
});

// Usage
const sqlite = new Database("octopai.db");
const db = drizzle(sqlite);

const allArms = await db.select().from(arms);
const recentlyActiveArms = await db.select().from(arms) /* filter by recent tasks or activity instead of static domain */;
```

**Pros**: Type-safe, lightweight, great DX, supports migrations  
**Cons**: Learning curve for complex queries

### Option 3: Kysely (SQL Query Builder)

For those who prefer SQL but want type safety:

```typescript
import { Kysely, SqliteDialect } from "kysely";
import Database from "better-sqlite3"; // or bun:sqlite adapter

interface DB {
    arms: {
      id: string;
      name: string;
      // Legacy: domain was used for static specialization.
      // Prefer task history and classifications instead.
      domain: string | null;
      reputation: number;
    };

}

const db = new Kysely<DB>({ dialect: new SqliteDialect({ database }) });

const arms = await db
  .selectFrom("arms")
  // Prefer filtering by task history, recent activity, or explicit classification fields
  .selectAll()
  .execute();
```

**Pros**: SQL-like syntax, type-safe, lightweight  
**Cons**: Not a full ORM, manual schema sync

### Option 4: Prisma

Prisma works with Bun but requires the Prisma Client:

```typescript
// schema.prisma
model Arm {
  id         String @id
  name       String
  domain     String
  reputation Int    @default(50)
}

// Usage
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const arms = await prisma.arm.findMany({
  where: { domain: "ui" },
});
```

**Pros**: Great DX, migrations, Prisma Studio  
**Cons**: Heavier, requires codegen step, slower than native

### Recommendation

For Octopai, we recommend:

| Use Case | Choice | Reason |
|----------|--------|--------|
| Simple/Local | `bun:sqlite` raw | Fastest, zero deps |
| Type-safe + Migrations | Drizzle ORM | Best balance for Bun |
| Complex queries | Kysely | SQL control + types |
| Team familiarity | Prisma | If team knows it |

**Our approach**: Start with `bun:sqlite` + simple abstraction layer. Migrate to Drizzle if schema complexity grows.

## Database Interface

All database operations go through a common interface:

```typescript
interface Database {
  // Arms
  getArms(): Promise<Arm[]>;
  getArm(id: string): Promise<Arm | null>;
  createArm(arm: Arm): Promise<Arm>;
  updateArm(id: string, updates: Partial<Arm>): Promise<Arm>;
  deleteArm(id: string): Promise<void>;
  
  // Proposals
  getProposals(filter?: ProposalFilter): Promise<Proposal[]>;
  getProposal(id: string): Promise<Proposal | null>;
  createProposal(proposal: Proposal): Promise<Proposal>;
  updateProposal(id: string, updates: Partial<Proposal>): Promise<Proposal>;
  addArgument(proposalId: string, argument: Argument): Promise<void>;
  addSignal(proposalId: string, signal: Signal): Promise<void>;
  
  // Claims
  getClaims(): Promise<FileClaim[]>;
  getClaimsForArm(armId: string): Promise<FileClaim[]>;
  getClaimForPath(path: string): Promise<FileClaim | null>;
  createClaim(claim: FileClaim): Promise<FileClaim>;
  deleteClaim(id: string): Promise<void>;
  
  // Activity
  logActivity(activity: Activity): Promise<void>;
  getActivity(filter?: ActivityFilter): Promise<Activity[]>;
  
  // Reputation
  getReputation(armId: string): Promise<ArmReputation>;
  updateReputation(armId: string, event: ReputationEvent): Promise<void>;
  
  // Config
  getConfig(): Promise<Config>;
  updateConfig(updates: Partial<Config>): Promise<Config>;
  
  // Push subscriptions
  getPushSubscriptions(): Promise<PushSubscription[]>;
  addPushSubscription(sub: PushSubscription): Promise<void>;
  removePushSubscription(endpoint: string): Promise<void>;
  
  // Migrations
  migrate(): Promise<void>;
  close(): Promise<void>;
}
```

## Configuration

Database type is configured via environment or config file:

```typescript
interface DatabaseConfig {
  type: "sqlite" | "postgres";
  
  // SQLite
  path?: string;              // Default: ~/.octopai/octopai.db
  
  // PostgreSQL
  connectionString?: string;  // postgres://user:pass@host:5432/db
  pool?: {
    min: number;
    max: number;
  };
}
```

### Environment Variables

```bash
# SQLite (default)
OCTOPAI_DB_TYPE=sqlite
OCTOPAI_DB_PATH=~/.octopai/octopai.db

# PostgreSQL
OCTOPAI_DB_TYPE=postgres
OCTOPAI_DB_URL=postgres://octopai:password@localhost:5432/octopai
```

## Schema

### Arms Table

```sql
CREATE TABLE arms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent TEXT NOT NULL,
  -- Legacy: domain captured static specialization. Newer designs should
  -- lean on task classifications and activity history instead.
  domain TEXT,
  expertise TEXT,           -- JSON array
  status TEXT NOT NULL DEFAULT 'idle',
  reputation INTEGER NOT NULL DEFAULT 50,
  context_budget TEXT,      -- JSON
  current_context TEXT,     -- JSON
  current_task_id TEXT,
  pid INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Proposals Table

```sql
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES arms(id),
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);

CREATE TABLE proposal_arguments (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  author_id TEXT NOT NULL REFERENCES arms(id),
  position TEXT NOT NULL,   -- for, against, concern, suggestion
  content TEXT NOT NULL,
  evidence TEXT,            -- JSON array
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE proposal_signals (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  author_id TEXT NOT NULL REFERENCES arms(id),
  weight INTEGER NOT NULL,  -- -100 to +100
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(proposal_id, author_id)
);
```

### Claims Table

```sql
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  arm_id TEXT NOT NULL REFERENCES arms(id),
  path TEXT NOT NULL,
  pattern TEXT,
  exclusive BOOLEAN NOT NULL DEFAULT true,
  claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);

CREATE INDEX idx_claims_path ON claims(path);
CREATE INDEX idx_claims_arm ON claims(arm_id);
```

### Activity Table

```sql
CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  arm_id TEXT REFERENCES arms(id),
  type TEXT NOT NULL,
  path TEXT,
  details TEXT,             -- JSON
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_activity_arm ON activity(arm_id);
CREATE INDEX idx_activity_type ON activity(type);
CREATE INDEX idx_activity_created ON activity(created_at);
```

### Reputation Table

```sql
CREATE TABLE reputation_events (
  id TEXT PRIMARY KEY,
  arm_id TEXT NOT NULL REFERENCES arms(id),
  type TEXT NOT NULL,
  delta INTEGER NOT NULL,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reputation_arm ON reputation_events(arm_id);
```

### Config Table

```sql
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Push Subscriptions Table

```sql
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT UNIQUE NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Implementations

### SQLite Implementation

```typescript
import Database from 'bun:sqlite';

class SQLiteDatabase implements Database {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  async migrate(): Promise<void> {
    // Run migration SQL
    const migrations = await loadMigrations();
    for (const migration of migrations) {
      this.db.exec(migration.sql);
    }
  }

  async getArms(): Promise<Arm[]> {
    const rows = this.db.query("SELECT * FROM arms").all();
    return rows.map(parseArmRow);
  }

  // ... other methods
}
```

### PostgreSQL Implementation

```typescript
import { Pool } from 'pg';

class PostgresDatabase implements Database {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const migrations = await loadMigrations();
      for (const migration of migrations) {
        await client.query(migration.sql);
      }
    } finally {
      client.release();
    }
  }

  async getArms(): Promise<Arm[]> {
    const { rows } = await this.pool.query("SELECT * FROM arms");
    return rows.map(parseArmRow);
  }

  // ... other methods
}
```

### Factory

```typescript
function createDatabase(config: DatabaseConfig): Database {
  switch (config.type) {
    case "sqlite":
      return new SQLiteDatabase(config.path || "~/.octopai/octopai.db");
    case "postgres":
      return new PostgresDatabase(config.connectionString!);
    default:
      throw new Error(`Unknown database type: ${config.type}`);
  }
}
```

## Migrations

Migrations are stored as numbered SQL files:

```
src/db/migrations/
├── 001_initial.sql
├── 002_add_proposals.sql
├── 003_add_activity.sql
└── ...
```

### Migration Tracking

```sql
CREATE TABLE migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Running Migrations

```typescript
async function runMigrations(db: Database): Promise<void> {
  const applied = await db.getAppliedMigrations();
  const pending = migrations.filter(m => !applied.includes(m.id));
  
  for (const migration of pending) {
    console.log(`Applying migration: ${migration.name}`);
    await db.exec(migration.sql);
    await db.markMigrationApplied(migration.id, migration.name);
  }
}
```

## Backup & Recovery

### SQLite

```bash
# Backup
cp ~/.octopai/octopai.db ~/.octopai/octopai.db.backup

# Or use SQLite's backup command
sqlite3 ~/.octopai/octopai.db ".backup ~/.octopai/backup.db"
```

### PostgreSQL

```bash
# Backup
pg_dump octopai > octopai_backup.sql

# Restore
psql octopai < octopai_backup.sql
```

## Performance Considerations

### SQLite

- Good for single-server deployments
- WAL mode for better concurrent read performance
- Consider periodic VACUUM for large activity logs

### PostgreSQL

- Better for multi-server or high-concurrency deployments
- Connection pooling essential
- Consider partitioning activity table by date
- Add appropriate indexes based on query patterns

## Hybrid: File + Database

Some data remains in files for compatibility:

| Data | Storage | Reason |
|------|---------|--------|
| Mail (Maildir) | Files | Himalaya/luk compatibility |
| MCP configs | JSON files | Agent config files |
| Arm state | Database | Queryable, transactional |
| Activity | Database | Queryable, aggregatable |
| Garden topology | Computed | Derived from filesystem |
