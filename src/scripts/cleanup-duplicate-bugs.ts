import { loadApiConfig } from "../api/config";
import { findSimilarActiveBug } from "../api/routes/bugs";
import { initDatabase } from "../db";

interface CleanupCandidate {
  id: string;
  title: string;
  sourceTaskId?: string;
  createdAt: string;
}

interface CleanupDecision {
  duplicateId: string;
  duplicateTitle: string;
  keepId: string;
  keepTitle: string;
}

function parseArgs(args: string[]): { apply: boolean; json: boolean } {
  return {
    apply: args.includes("--apply"),
    json: args.includes("--json"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const config = loadApiConfig();
  const db = await initDatabase(config.dbPath);

  try {
    const rows = db.query(`
      SELECT
        id,
        title,
        source_task_id as sourceTaskId,
        created_at as createdAt
      FROM bugs
      WHERE archived = 0
        AND status IN ('open', 'investigating', 'fixing', 'verifying')
      ORDER BY created_at ASC, id ASC
    `).all() as CleanupCandidate[];

    const decisions: CleanupDecision[] = [];

    for (const row of rows) {
      const match = findSimilarActiveBug(db, {
        title: row.title,
        sourceTaskId: row.sourceTaskId,
        excludeBugId: row.id,
        createdBefore: row.createdAt,
      });

      if (!match) {
        continue;
      }

      decisions.push({
        duplicateId: row.id,
        duplicateTitle: row.title,
        keepId: match.id,
        keepTitle: match.title,
      });
    }

    if (args.apply && decisions.length > 0) {
      db.exec("BEGIN");
      try {
        const deleteStmt = db.prepare("DELETE FROM bugs WHERE id = ?");
        for (const decision of decisions) {
          deleteStmt.run(decision.duplicateId);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }

    const summary = {
      dbPath: config.dbPath,
      applied: args.apply,
      duplicateCount: decisions.length,
      decisions,
    };

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log(`DB: ${summary.dbPath}`);
    console.log(`Mode: ${summary.applied ? "apply" : "dry-run"}`);
    console.log(`Duplicate bugs: ${summary.duplicateCount}`);
    for (const decision of decisions.slice(0, 50)) {
      console.log(
        `delete ${decision.duplicateId} -> keep ${decision.keepId} | ${decision.duplicateTitle}`,
      );
    }
    if (decisions.length > 50) {
      console.log(`... ${decisions.length - 50} more`);
    }
  } finally {
    db.close();
  }
}

await main();
