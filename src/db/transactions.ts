/**
 * Database Transaction Utilities
 * 
 * Provides safe transaction wrapping for multi-step database operations.
 * Ensures atomicity, consistency, and proper error handling.
 */

import { Database } from "bun:sqlite";

/**
 * Result of a transaction operation
 */
export interface TransactionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Transaction options
 */
export interface TransactionOptions {
  /** How many times to retry the transaction if it fails due to locks */
  maxRetries?: number;
  /** Delay between retries in milliseconds */
  retryDelayMs?: number;
  /** Whether to log transaction details for debugging */
  debug?: boolean;
}

/**
 * Execute a function within a database transaction
 * Automatically handles rollback on error and provides retry logic
 */
export async function withTransaction<T>(
  db: Database,
  operation: (db: Database) => T | Promise<T>,
  options: TransactionOptions = {}
): Promise<TransactionResult<T>> {
  const { maxRetries = 3, retryDelayMs = 100, debug = false } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (debug) {
        console.log(`[Transaction] Starting attempt ${attempt + 1}/${maxRetries + 1}`);
      }

      // Start the transaction
      const transactionFn = db.transaction(() => {
        return operation(db);
      });

      const data = await transactionFn();

      if (debug) {
        console.log(`[Transaction] Success on attempt ${attempt + 1}`);
      }

      return {
        success: true,
        data,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      if (debug) {
        console.log(`[Transaction] Failed attempt ${attempt + 1}: ${errorMessage}`);
      }

      // Check if this is a retry-able error (database locks, etc.)
      const isRetryable = errorMessage.includes('BUSY') || 
                         errorMessage.includes('LOCKED') ||
                         errorMessage.includes('database is locked');

      if (isRetryable && attempt < maxRetries) {
        if (debug) {
          console.log(`[Transaction] Retrying in ${retryDelayMs}ms...`);
        }
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }

      // Final failure or non-retryable error
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  return {
    success: false,
    error: `Transaction failed after ${maxRetries + 1} attempts`,
  };
}

/**
 * Execute multiple operations in a single transaction
 * Each operation receives the database instance
 */
export async function withMultiOperation<T>(
  db: Database,
  operations: Array<(db: Database) => void | Promise<void>>,
  finalResult?: () => T,
  options: TransactionOptions = {}
): Promise<TransactionResult<T | void>> {
  return withTransaction(
    db,
    async (db) => {
      for (const operation of operations) {
        await operation(db);
      }
      return finalResult ? finalResult() : undefined;
    },
    options
  );
}

/**
 * Create a task with dependencies in a single transaction
 */
export async function createTaskWithDependencies(
  db: Database,
  taskData: {
    id: string;
    subject: string;
    description: string;
    status: string;
    priority: string;
    source_type?: string;
    source_ref?: string;
    phase?: string;
    domain?: string;
    assigned_to?: string;
    metadata?: string;
  },
  dependencies: Array<{
    depends_on_task_id: string;
    dependency_type?: string;
    reason?: string;
  }> = []
): Promise<TransactionResult<void>> {
  return withTransaction(db, (db) => {
    const now = new Date().toISOString();

    // Insert the task
    db.run(`
      INSERT INTO tasks (
        id, subject, description, status, priority, source_type, source_ref, 
        phase, domain, assigned_to, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      taskData.id,
      taskData.subject,
      taskData.description,
      taskData.status,
      taskData.priority,
      taskData.source_type || 'manual',
      taskData.source_ref || null,
      taskData.phase || null,
      taskData.domain || null,
      taskData.assigned_to || null,
      taskData.metadata || '{}',
      now,
      now,
    ]);

    // Insert dependencies
    for (const dep of dependencies) {
      db.run(`
        INSERT INTO task_dependencies (
          task_id, depends_on_task_id, dependency_type, auto_detected, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        taskData.id,
        dep.depends_on_task_id,
        dep.dependency_type || 'finish_to_start',
        0, // explicitly specified
        dep.reason || null,
        now,
      ]);
    }
  });
}

/**
 * Update arm status and log activity atomically
 */
export async function updateArmStatusWithActivity(
  db: Database,
  armId: string,
  status: string,
  activityDetails: {
    action: string;
    target?: string;
    details?: Record<string, unknown>;
  }
): Promise<TransactionResult<void>> {
  return withTransaction(db, (db) => {
    const now = new Date().toISOString();

    // Update arm status
    db.run(`
      UPDATE arms 
      SET status = ?, updated_at = ?, last_activity_at = ?
      WHERE id = ?
    `, [status, now, now, armId]);

    // Log activity
    db.run(`
      INSERT INTO activity (timestamp, actor, action, target, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      now,
      armId,
      activityDetails.action,
      activityDetails.target || null,
      JSON.stringify(activityDetails.details || {}),
    ]);
  });
}

/**
 * Update task assignment with consensus tracking atomically
 */
export async function assignTaskToArm(
  db: Database,
  taskId: string,
  armId: string,
  role: 'primary' | 'watcher' = 'primary',
  isClaim: boolean = false
): Promise<TransactionResult<{ needsMoreArms?: boolean }>> {
  return withTransaction(db, async (db) => {
    const now = new Date().toISOString();

    // Update task assignment
    const updateFields = ['assigned_to = ?'];
    const updateValues = [armId];

    if (isClaim) {
      updateFields.push('status = ?', 'claimed_at = ?');
      updateValues.push('claimed', now);
    }

    updateFields.push('updated_at = ?');
    updateValues.push(now);
    updateValues.push(taskId);

    db.run(`
      UPDATE tasks
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `, updateValues);

    // Add or update consensus entry
    db.run(`
      INSERT OR REPLACE INTO task_arm_consensus (
        task_id, arm_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?)
    `, [taskId, armId, role, now, now]);

    // Log the assignment
    db.run(`
      INSERT INTO activity (timestamp, actor, action, target, details)
      VALUES (?, 'brain', 'task_assigned', ?, ?)
    `, [now, taskId, JSON.stringify({ armId, role })]);

    // Auto-assign watcher arms if this is a primary assignment
    let needsMoreArms = false;
    if (role === 'primary') {
      const taskRow = db.query("SELECT domain FROM tasks WHERE id = ?").get(taskId) as { domain: string | null };
      const watchersResult = await autoAssignWatcherArms(db, taskId, armId, taskRow?.domain || undefined);
      if (watchersResult.success && watchersResult.data) {
        // Log watcher assignments
        db.run(`
          INSERT INTO activity (timestamp, actor, action, target, details)
          VALUES (?, 'brain', 'auto_assigned_watchers', ?, ?)
        `, [now, taskId, JSON.stringify({ watchers: watchersResult.data.watchersAssigned })]);
        needsMoreArms = watchersResult.data.needsMoreArms;
      }
    }

    return { needsMoreArms };
  });
}

/**
 * Auto-assign watcher arms when a task is claimed
 * Selects appropriate arms based on domain and availability
 */
export async function autoAssignWatcherArms(
  db: Database,
  taskId: string,
  primaryArmId: string,
  taskDomain?: string
): Promise<TransactionResult<{ watchersAssigned: string[]; needsMoreArms: boolean }>> {
  return withTransaction(db, (db) => {
    const now = new Date().toISOString();

    // Get max arms per task from config
    const configRow = db.query("SELECT value FROM config WHERE key = 'max_arms_per_task'").get() as { value: string } | null;
    const maxArms = parseInt(configRow?.value || "3", 10);

    // Get current consensus entries for this task
    const currentEntries = db.query("SELECT COUNT(*) as count FROM task_arm_consensus WHERE task_id = ?").get(taskId) as { count: number };
    const currentCount = currentEntries.count;

    // Calculate how many more arms we can assign (max - current)
    const armsToAssign = Math.max(0, maxArms - currentCount);
    if (armsToAssign === 0) {
      return { watchersAssigned: [], needsMoreArms: false };
    }

    // Find available arms (not already assigned to this task, not the primary arm)
    let availableArms = db.query(`
      SELECT id, name, domain, status
      FROM arms
      WHERE id != ?
        AND status IN ('idle', 'running')
        AND id NOT IN (SELECT arm_id FROM task_arm_consensus WHERE task_id = ?)
    `).all(primaryArmId, taskId) as Array<{ id: string; name: string; domain: string; status: string }>;

    // Prioritize arms by domain match, then general arms
    const prioritizedArms = availableArms.sort((a, b) => {
      const aDomain = a.domain || 'general';
      const bDomain = b.domain || 'general';
      const taskDomainNormalized = taskDomain || 'general';

      // Exact domain match gets highest priority
      if (aDomain === taskDomainNormalized && bDomain !== taskDomainNormalized) return -1;
      if (bDomain === taskDomainNormalized && aDomain !== taskDomainNormalized) return 1;

      // General arms get medium priority
      if (aDomain === 'general' && bDomain !== 'general') return -1;
      if (bDomain === 'general' && aDomain !== 'general') return 1;

      // Otherwise maintain order
      return 0;
    });

    // Assign up to armsToAssign watchers
    const watchersAssigned: string[] = [];
    for (let i = 0; i < Math.min(armsToAssign, prioritizedArms.length); i++) {
      const watcherArm = prioritizedArms[i];
      if (watcherArm) {
        db.run(`
          INSERT OR REPLACE INTO task_arm_consensus (
            task_id, arm_id, role, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'watching', ?, ?)
        `, [taskId, watcherArm.id, 'watcher', now, now]);

        watchersAssigned.push(watcherArm.id);
      }
    }

    // Check if we need more arms than we could assign
    const needsMoreArms = watchersAssigned.length < armsToAssign;

    return { watchersAssigned, needsMoreArms };
  });
}

/**
 * Update infrastructure health components atomically
 */
export async function updateInfrastructureHealth(
  db: Database,
  components: Array<{
    component: string;
    healthy: boolean;
    optional?: boolean;
    error?: string;
  }>
): Promise<TransactionResult<void>> {
  return withTransaction(db, (db) => {
    const now = new Date().toISOString();

    for (const comp of components) {
      db.run(`
        INSERT OR REPLACE INTO infrastructure_health 
        (component, healthy, optional, error, last_check, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        comp.component,
        comp.healthy ? 1 : 0,
        comp.optional ? 1 : 0,
        comp.error || null,
        now,
        now,
      ]);
    }
  });
}

/**
 * Record context compression and update arm budget usage atomically
 */
export async function recordContextCompressionWithBudgetUpdate(
  db: Database,
  compressionData: {
    armId: string;
    taskId: string;
    originalTokens: number;
    compressedTokens: number;
    compressionRatio: number;
    removedContent: any[];
    workInProgress?: string;
    estimatedCost: number;
  }
): Promise<TransactionResult<{ compressionId: number }>> {
  return withTransaction(db, async (tx) => {
    const now = new Date().toISOString();
    
    // 1. Record the context compression
    const compressionResult = tx.run(
      `INSERT INTO context_compressions
       (arm_id, task_id, original_tokens, compressed_tokens, compression_ratio,
        removed_content, work_in_progress, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        compressionData.armId,
        compressionData.taskId,
        compressionData.originalTokens,
        compressionData.compressedTokens,
        compressionData.compressionRatio,
        JSON.stringify(compressionData.removedContent),
        compressionData.workInProgress || null,
        now,
      ]
    );

    // 2. Update the arm's context budget usage
    tx.run(
      `UPDATE arms SET context_budget_used = context_budget_used + ? WHERE id = ?`,
      [compressionData.estimatedCost, compressionData.armId]
    );

    return {
      compressionId: Number(compressionResult.lastInsertRowid)
    };
  });
}