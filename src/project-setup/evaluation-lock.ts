import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** API and Brain processes sharing a Coleo directory must not rewrite a plan concurrently. */
export async function acquirePlanEvaluation(coleoDir: string): Promise<(() => void) | null> {
  const directory = join(coleoDir, 'run');
  await mkdir(directory, { recursive: true });
  const db = new Database(join(directory, 'plan-evaluation.sqlite'), { create: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS evaluation_lock (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, pid INTEGER NOT NULL)');
    const token = randomUUID();
    const acquired = db.transaction(() => {
      const owner = db.query('SELECT pid FROM evaluation_lock WHERE id = 1').get() as { pid: number } | null;
      if (owner) {
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (error) {
          // Permission errors do not mean the owner is dead.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
        }
      }
      db.query('INSERT OR REPLACE INTO evaluation_lock (id, token, pid) VALUES (1, ?, ?)').run(token, process.pid);
      return true;
    }).immediate();
    if (!acquired) {
      db.close();
      return null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        db.query('DELETE FROM evaluation_lock WHERE id = 1 AND token = ?').run(token);
      } finally {
        db.close();
      }
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
