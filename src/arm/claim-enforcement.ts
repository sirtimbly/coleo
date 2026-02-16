/**
 * File Claim Enforcement System
 * 
 * Implements the three claim modes:
 * - strict: Must claim files before writing
 * - lazy: Claims optional, detect conflicts after the fact
 * - disabled: No claim enforcement, parallel writes allowed
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { getColeoDir } from "../config";
import { eventStore } from "../nats/jetstream";

export type ClaimMode = "strict" | "lazy" | "disabled";

export interface ClaimEnforcementConfig {
  mode: ClaimMode;
  autoClaimOnWrite: boolean;
  blockOnConflict: boolean;
  enableThrashingDetection: boolean;
}

/**
 * Get the current claim mode from the database
 */
export function getClaimMode(db: Database): ClaimMode {
  try {
    const result = db.query("SELECT value FROM config WHERE key = 'context_claim_mode'").get() as { value: string } | null;
    const mode = result?.value || "lazy";
    
    if (mode === "strict" || mode === "lazy" || mode === "disabled") {
      return mode;
    }
    
    return "lazy"; // Default fallback
  } catch {
    return "lazy";
  }
}

/**
 * Get claim enforcement configuration
 */
export function getClaimEnforcementConfig(db: Database): ClaimEnforcementConfig {
  const mode = getClaimMode(db);
  
  return {
    mode,
    autoClaimOnWrite: mode === "lazy",
    blockOnConflict: mode === "strict",
    enableThrashingDetection: mode === "lazy" || mode === "strict",
  };
}

/**
 * Check if an arm can write to a file based on current claim mode
 */
export function canWriteToFile(
  db: Database,
  armId: string,
  filePath: string
): { canWrite: boolean; reason?: string; shouldClaim?: boolean } {
  const config = getClaimEnforcementConfig(db);
  
  if (config.mode === "disabled") {
    return { canWrite: true };
  }
  
  try {
    // Check if this arm has a write or exclusive claim
    const ownClaim = db.query(`
      SELECT claim_type FROM claims 
      WHERE arm_id = ? AND file_path = ? AND released_at IS NULL
      AND claim_type IN ('write', 'exclusive')
    `).get(armId, filePath) as { claim_type: string } | null;
    
    if (ownClaim) {
      return { canWrite: true };
    }
    
    // Check if any other arm has an exclusive claim
    const exclusiveClaim = db.query(`
      SELECT arm_id FROM claims 
      WHERE file_path = ? AND released_at IS NULL 
      AND claim_type = 'exclusive'
    `).get(filePath) as { arm_id: string } | null;
    
    if (exclusiveClaim) {
      return {
        canWrite: false,
        reason: `File ${filePath} has exclusive claim by ${exclusiveClaim.arm_id}`,
      };
    }
    
    // Check if other arms have write claims
    const otherWriteClaims = db.query(`
      SELECT arm_id FROM claims 
      WHERE file_path = ? AND arm_id != ? AND released_at IS NULL 
      AND claim_type IN ('write', 'exclusive')
    `).all(filePath, armId) as Array<{ arm_id: string }>;
    
    if (otherWriteClaims.length > 0) {
      return {
        canWrite: false,
        reason: `File ${filePath} has active write claims: ${otherWriteClaims.map(c => c.arm_id).join(", ")}`,
      };
    }
    
    // No conflicts - allow write
    if (config.mode === "strict") {
      return {
        canWrite: false,
        reason: `Strict mode requires claiming ${filePath} before writing`,
        shouldClaim: true,
      };
    }
    
    return { canWrite: true, shouldClaim: true };
  } catch (err) {
    console.error("Error checking write permissions:", err);
    return { canWrite: true }; // Fail open to avoid blocking work
  }
}

/**
 * Auto-claim a file for an arm in lazy mode
 */
export function autoClaimFile(
  db: Database,
  armId: string,
  filePath: string,
  claimType: "read" | "write" = "write"
): boolean {
  try {
    const config = getClaimEnforcementConfig(db);
    if (!config.autoClaimOnWrite) {
      return false;
    }
    
    // Check if we already have a claim
    const existingClaim = db.query(`
      SELECT id FROM claims 
      WHERE arm_id = ? AND file_path = ? AND released_at IS NULL
    `).get(armId, filePath);
    
    if (existingClaim) {
      return true; // Already claimed
    }
    
    // Create new claim
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
      [armId, filePath, claimType, now]
    );
    
    // Log the activity to JetStream
    if (eventStore.isInitialized()) {
      eventStore.publishEvent(`coleo.events.arm.${armId}.auto_claim_file`, {
        type: "auto_claim_file",
        armId,
        data: { filePath, claim_type: claimType },
        timestamp: now,
      }).catch(() => {});
    }
    
    return true;
  } catch (err) {
    console.error("Error auto-claiming file:", err);
    return false;
  }
}

/**
 * Detect file thrashing (multiple arms overwriting same file)
 */
export async function detectThrashing(
  _db: Database,
  filePath: string,
  windowMinutes: number = 30
): Promise<{ isTrash: boolean; arms: string[]; overwriteCount: number }> {
  try {
    if (!eventStore.isInitialized()) {
      return { isTrash: false, arms: [], overwriteCount: 0 };
    }
    
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
    
    // Query JetStream for file write activities
    const events = await eventStore.queryEvents({
      limit: 100,
      since: windowStart,
    });
    
    // Filter for file write/edit/modify activities on this file
    const activities = events
      .filter(e => {
        const action = e.type || "";
        const target = e.data?.filePath || e.data?.file_path || e.data?.target || "";
        const isWriteAction = action.includes("write") || action.includes("edit") || action.includes("modify");
        return isWriteAction && target === filePath;
      })
      .map(e => ({
        actor: e.armId || "unknown",
        timestamp: e.timestamp,
      }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    if (activities.length < 2) {
      return { isTrash: false, arms: [], overwriteCount: 0 };
    }
    
    // Count unique arms and potential overwrites
    const armSet = new Set(activities.map(a => a.actor));
    const arms = Array.from(armSet);
    
    // Look for pattern: Arm A writes, then Arm B writes (potential overwrite)
    let overwriteCount = 0;
    for (let i = 1; i < activities.length; i++) {
      const prev = activities[i - 1];
      const curr = activities[i];
      
      if (prev && curr && prev.actor !== curr.actor) {
        overwriteCount++;
      }
    }
    
    // Consider it thrashing if multiple arms and multiple overwrites
    const isTrash = arms.length >= 2 && overwriteCount >= 2;
    
    return { isTrash, arms, overwriteCount };
  } catch (err) {
    console.error("Error detecting thrashing:", err);
    return { isTrash: false, arms: [], overwriteCount: 0 };
  }
}

/**
 * Escalate claim mode to strict for a specific file due to thrashing
 */
export function escalateClaimModeForFile(
  db: Database,
  filePath: string,
  reason: string
): void {
  try {
    const now = new Date().toISOString();
    
    // Log the escalation to JetStream
    if (eventStore.isInitialized()) {
      eventStore.publishEvent(`coleo.events.system.claim_mode_escalated`, {
        type: "claim_mode_escalated",
        data: { filePath, reason, mode: "strict" },
        timestamp: now,
      }).catch(() => {});
    }
    
    // For now, we could store per-file claim modes in a separate table
    // But for this implementation, we'll just log it and rely on global mode
    console.log(`File ${filePath} escalated to strict claim mode: ${reason}`);
  } catch (err) {
    console.error("Error escalating claim mode:", err);
  }
}

/**
 * Get database connection
 */
export function getDatabase(readonly = true): Database {
  const dbPath = join(getColeoDir(), "coleo.db");
  return new Database(dbPath, { readonly });
}

/**
 * Monitor file for thrashing and auto-escalate if needed
 */
export async function checkAndEscalateIfThrashing(
  db: Database,
  filePath: string
): Promise<void> {
  const config = getClaimEnforcementConfig(db);
  if (!config.enableThrashingDetection) {
    return;
  }
  
  const thrashResult = await detectThrashing(db, filePath);
  if (thrashResult.isTrash) {
    escalateClaimModeForFile(
      db,
      filePath,
      `Thrashing detected: ${thrashResult.arms.length} arms, ${thrashResult.overwriteCount} overwrites`
    );
  }
}
