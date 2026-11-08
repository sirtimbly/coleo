import { getGlobalHarnessManager } from "../harness";
import { getArmClient } from "./arm-client-registry";
import { releaseClaimsForArm } from "./claim-cleanup";
import { HttpError } from "./middleware/error";
import { broadcast } from "./websocket";
import type { Database } from "bun:sqlite";

export interface StopArmResult {
  id: string;
  killed: true;
  distributed: boolean;
  releasedClaims: number;
}

/** Keep the profile; release claims only once its runtime has acknowledged stop. */
export async function stopArm(db: Database, id: string): Promise<StopArmResult> {
  const row = db.query("SELECT id, status, agent_id, pid, session_id FROM arms WHERE id = ?").get(id) as {
    id: string; status: string; agent_id: string | null; pid: number | null; session_id: string | null;
  } | null;
  if (!row) throw HttpError.notFound(`Arm not found: ${id}`);
  if (row.agent_id) {
    const client = getArmClient();
    if (!client) throw new HttpError(503, "Arm Host connection is unavailable; stop could not be confirmed");
    try {
      const response = await client.killArm(id, 30_000, row.agent_id);
      if (!response.success) throw new Error(response.error || "Arm Host rejected stop");
    } catch (error) {
      // Never pretend a remote runtime stopped or fall through to a local manager.
      throw new HttpError(502, `Could not stop arm ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const manager = getGlobalHarnessManager();
    if (manager?.getSession(id)) await manager.kill(id);
    else if (row.pid || row.session_id) {
      throw new HttpError(409, `Arm ${id} has an untracked runtime. Recover it before stopping so shutdown can be confirmed.`);
    }
  }
  const now = new Date().toISOString();
  const releasedClaims = db.transaction(() => {
    db.run("UPDATE arms SET status = 'stopped', planning_blocked = 0, pid = NULL, port = NULL, session_id = NULL, agent_id = NULL, host = NULL, updated_at = ? WHERE id = ?", [now, id]);
    return releaseClaimsForArm(db, id, now);
  })();
  broadcast("arms", "arm.killed", { id, status: "stopped", distributed: Boolean(row.agent_id) });
  if (releasedClaims) broadcast("activity", "claims.released", { armId: id, releasedClaims });
  return { id, killed: true, distributed: Boolean(row.agent_id), releasedClaims };
}
